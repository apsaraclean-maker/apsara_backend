import { DateTime } from 'luxon';
// Mirrors Frontend/lib/orderStatus.ts's isOrderDelayed — keep both in sync. An order is
// delayed if explicitly flagged, or if it has a due date that's passed while the order
// hasn't reached a terminal-ish state. Previously the backend's delayed count/filter only
// checked the `is_delayed` flag directly, but nothing in the app ever calls
// `PATCH /orders/:id/delayed` — so that flag stays false forever for real orders, while the
// frontend's card display correctly falls back to comparing dates. That meant the Dashboard
// delayed count and the Orders page's "Delayed only" filter were effectively dead for real
// data even though the visual indicator worked.
export const NON_DELAYABLE_STATUSES = ['paid', 'completed', 'cancelled'];
export function isOrderDelayed(order) {
    if (order.is_delayed)
        return true;
    if (!order.delivery_due_date)
        return false;
    if (NON_DELAYABLE_STATUSES.includes(order.status))
        return false;
    return DateTime.now().toUTC() > DateTime.fromISO(order.delivery_due_date);
}
// Mongo query fragment for the same definition, for filtering/counting at the DB level.
export function delayedMatchCondition(nowISO) {
    return {
        $or: [
            { is_delayed: true },
            {
                delivery_due_date: { $ne: null, $lt: nowISO },
                status: { $nin: NON_DELAYABLE_STATUSES },
            },
        ],
    };
}
