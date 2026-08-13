import mongoose from 'mongoose';
import { DateTime } from 'luxon';
import { Order, Payment } from '../models.js';
import { computeBill, getCycleByIndex, getCycleDueDate, getCycleIndexAt, getCycleRange, readPlan, round2, } from './billingCycle.js';
/**
 * How long after a cycle ends the business may go on using the app with that cycle unpaid.
 * Past it, the Billing Page PRD's lockdown applies: staff cannot log in at all and the owner
 * is confined to the Billing page until the Apsara team records the payment.
 */
export const BILLING_GRACE_DAYS = 7;
// ─── Order consumption ────────────────────────────────────────────────────────
/**
 * Orders that count against the plan for a cycle: everything raised inside the window except
 * cancelled ones, and except anything since deleted.
 *
 * Deliberately keyed on createdAt rather than on completion. It is what the design's "612
 * Total Monthly Orders" counts, and it is the only definition under which the number a
 * business watches climb during a cycle can never go *down* — an order completing late would
 * otherwise move revenue between two cycles that have already been billed.
 *
 * The createdAt range also happens to be what keeps the pre-revamp camelCase rows in this
 * collection out of the count: they carry no `createdAt` at all, so no range can match them.
 */
export function billableOrderFilter(businessId, cycle, branchId) {
    const { from, to } = getCycleRange(cycle);
    const filter = {
        business_id: new mongoose.Types.ObjectId(String(businessId)),
        deleted_at: null,
        status: { $ne: 'cancelled' },
        createdAt: { $gte: from, $lte: to },
    };
    if (branchId)
        filter.branch_id = new mongoose.Types.ObjectId(String(branchId));
    return filter;
}
export function countBillableOrders(businessId, cycle, branchId) {
    return Order.countDocuments(billableOrderFilter(businessId, cycle, branchId));
}
/**
 * Order counts for a run of consecutive cycles, in one aggregation.
 *
 * The payment history table shows an order count per row, and issuing a count per row meant a
 * round trip per row. `$bucket` gets them all from a single indexed range scan: because cycles
 * are contiguous by construction, the cycle starts *are* the bucket boundaries, with the day
 * after the last cycle closing the final bucket.
 */
export async function countBillableOrdersByCycle(businessId, cycles) {
    const counts = new Map();
    if (!cycles.length)
        return counts;
    const ordered = [...cycles].sort((a, b) => a.index - b.index);
    for (const c of ordered)
        counts.set(c.cycleStart, 0);
    const boundaries = ordered.map((c) => getCycleRange(c).from);
    // One past the end, so the last cycle gets a bucket of its own rather than being the
    // overflow. $bucket's boundaries are [inclusive, exclusive), hence the start of the *next*
    // day after the final cycle's last day.
    const lastEnd = DateTime.fromISO(ordered[ordered.length - 1].cycleEnd, { zone: 'utc' })
        .plus({ days: 1 })
        .startOf('day')
        .toJSDate();
    boundaries.push(lastEnd);
    const rows = await Order.aggregate([
        {
            $match: {
                business_id: new mongoose.Types.ObjectId(String(businessId)),
                deleted_at: null,
                status: { $ne: 'cancelled' },
                createdAt: { $gte: boundaries[0], $lt: lastEnd },
            },
        },
        { $bucket: { groupBy: '$createdAt', boundaries, default: 'other', output: { n: { $sum: 1 } } } },
    ]);
    for (const row of rows) {
        if (row._id === 'other' || !(row._id instanceof Date))
            continue;
        const key = DateTime.fromJSDate(row._id).toUTC().toISODate();
        if (counts.has(key))
            counts.set(key, row.n);
    }
    return counts;
}
// ─── Settlement state ─────────────────────────────────────────────────────────
/**
 * Rupees actually settled per cycle, keyed by cycle start.
 *
 * Only `paid` rows count — a recorded but failed or pending attempt settles nothing and leaves
 * the grace clock running.
 *
 * Summed rather than counted, and compared against the bill rather than merely checked for
 * existence, because a cycle's cost is not known when its first payment is taken. The normal
 * flow is that the Apsara team records the fixed monthly charge, then orders accrue and push
 * the bill past that figure. Treating any `paid` row as settling the whole cycle wrote the
 * resulting overage off silently. It also lets one cycle legitimately take more than one
 * payment: the fixed part up front, the overage once the volume is known.
 */
export async function getPaidAmountByCycle(businessId) {
    const payments = await Payment.find({ business_id: businessId })
        .select('cycle_start_date amount status')
        .lean();
    const paid = new Map();
    for (const p of payments) {
        if ((p.status ?? 'paid') !== 'paid')
            continue;
        paid.set(p.cycle_start_date, round2((paid.get(p.cycle_start_date) ?? 0) + (Number(p.amount) || 0)));
    }
    return paid;
}
const graceEndFor = (cycle) => DateTime.fromISO(cycle.cycleEnd, { zone: 'utc' }).plus({ days: BILLING_GRACE_DAYS }).toISODate();
/**
 * The full billing position for a business: what it owes, for which cycles, and whether that
 * has gone far enough past due to lock the app.
 *
 * Every cycle since registration is examined, not just the last one — a business that stopped
 * paying three cycles ago owes all three, and the lock is judged against the *oldest* cycle
 * still short, which is the one whose grace expires first.
 *
 * A cycle is outstanding by the amount still short of its bill, not by whether a payment row
 * exists for it. A ₹300 payment against a ₹400 cycle leaves ₹100 owed, which is the ordinary
 * result of overage accruing after the fixed charge was recorded.
 *
 * A cycle covered to zero — settled, or simply costing nothing — is skipped. Under a pure
 * pay-per-order plan (fixed cost 0, PRD "if monthly cost is 0…") a month with no orders costs
 * nothing and there is nothing for the Apsara team to record, so demanding a payment for it
 * would lock a business that owes nothing.
 */
