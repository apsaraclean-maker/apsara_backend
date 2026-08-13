import { Router } from 'express';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { DateTime } from 'luxon';
import { Business, User, Payment, AdminUser, Branch } from '../models.js';
import { generateAdminToken, adminAuthMiddleware, type AuthRequest } from '../middleware/auth.js';
import { invalidateUserSessions } from '../utils/sessionControl.js';
import { invalidateBusinessContext } from '../utils/authCache.js';
import { encryptPin, generatePin } from '../utils/pinCrypto.js';
import { generateBranchCode } from './branches.js';
import { generateEmployeeId } from './staff.js';
import { getBillingState, countBillableOrdersByCycle } from '../utils/billing.js';
import { getCurrentCycle, getCycleByIndex, getCycleIndexAt, type BillingCycle } from '../utils/billingCycle.js';

const router = Router();

// Cycle arithmetic moved to utils/billingCycle.ts when the owner-facing Billing page needed
// the same windows this portal has always used. The version that lived here computed the
// start with `today.set({ day: regDay })`, which Luxon resolves to an *invalid* DateTime for a
// business registered on the 31st during a 30-day month — that bug is fixed in the shared
// helper, which clamps to the month's last day instead.
function getCurrentBillingCycle(registrationDate: Date | string): { cycleStart: string; cycleEnd: string } {
  return getCurrentCycle(registrationDate);
}

// Plan fields are read and written in several places below; kept in one shape so the list,
// detail and update routes cannot drift apart.
function planPayload(biz: {
  plan_name?: string | null;
  monthly_fixed_cost?: number | null;
  monthly_order_limit?: number | null;
  per_order_overage_cost?: number | null;
}) {
  return {
    plan_name: biz.plan_name || 'Standard',
    monthly_fixed_cost: Number(biz.monthly_fixed_cost) || 0,
    monthly_order_limit: Number(biz.monthly_order_limit) || 0,
    per_order_overage_cost: Number(biz.per_order_overage_cost) || 0,
  };
}

