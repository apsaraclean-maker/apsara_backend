import { DateTime } from 'luxon';

// Mirrors Frontend/lib/orderStatus.ts's isOrderDelayed — keep both in sync.
//
// An order is delayed if it didn't reach "completed" before its due date. That's a fact
// about what happened, not a state the order passes through, so the mark survives the rest
// of the order's life: a job finished two days late still reads as delayed once it's
// completed, and again once it's paid.
//
//   • open (created / in_progress) — delayed once the due date is behind us
//   • completed / paid — delayed if the completion landed after the due date
//   • cancelled — never delayed; it was called off, not missed
//
// Orders that reached completed before `completed_at` existed have no completion time on
// record. They fall through as not-delayed rather than being guessed at — which is what the
// app showed for them before this rule anyway; `scripts/backfillCompletedAt.ts` fills them
// in from OrderStatusHistory.
export const FINISHED_STATUSES = ['completed', 'paid'];

interface DelayableOrder {
  delivery_due_date?: Date | string | null;
  completed_at?: Date | string | null;
  status: string;
}

function toDateTime(value: Date | string): DateTime {
  return value instanceof Date ? DateTime.fromJSDate(value) : DateTime.fromISO(value);
}

/**
 * The authoritative delay rule, computed from the order's own fields.
 *
 * Note this deliberately does NOT consult `is_delayed` — that field is the *output* of this
 * function, and reading it back in would make the value self-confirming: once set, it could
 * never be cleared, so an order whose due date is pushed out would stay marked as late
 * forever. Callers wanting the stored answer should read `is_delayed` directly.
 */
export function computeIsDelayed(order: DelayableOrder): boolean {
  if (!order.delivery_due_date) return false;
  if (order.status === 'cancelled') return false;

  const due = toDateTime(order.delivery_due_date);

  if (FINISHED_STATUSES.includes(order.status)) {
    if (!order.completed_at) return false;
    return toDateTime(order.completed_at) > due;
  }

  return DateTime.now().toUTC() > due;
}

/**
 * Back-compat alias. Reads the stored flag when there is one, otherwise recomputes — used by
 * the report writer, which renders orders it has already loaded.
 */
export function isOrderDelayed(order: DelayableOrder & { is_delayed?: boolean }): boolean {
  return order.is_delayed ?? computeIsDelayed(order);
}

/**
 * Query fragment for "delayed only" filters and counts.
 *
 * This used to be a three-armed $or whose last arm was
 * `$expr: { $gt: ['$completed_at', '$delivery_due_date'] }` — a comparison between two
 * fields of the same document, which no index can ever satisfy. Mongo had to read and
 * evaluate every candidate order, on every Dashboard load and every filtered list. Now that
 * `is_delayed` is maintained as a real stored value (see recomputeIsDelayed below and the
 * nightly sweep in config/delaySweep.ts), the same question is a plain indexed equality.
 */
export function delayedMatchCondition() {
  return { is_delayed: true };
}

/**
 * Matches open orders that have quietly crossed their due date since anyone last wrote to
 * them — the one transition that no request-path write can catch, because nothing happens.
 * Drives the nightly sweep.
 */
export function overdueOpenOrdersFilter(now: Date) {
  return {
    is_delayed: false,
    deleted_at: null,
    delivery_due_date: { $ne: null, $lt: now },
    status: { $nin: [...FINISHED_STATUSES, 'cancelled'] },
  };
}
