import { DateTime } from 'luxon';
/** Accepts the Date the schema now stores, or an ISO string from a row predating the
 *  timestamp migration. */
export function toUTCDateTime(value) {
    return (value instanceof Date ? DateTime.fromJSDate(value) : DateTime.fromISO(value)).toUTC();
}
/**
 * The anchor day, clamped into a month that may not have it.
 *
 * A business registered on the 31st has no 31st in February, and Luxon returns an *invalid*
 * DateTime for `set({ day: 31 })` there rather than clamping — which would have propagated a
 * NaN cycle boundary into every payment lookup and order count. Such a cycle ends on the last
 * day of the short month and the next one picks the 31st back up, because each boundary is
 * derived from the original anchor rather than from the previous (already clamped) one.
 */
function anchorIn(month, anchorDay) {
    return month.set({ day: Math.min(anchorDay, month.daysInMonth ?? 28) }).startOf('day');
}
export function getCycleByIndex(registrationDate, index) {
    const reg = toUTCDateTime(registrationDate);
    const anchorDay = reg.day;
    const firstMonth = reg.startOf('month');
    const start = anchorIn(firstMonth.plus({ months: index }), anchorDay);
    const nextStart = anchorIn(firstMonth.plus({ months: index + 1 }), anchorDay);
    return {
        index,
        cycleStart: start.toISODate(),
        cycleEnd: nextStart.minus({ days: 1 }).toISODate(),
    };
}
/** Index of the cycle that contains `at` (defaults to now). Never negative — a clock skewed
 *  behind the registration date reads as the first cycle rather than a negative one. */
export function getCycleIndexAt(registrationDate, at) {
    const reg = toUTCDateTime(registrationDate);
    const now = (at ?? DateTime.now()).toUTC();
    const monthsApart = Math.round(now.startOf('month').diff(reg.startOf('month'), 'months').months);
    if (monthsApart <= 0)
        return 0;
    // Landing in the right month isn't enough: on the 3rd of June, a business anchored to the
    // 15th is still inside the cycle that began on 15 May. Step back one when the day hasn't
    // reached the anchor yet.
    const candidate = getCycleByIndex(registrationDate, monthsApart);
    return now.toISODate() < candidate.cycleStart ? monthsApart - 1 : monthsApart;
}
export function getCurrentCycle(registrationDate, at) {
    return getCycleByIndex(registrationDate, getCycleIndexAt(registrationDate, at));
}
/**
 * The day a cycle's bill falls due: the day after it ends.
 *
 * This is the "Pay by 15 Jun 2026" on a 15-May-to-14-Jun cycle in the design — a cycle is
 * billed once it has finished running, not while it is still accruing orders.
 */
export function getCycleDueDate(cycle) {
    return DateTime.fromISO(cycle.cycleEnd, { zone: 'utc' }).plus({ days: 1 }).toISODate();
}
/** Inclusive instant bounds for a cycle, for `$gte` / `$lte` matching against a Date field. */
export function getCycleRange(cycle) {
    return {
        from: DateTime.fromISO(cycle.cycleStart, { zone: 'utc' }).startOf('day').toJSDate(),
        to: DateTime.fromISO(cycle.cycleEnd, { zone: 'utc' }).endOf('day').toJSDate(),
    };
}
export function readPlan(business) {
    return {
        name: business.plan_name || 'Standard',
        monthlyFixedCost: Number(business.monthly_fixed_cost) || 0,
        monthlyOrderLimit: Number(business.monthly_order_limit) || 0,
        perOrderOverageCost: Number(business.per_order_overage_cost) || 0,
    };
}
/**
 * PRD "Calculation Logics":
 *   Total Bill (One Cycle) = Fixed Cost + (Orders - Monthly order limit) × Overage cost per order
 *
 * Clamped at zero on the overage term, which the PRD leaves implicit — under-using the plan
 * discounts nothing, it just means no overage. Money is rounded to paise at each step so a
 * fractional per-order rate (the design's ₹0.50) can't accumulate binary float dust into a
 * total that renders as ₹355.99999999999994.
 */
export function computeBill(plan, orders) {
    const safeOrders = Math.max(0, Math.floor(Number(orders) || 0));
    const overageOrders = Math.max(0, safeOrders - plan.monthlyOrderLimit);
    const overageAmount = round2(overageOrders * plan.perOrderOverageCost);
    return {
        orders: safeOrders,
        includedOrders: Math.min(safeOrders, plan.monthlyOrderLimit),
        overageOrders,
        overageAmount,
        monthlyBill: round2(plan.monthlyFixedCost + overageAmount),
    };
}
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