// POST /api/admin/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'Username and password required' });
  try {
    const admin = await AdminUser.findOne({ username: username.toLowerCase() });
    if (!admin) return res.status(401).json({ message: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) return res.status(401).json({ message: 'Invalid credentials' });

    const token = generateAdminToken({ id: admin._id, username: admin.username, name: admin.name });
    res.json({ token, admin: { id: admin._id, name: admin.name, username: admin.username } });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/admin/businesses
router.get('/businesses', adminAuthMiddleware, async (_req, res) => {
  try {
    const businesses = await Business.find().sort({ createdAt: -1 }).lean();

    // Two queries for the whole list rather than two per business. This ran as a findById for
    // the owner plus a findOne for the current cycle's payment inside businesses.map(async …),
    // so a platform with 50 businesses issued 100 round trips to render one admin table.
    //
    // The cycle start differs per business (it's derived from each one's own registration
    // date), so the payment lookup can't be a single equality — it's an $or over the
    // (business_id, cycle_start_date) pairs, which the existing compound index on Payment
    // serves directly.
    const cycleByBusiness = new Map<string, string>();
    for (const biz of businesses) {
      if (biz.status === 'active') {
        cycleByBusiness.set(String(biz._id), getCurrentBillingCycle(biz.createdAt).cycleStart);
      }
    }

    const [owners, payments] = await Promise.all([
      User.find({ _id: { $in: businesses.map((b) => b.owner_id) } })
        .select('name phone is_active failed_login_count')
        .lean(),
      cycleByBusiness.size
        ? Payment.find({
            $or: [...cycleByBusiness].map(([businessId, cycleStart]) => ({
              business_id: new mongoose.Types.ObjectId(businessId),
              cycle_start_date: cycleStart,
            })),
          })
            .select('business_id cycle_start_date')
            .lean()
        : Promise.resolve([] as any[]),
    ]);

    const ownerById = new Map(owners.map((o) => [String(o._id), o]));
    const paidBusinessIds = new Set(payments.map((p) => String(p.business_id)));

    const result = businesses.map((biz) => {
      const owner = ownerById.get(String(biz.owner_id));
      const paymentLabel =
        biz.status !== 'active' ? 'N/A' : paidBusinessIds.has(String(biz._id)) ? 'Paid' : 'Delayed';

      return {
        _id: biz._id,
        name: biz.name,
        phone: biz.phone,
        address: biz.address,
        pincode: biz.pincode,
        state: biz.state,
        status: biz.status,
        gst_number: biz.gst_number || '',
        country: biz.country || '',
        ...planPayload(biz),
        createdAt: biz.createdAt,
        owner_name: owner?.name || '',
        owner_phone: owner?.phone || '',
        // Surfaced so support can see and clear an owner auto-disabled by the failed-login
        // escalation in auth.ts — an owner has nobody above them to flip the toggle, so
        // this panel is the only way back in.
        owner_id: owner?._id || null,
        owner_is_active: owner?.is_active ?? true,
        payment_label: paymentLabel,
      };
    });

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/admin/businesses — onboard a business from the portal.
//
// Billing Page PRD, "Data Requirements": the Apsara team creates the business, its owner login
// and its plan in one step, rather than the owner self-registering. Mirrors the shape of
// /api/auth/register-business (owner user + business + a Main Branch, since nothing in the app
// works without at least one branch) and adds the plan fields that only this portal can set.
router.post('/businesses', adminAuthMiddleware, async (req, res) => {
  const {
    name, owner_name, phone, password, gst_number,
    address, pincode, state, country,
    plan_name, monthly_fixed_cost, monthly_order_limit, per_order_overage_cost,
  } = req.body;

  const missing = ['name', 'owner_name', 'phone', 'password', 'address', 'pincode', 'state', 'country']
    .filter((k) => !String(req.body[k] ?? '').trim());
  if (missing.length) {
    return res.status(400).json({ message: `Missing required field(s): ${missing.join(', ')}` });
  }

  // A zero monthly cost is the PRD's pay-per-order arrangement, so these are checked for
  // being present and non-negative rather than for being truthy — `!monthly_fixed_cost`
  // would have rejected exactly the case the PRD calls out.
  const numbers = { monthly_fixed_cost, monthly_order_limit, per_order_overage_cost };
  for (const [key, value] of Object.entries(numbers)) {
    const n = Number(value);
    if (value === undefined || value === null || value === '' || !Number.isFinite(n) || n < 0) {
      return res.status(400).json({ message: `${key} must be a number of 0 or more` });
    }
  }

  try {
    const existing = await User.findOne({ phone, deleted_at: null });
    if (existing) return res.status(400).json({ message: 'That phone number already has an account' });

    const owner = await User.create({
      name: owner_name,
      phone,
      password_hash: await bcrypt.hash(password, 10),
      // Display-only, exactly as in self-registration: owners authenticate by password, so
      // this PIN opens no login path — it exists because the Business Page shows every
      // persona theirs.
      pin_encrypted: encryptPin(generatePin()),
      role: 'owner',
      is_active: true,
    });

    const business = await Business.create({
      name,
      owner_id: owner._id,
      phone,
      gst_number: gst_number || '',
      address,
      pincode,
      state,
      country: country || 'India',
      status: 'active',
      plan_name: plan_name || 'Standard',
      monthly_fixed_cost: Number(monthly_fixed_cost),
      monthly_order_limit: Number(monthly_order_limit),
      per_order_overage_cost: Number(per_order_overage_cost),
    });

    owner.business_id = business._id as any;
    // Assigned only now that business_id is set — the unique (business_id, employee_id) index
    // scopes IDs per business, and computing one against a null business puts every owner on
    // the platform on the same key.
    owner.employee_id = generateEmployeeId(owner_name, []);
    await owner.save();

    await Branch.create({
      business_id: business._id,
      name: 'Main Branch',
      branch_code: generateBranchCode(name, []),
      address_line_1: address,
      pincode,
      state,
    });

    res.status(201).json({ ...business.toObject(), owner_name: owner.name, owner_phone: owner.phone });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/admin/businesses/:id
router.put('/businesses/:id', adminAuthMiddleware, async (req, res) => {
  const {
    name, address, phone, pincode, state, country, gst_number, owner_name,
    plan_name, monthly_fixed_cost, monthly_order_limit, per_order_overage_cost,
  } = req.body;
  try {
    const business = await Business.findById(req.params.id);
    if (!business) return res.status(404).json({ message: 'Business not found' });

    if (name) business.name = name;
    if (address !== undefined) business.address = address;
    if (phone !== undefined) business.phone = phone;
    if (pincode !== undefined) business.pincode = pincode;
    if (state !== undefined) business.state = state;
    if (country !== undefined) business.country = country;
    if (gst_number !== undefined) business.gst_number = gst_number;

    if (plan_name !== undefined) business.plan_name = plan_name;
    // Same reasoning as on create: 0 is a real value here, so each is written whenever it
    // parses as a non-negative number and skipped only when it is absent or nonsense.
    for (const [field, value] of [
      ['monthly_fixed_cost', monthly_fixed_cost],
      ['monthly_order_limit', monthly_order_limit],
      ['per_order_overage_cost', per_order_overage_cost],
    ] as const) {
      if (value === undefined || value === null || value === '') continue;
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ message: `${field} must be a number of 0 or more` });
      }
      (business as any)[field] = n;
    }

    business.updatedAt = DateTime.now().toUTC().toJSDate();
    await business.save();

    if (owner_name) {
      await User.findByIdAndUpdate(business.owner_id, { name: owner_name, updatedAt: DateTime.now().toUTC().toJSDate() });
    }

    // Changing the plan changes what every unpaid cycle costs, and a cycle whose bill drops to
    // zero stops being a lock reason — so the cached lock verdict cannot be allowed to outlive
    // the edit.
    await invalidateBusinessContext(business._id);

    res.json(business);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/admin/businesses/:id/status
router.patch('/businesses/:id/status', adminAuthMiddleware, async (req, res) => {
  try {
    const business = await Business.findById(req.params.id);
    if (!business) return res.status(404).json({ message: 'Business not found' });

    business.status = business.status === 'active' ? 'inactive' : 'active';
    business.updatedAt = DateTime.now().toUTC().toJSDate();
    await business.save();

    // sessionVerification reads the pause flag through a short-lived cache, so pausing or
    // reactivating a business has to evict it — otherwise the change wouldn't reach that
    // business's users until the entry aged out.
    await invalidateBusinessContext(business._id);

    res.json({ message: `Business ${business.status}`, business });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/admin/users/:id/status — reactivate (or disable) an individual user account.
//
// Exists for one case the app otherwise cannot recover from: an owner who fails login 30
// times is disabled by the escalation in auth.ts, and unlike staff — whom their owner can
// re-enable from the Staff page — an owner has no one above them. Without this endpoint the
// only route back is editing the database by hand.
router.patch('/users/:id/status', adminAuthMiddleware, async (req, res) => {
  const { is_active } = req.body;
  if (typeof is_active !== 'boolean') {
    return res.status(400).json({ message: 'is_active must be true or false' });
  }
  try {
    const user = await User.findOne({ _id: req.params.id, deleted_at: null });
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Reactivating must clear the counters as well as the flag. The disabled account still
    // carries failed_login_count at 30, so leaving it would let the very next mistyped
    // password disable them again immediately.
    if (is_active) {
      user.failed_login_count = 0;
      user.locked_until = null;
    }
    user.is_active = is_active;
    user.updatedAt = DateTime.now().toUTC().toJSDate();
    await user.save();

    // Disabling has to end any session they still hold rather than wait for the cookie to
    // expire. (This admin app authenticates with its own bearer token and has no
    // express-session store attached, hence no store argument — bumping session_epoch is
    // what actually invalidates them; the store destroy is only cleanup.)
    if (!is_active) await invalidateUserSessions(user._id);

    res.json({
      message: is_active ? 'Account reactivated' : 'Account disabled',
      user: { id: user._id, name: user.name, phone: user.phone, role: user.role, is_active: user.is_active },
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/admin/businesses/:id/payments
router.get('/businesses/:id/payments', adminAuthMiddleware, async (req, res) => {
  try {
    const business = await Business.findById(req.params.id);
    if (!business) return res.status(404).json({ message: 'Business not found' });

    const payments = await Payment.find({ business_id: req.params.id })
      .populate('created_by', 'name username')
      .sort({ cycle_start_date: -1 })
      .lean();

    const { cycleStart, cycleEnd } = getCurrentBillingCycle(business.createdAt);
    const currentCycleHasPayment = payments.some(
      (p) => p.cycle_start_date === cycleStart && (p.status ?? 'paid') === 'paid'
    );

    // What the business actually owes right now, so whoever is recording a payment can see the
    // figure they should be collecting instead of working it out from the plan by hand.
    const state = await getBillingState(business as any);

    // Orders per settled cycle, for the same reason the owner-facing table shows them: an
    // amount is hard to sanity-check without the volume it was billed on.
    const anchored: BillingCycle[] = [];
    const indices = new Set<number>();
    for (const p of payments) {
      const index = getCycleIndexAt(business.createdAt, DateTime.fromISO(p.cycle_start_date, { zone: 'utc' }));
      const cycle = getCycleByIndex(business.createdAt, index);
      if (cycle.cycleStart === p.cycle_start_date) indices.add(index);
    }
    if (indices.size) {
      const lo = Math.min(...indices);
      const hi = Math.max(...indices);
      for (let i = lo; i <= hi; i++) anchored.push(getCycleByIndex(business.createdAt, i));
    }
    const orderCounts = await countBillableOrdersByCycle(business._id, anchored);

    res.json({
      payments: payments.map((p) => ({ ...p, status: p.status ?? 'paid', orders: orderCounts.get(p.cycle_start_date) ?? 0 })),
      current_cycle: { cycle_start: cycleStart, cycle_end: cycleEnd },
      payment_label: business.status === 'active' ? (currentCycleHasPayment ? 'Paid' : 'Delayed') : 'N/A',
      plan: planPayload(business),
      billing: {
        amount_due: state.amountDue,
        due_date: state.dueDate,
        current_cycle_bill: state.currentBill.monthlyBill,
        current_cycle_orders: state.currentBill.orders,
        locked: state.locked,
        grace_ends_on: state.graceEndsOn,
        outstanding: state.outstanding.map((c) => ({
          cycle_start: c.cycleStart,
          cycle_end: c.cycleEnd,
          orders: c.bill.orders,
          // Billed vs already-settled vs still-owed are shown separately, because the gap
          // between the first two is the whole point: it is the overage that accrued after
          // the fixed charge was recorded.
          billed: c.bill.monthlyBill,
          paid: c.paid,
          amount: c.amountDue,
          due_date: c.dueDate,
          overdue: c.overdue,
        })),
      },
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/admin/businesses/:id/payments
router.post('/businesses/:id/payments', adminAuthMiddleware, async (req: AuthRequest, res) => {
  const { amount, payment_date, payment_mode, reference_id, bank_name, notes, cycle_start_date, cycle_end_date, status } = req.body;
  // `amount` is checked for presence rather than truthiness: the PRD explicitly allows 0 —
  // "in case no monthly fixed cost for initial setup" — and `!amount` rejected exactly that.
  if (amount === undefined || amount === null || amount === '' || !payment_date || !payment_mode || !cycle_start_date || !cycle_end_date) {
    return res.status(400).json({ message: 'amount, payment_date, payment_mode, cycle_start_date, cycle_end_date required' });
  }
  if (!Number.isFinite(Number(amount)) || Number(amount) < 0) {
    return res.status(400).json({ message: 'amount must be a number of 0 or more' });
  }
  if (status && !['paid', 'failed', 'pending'].includes(status)) {
    return res.status(400).json({ message: 'status must be paid, failed or pending' });
  }
  try {
    // A cycle may legitimately take more than one payment, so this no longer rejects a second
    // one. A cycle's cost is not known when its first payment is taken — the fixed charge is
    // recorded up front and overage accrues afterwards — and settlement is now judged by the
    // total paid against the bill (utils/billing.ts), not by a row's existence. Refusing the
    // top-up left the shortfall permanently uncollectable.
    //
    // The duplicate-entry guard that block also provided is not lost: the cycle's existing
    // payments are listed directly above this form in the portal.
    const payment = await Payment.create({
      business_id: req.params.id,
      amount: Number(amount),
      payment_date,
      payment_mode,
      reference_id: reference_id || '',
      bank_name: bank_name || '',
      notes: notes || '',
      status: status || 'paid',
      cycle_start_date,
      cycle_end_date,
      created_by: req.user?.id,
    });

    // Recording the payment is what lifts the lockdown, and the lock verdict is cached on the
    // request path. Without this eviction a business would stay locked out for up to the
    // cache's 60-second TTL after the team had already marked them paid — which reads, to the
    // owner watching the page, as the payment not having worked.
    await invalidateBusinessContext(req.params.id);

    res.status(201).json(payment);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/admin/payments/:id
router.put('/payments/:id', adminAuthMiddleware, async (req, res) => {
  const { amount, payment_date, payment_mode, reference_id, bank_name, notes, cycle_start_date, cycle_end_date, status } = req.body;
  if (status && !['paid', 'failed', 'pending'].includes(status)) {
    return res.status(400).json({ message: 'status must be paid, failed or pending' });
  }
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ message: 'Payment not found' });

    if (status) payment.status = status;
    if (amount !== undefined) payment.amount = Number(amount);
    if (payment_date) payment.payment_date = payment_date;
    if (payment_mode) payment.payment_mode = payment_mode;
    if (reference_id !== undefined) payment.reference_id = reference_id;
    if (bank_name !== undefined) payment.bank_name = bank_name;
    if (notes !== undefined) payment.notes = notes;
    if (cycle_start_date) payment.cycle_start_date = cycle_start_date;
    if (cycle_end_date) payment.cycle_end_date = cycle_end_date;
    payment.updatedAt = DateTime.now().toUTC().toJSDate();
    await payment.save();

    // Editing a payment can settle or un-settle a cycle just as surely as creating one —
    // flipping its status to 'failed', or moving it onto a different cycle, both change the
    // lock verdict. Same eviction as the create path.
    await invalidateBusinessContext(payment.business_id);

    res.json(payment);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
