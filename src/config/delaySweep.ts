import { Order } from '../models.js';
import { overdueOpenOrdersFilter } from '../utils/orderDelay.js';

/**
 * Marks open orders that have quietly crossed their delivery due date as delayed.
 *
 * `is_delayed` is a stored value rather than a predicate evaluated at read time — see the
 * note on the Order schema for why. Almost every way an order's delay status can change is a
 * write the app already handles (a status transition, a due-date edit), and those recompute
 * the flag inline. This covers the only case that isn't a write at all: nobody touches the
 * order, the deadline simply passes.
 *
 * One indexed updateMany, no read-back. When nothing has expired since the last tick — the
 * usual case — this matches zero documents and costs an index seek.
 */
export async function sweepOverdueOrders() {
  const result = await Order.updateMany(overdueOpenOrdersFilter(new Date()), { $set: { is_delayed: true } });
  if (result.modifiedCount) {
    console.log(`[delaySweep] marked ${result.modifiedCount} order(s) delayed`);
  }
  return result.modifiedCount;
}
