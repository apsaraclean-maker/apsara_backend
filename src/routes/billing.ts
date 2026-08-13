import { Router } from 'express';
import { DateTime } from 'luxon';
import { Business, Payment, Branch } from '../models.js';
import {
  sessionVerification,
  authorizeRoles,
  getAccessibleBranchIds,
  type AuthRequest,
} from '../middleware/auth.js';
import {
  BILLING_GRACE_DAYS,
  countBillableOrders,
  countBillableOrdersByCycle,
  getBillingState,
} from '../utils/billing.js';
import {
  computeBill,
  getCycleByIndex,
  getCycleIndexAt,
  type BillingCycle,
} from '../utils/billingCycle.js';
import { PAYMENT_REFLECT_BUSINESS_DAYS, UPI_PAYEE } from '../config/billing.js';

const router = Router();

router.use(sessionVerification);
// Deliberately NOT behind requireBillingUnlocked — this router is the one the PRD keeps open
// to a locked-out owner, since it is where they find out what they owe and how to pay it.
//
// Owner-only across the board: "The page is only visible to the owner" (PRD, "Persona
// Change"). Managers and workers are already rejected at the door when the business is locked,
// but they can reach this router perfectly well when it isn't, so the role check has to be
// here rather than implied by the lock.
router.use(authorizeRoles('owner'));

async function loadBusiness(req: AuthRequest) {
  if (!req.user?.businessId) return null;
  return Business.findById(req.user.businessId)
    .select('name createdAt status plan_name monthly_fixed_cost monthly_order_limit per_order_overage_cost gst_number address pincode state country phone')
    .lean();
}