export async function getBillingState(business, at) {
    const now = (at ?? DateTime.now()).toUTC();
    const today = now.toISODate();
    const plan = readPlan(business);
    const currentIndex = getCycleIndexAt(business.createdAt, now);
    const currentCycle = getCycleByIndex(business.createdAt, currentIndex);
    // The unbroken run of cycles, which is also what $bucket requires: it derives each bucket
    // from the gap between consecutive boundaries, so a list with a cycle missing from the
    // middle would fold that cycle's orders into the preceding bucket.
    const span = [];
    for (let i = 0; i <= currentIndex; i++)
        span.push(getCycleByIndex(business.createdAt, i));
    const [counts, paidByCycle] = await Promise.all([
        countBillableOrdersByCycle(business._id, span),
        getPaidAmountByCycle(business._id),
    ]);
    const currentBill = computeBill(plan, counts.get(currentCycle.cycleStart) ?? 0);
    // span is ordered oldest-first, so outstanding comes out oldest-first too — which is what
    // makes outstanding[0] the earliest due date and the cycle whose grace runs out first.
    const outstanding = [];
    for (const cycle of span) {
        const bill = computeBill(plan, counts.get(cycle.cycleStart) ?? 0);
        const paid = paidByCycle.get(cycle.cycleStart) ?? 0;
        const amountDue = round2(bill.monthlyBill - paid);
        if (amountDue <= 0)
            continue;
        const graceEndsOn = graceEndFor(cycle);
        outstanding.push({
            ...cycle,
            bill,
            paid,
            amountDue,
            dueDate: getCycleDueDate(cycle),
            graceEndsOn,
            // The running cycle is shown as due — that is the design's ₹356 "Pay by 15 Jun 2026" —
            // but it can never be overdue however much is owed, because it is still accruing.
            overdue: cycle.index < currentIndex && today > graceEndsOn,
        });
    }
    const overdue = outstanding.find((c) => c.overdue);
    return {
        plan,
        currentCycle,
        currentBill,
        outstanding,
        amountDue: round2(outstanding.reduce((sum, c) => sum + c.amountDue, 0)),
        dueDate: outstanding[0]?.dueDate ?? getCycleDueDate(currentCycle),
        locked: !!overdue,
        graceEndsOn: overdue?.graceEndsOn ?? outstanding[0]?.graceEndsOn ?? null,
    };
}
/**
 * The lock verdict alone, on the cheapest path that can produce it.
 *
 * This runs inside sessionVerification, so it is on every authenticated request — hence the
 * short-circuits. It walks completed cycles oldest-first and stops at the first unsettled one
 * with something owed, and it only counts orders when it has to: with a non-zero fixed cost
 * the bill is non-zero whatever the order count, so the count query is skipped entirely. Most
 * businesses are settled and exit on the first loop with no order query at all.
 *
 * The verdict is cached by the caller (utils/authCache) and evicted when a payment is written,
 * so a settled business does not repeat even this per request.
 */
export async function evaluateBillingLock(business, at) {
    const now = (at ?? DateTime.now()).toUTC();
    const today = now.toISODate();
    const currentIndex = getCycleIndexAt(business.createdAt, now);
    if (currentIndex === 0)
        return { locked: false, graceEndsOn: null };
    const plan = readPlan(business);
    // A plan with neither a fixed cost nor an overage rate can never produce a bill, so no cycle
    // can ever fall overdue. Answered here without touching the database, which matters because
    // that is precisely the shape every business carries until the Apsara team sets its plan in
    // the admin portal: without this, each one would issue an order count per elapsed cycle on
    // every cache miss, only to conclude each time that nothing was owed.
    if (plan.monthlyFixedCost <= 0 && plan.perOrderOverageCost <= 0) {
        return { locked: false, graceEndsOn: null };
    }
    const paidByCycle = await getPaidAmountByCycle(business._id);
    for (let i = 0; i < currentIndex; i++) {
        const cycle = getCycleByIndex(business.createdAt, i);
        const paid = paidByCycle.get(cycle.cycleStart) ?? 0;
        // Orders are counted only when the plan charges for them. With no overage rate the bill is
        // the fixed cost whatever the volume, so the query is skipped — which is the common case,
        // and it keeps this cheap on a path that runs for every authenticated request.
        const bill = plan.perOrderOverageCost > 0
            ? computeBill(plan, await countBillableOrders(business._id, cycle)).monthlyBill
            : plan.monthlyFixedCost;
        if (round2(bill - paid) <= 0)
            continue;
        const graceEndsOn = graceEndFor(cycle);
        return { locked: today > graceEndsOn, graceEndsOn };
    }
    return { locked: false, graceEndsOn: null };
}
