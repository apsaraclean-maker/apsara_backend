import { Router } from 'express';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { DateTime } from 'luxon';
import { Business, User, Payment, AdminUser } from '../models.js';
import { generateAdminToken, adminAuthMiddleware, type AuthRequest } from '../middleware/auth.js';
import { invalidateUserSessions } from '../utils/sessionControl.js';
import { invalidateBusinessContext } from '../utils/authCache.js';

const router = Router();

// Accepts the Date the schema now stores, or an ISO string from a row predating the
// timestamp migration.
function getCurrentBillingCycle(registrationDate: Date | string): { cycleStart: string; cycleEnd: string } {
  const regDate = (registrationDate instanceof Date
    ? DateTime.fromJSDate(registrationDate)
    : DateTime.fromISO(registrationDate)
  ).toUTC();
  const regDay = regDate.day;
  const today = DateTime.now().toUTC();

  let cycleStart: DateTime;
  if (today.day >= regDay) {
    cycleStart = today.set({ day: regDay }).startOf('day');
  } else {
    cycleStart = today.minus({ months: 1 }).set({ day: regDay }).startOf('day');
  }
  const cycleEnd = cycleStart.plus({ months: 1 }).minus({ days: 1 }).endOf('day');

  return { cycleStart: cycleStart.toISODate()!, cycleEnd: cycleEnd.toISODate()! };
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

// PUT /api/admin/businesses/:id
router.put('/businesses/:id', adminAuthMiddleware, async (req, res) => {
  const { name, address, phone, pincode, state, owner_name } = req.body;
  try {
    const business = await Business.findById(req.params.id);
    if (!business) return res.status(404).json({ message: 'Business not found' });

    if (name) business.name = name;
    if (address !== undefined) business.address = address;
    if (phone !== undefined) business.phone = phone;
    if (pincode !== undefined) business.pincode = pincode;
    if (state !== undefined) business.state = state;
    business.updatedAt = DateTime.now().toUTC().toJSDate();
    await business.save();

    if (owner_name) {
      await User.findByIdAndUpdate(business.owner_id, { name: owner_name, updatedAt: DateTime.now().toUTC().toJSDate() });
    }

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
    const currentCycleHasPayment = payments.some((p) => p.cycle_start_date === cycleStart);

    res.json({
      payments,
      current_cycle: { cycle_start: cycleStart, cycle_end: cycleEnd },
      payment_label: business.status === 'active' ? (currentCycleHasPayment ? 'Paid' : 'Delayed') : 'N/A',
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/admin/businesses/:id/payments
router.post('/businesses/:id/payments', adminAuthMiddleware, async (req: AuthRequest, res) => {
  const { amount, payment_date, payment_mode, reference_id, bank_name, notes, cycle_start_date, cycle_end_date } = req.body;
  if (!amount || !payment_date || !payment_mode || !cycle_start_date || !cycle_end_date) {
    return res.status(400).json({ message: 'amount, payment_date, payment_mode, cycle_start_date, cycle_end_date required' });
  }
  try {
    const existing = await Payment.findOne({ business_id: req.params.id, cycle_start_date });
    if (existing) return res.status(400).json({ message: 'Payment already exists for this billing cycle' });

    const payment = await Payment.create({
      business_id: req.params.id,
      amount: Number(amount),
      payment_date,
      payment_mode,
      reference_id: reference_id || '',
      bank_name: bank_name || '',
      notes: notes || '',
      cycle_start_date,
      cycle_end_date,
      created_by: req.user?.id,
    });

    res.status(201).json(payment);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/admin/payments/:id
router.put('/payments/:id', adminAuthMiddleware, async (req, res) => {
  const { amount, payment_date, payment_mode, reference_id, bank_name, notes, cycle_start_date, cycle_end_date } = req.body;
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ message: 'Payment not found' });

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

    res.json(payment);
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