// GET /api/billing/overview?branch_id=&cycle_index=
//
// Everything the Billing page's top three cards need in one request: the plan, the selected
// cycle's consumption, and the amount outstanding.
router.get('/overview', async (req: AuthRequest, res) => {
  try {
    const business = await loadBusiness(req);
    if (!business) return res.status(404).json({ message: 'Business not found' });

    const state = await getBillingState(business as any);
    const plan = state.plan;
    const currentIndex = state.currentCycle.index;

    // The date stepper walks cycles by index. It is clamped rather than validated so a stale
    // client (one that stepped forward as a new cycle began, say) lands on a real cycle
    // instead of getting an error it has no way to recover from.
    const requested = Number.parseInt(String(req.query.cycle_index ?? ''), 10);
    const cycleIndex = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 0), currentIndex)
      : currentIndex;
    const cycle = getCycleByIndex(business.createdAt, cycleIndex);

    // A manager/worker never reaches this route, so getAccessibleBranchIds always returns null
    // here — the call stays anyway so that an unexpected caller can't read a branch outside
    // their assignments by passing its id.
    const accessible = await getAccessibleBranchIds(req.user!);
    const requestedBranch = typeof req.query.branch_id === 'string' ? req.query.branch_id : '';
    const branchId =
      requestedBranch && (!accessible || accessible.includes(requestedBranch)) ? requestedBranch : null;

    // Two counts, because the two halves of this section answer different questions. The bar
    // and the order total are scoped to the selected branch (PRD: "view consumption specific
    // to branch"); the bill is never per-branch — the plan is bought by the business, and the
    // overage is charged on its combined volume.
    const [branchOrders, businessOrders] = await Promise.all([
      branchId ? countBillableOrders(business._id, cycle, branchId) : Promise.resolve<number | null>(null),
      cycleIndex === currentIndex
        ? Promise.resolve(state.currentBill.orders)
        : countBillableOrders(business._id, cycle),
    ]);

    const bill = cycleIndex === currentIndex ? state.currentBill : computeBill(plan, businessOrders);

    res.json({
      business: { id: business._id, name: business.name, registered_on: business.createdAt },
      plan: {
        name: plan.name,
        monthly_fixed_cost: plan.monthlyFixedCost,
        monthly_order_limit: plan.monthlyOrderLimit,
        per_order_overage_cost: plan.perOrderOverageCost,
        // PRD "Product Plan Section": Active or Inactive. Inactive is exactly the locked-out
        // state — an unpaid cycle past its grace — not merely "has an amount due".
        status: state.locked || business.status !== 'active' ? 'inactive' : 'active',
      },
      cycle: {
        index: cycle.index,
        cycle_start: cycle.cycleStart,
        cycle_end: cycle.cycleEnd,
        has_prev: cycle.index > 0,
        has_next: cycle.index < currentIndex,
        is_current: cycle.index === currentIndex,
      },
      consumption: {
        // Branch-scoped when a branch is selected, business-wide otherwise.
        orders: branchOrders ?? bill.orders,
        branch_id: branchId,
        limit: plan.monthlyOrderLimit,
      },
      bill: {
        orders: bill.orders,
        included_orders: bill.includedOrders,
        overage_orders: bill.overageOrders,
        overage_amount: bill.overageAmount,
        monthly_bill: bill.monthlyBill,
      },
      amount_due: {
        amount: state.amountDue,
        due_date: state.dueDate,
        // Cycles that have finished and are still short — the reason an amount due can exceed
        // the running cycle's own bill. `amount` is what remains owed, not the original bill.
        overdue_cycles: state.outstanding
          .filter((c) => c.index < currentIndex)
          .map((c) => ({
            cycle_start: c.cycleStart,
            cycle_end: c.cycleEnd,
            amount: c.amountDue,
            billed: c.bill.monthlyBill,
            paid: c.paid,
            due_date: c.dueDate,
            overdue: c.overdue,
          })),
      },
      lock: {
        locked: state.locked,
        grace_days: BILLING_GRACE_DAYS,
        grace_ends_on: state.graceEndsOn,
      },
      upi: UPI_PAYEE,
      payment_reflect_days: PAYMENT_REFLECT_BUSINESS_DAYS,
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/billing/branches — the branch dropdown's options.
//
// Served here rather than reusing /api/branches because that router is closed to a locked-out
// owner, and the Billing page still has to render its dropdown in that state.
router.get('/branches', async (req: AuthRequest, res) => {
  try {
    const branches = await Branch.find({ business_id: req.user!.businessId, deleted_at: null })
      .select('name branch_code')
      .sort({ name: 1 })
      .lean();
    res.json(branches.map((b) => ({ id: b._id, name: b.name, branch_code: b.branch_code })));
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/billing/payments — the Payment History table.
router.get('/payments', async (req: AuthRequest, res) => {
  try {
    const business = await loadBusiness(req);
    if (!business) return res.status(404).json({ message: 'Business not found' });

    const payments = await Payment.find({ business_id: business._id })
      .select('amount payment_date payment_mode reference_id bank_name status cycle_start_date cycle_end_date notes')
      .sort({ cycle_start_date: -1, payment_date: -1 })
      .lean();

    // Each row shows how many orders the cycle it settles actually carried. Those cycles are
    // consecutive far more often than not, so they are counted in one bucketed pass over the
    // whole span rather than one query per row.
    const anchored: BillingCycle[] = [];
    const seen = new Set<number>();
    const strays: typeof payments = [];

    for (const p of payments) {
      const index = getCycleIndexAt(business.createdAt, DateTime.fromISO(p.cycle_start_date, { zone: 'utc' }));
      const cycle = getCycleByIndex(business.createdAt, index);
      // A cycle_start_date typed by hand in the admin portal need not land on this business's
      // anchor day. Those fall back to a count over their own stored range — correct either
      // way, just not shareable with the bucketed pass.
      if (cycle.cycleStart !== p.cycle_start_date) {
        strays.push(p);
        continue;
      }
      if (!seen.has(index)) {
        seen.add(index);
        anchored.push(cycle);
      }
    }

    // The bucket boundaries have to be contiguous, so any gap between settled cycles is filled
    // back in — a business that skipped a month still gets correct counts either side of it.
    const span: BillingCycle[] = [];
    if (anchored.length) {
      const indices = anchored.map((c) => c.index);
      const lo = Math.min(...indices);
      const hi = Math.max(...indices);
      for (let i = lo; i <= hi; i++) span.push(getCycleByIndex(business.createdAt, i));
    }

    const [counts, strayCounts] = await Promise.all([
      countBillableOrdersByCycle(business._id, span),
      Promise.all(
        strays.map(async (p) => {
          const adHoc: BillingCycle = { index: -1, cycleStart: p.cycle_start_date, cycleEnd: p.cycle_end_date };
          return [p.cycle_start_date, await countBillableOrders(business._id, adHoc)] as const;
        })
      ),
    ]);
    for (const [key, n] of strayCounts) counts.set(key, n);

    res.json({
      payments: payments.map((p) => ({
        id: p._id,
        payment_date: p.payment_date,
        cycle_start: p.cycle_start_date,
        cycle_end: p.cycle_end_date,
        orders: counts.get(p.cycle_start_date) ?? 0,
        amount: p.amount,
        status: p.status ?? 'paid',
        payment_mode: p.payment_mode,
        reference_id: p.reference_id || '',
        bank_name: p.bank_name || '',
        notes: p.notes || '',
      })),
      // The receipt is rendered client-side and needs the payer's own details on it.
      business: {
        name: business.name,
        gst_number: business.gst_number || '',
        address: business.address || '',
        pincode: business.pincode || '',
        state: business.state || '',
        country: business.country || '',
        phone: business.phone || '',
      },
      payment_reflect_days: PAYMENT_REFLECT_BUSINESS_DAYS,
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message });
  }
});

export default router;
