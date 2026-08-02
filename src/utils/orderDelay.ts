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
  is_delayed?: boolean;
  delivery_due_date?: string | null;
  completed_at?: string | null;
  status: string;
}

export function isOrderDelayed(order: DelayableOrder): boolean {
  if (order.is_delayed) return true;
  if (!order.delivery_due_date) return false;
  if (order.status === 'cancelled') return false;

  const due = DateTime.fromISO(order.delivery_due_date);

  if (FINISHED_STATUSES.includes(order.status)) {
    if (!order.completed_at) return false;
    return DateTime.fromISO(order.completed_at) > due;
  }

  return DateTime.now().toUTC() > due;
}

// Mongo query fragment for the same definition, for filtering/counting at the DB level.
// Both dates are stored as UTC ISO-8601 strings in the same format, so the comparison
// Mongo performs on them is chronological.
export function delayedMatchCondition(nowISO: string) {
  return {
    $or: [
      { is_delayed: true },
      // Still open, and past due.
      {
        delivery_due_date: { $ne: null, $lt: nowISO },
        status: { $nin: [...FINISHED_STATUSES, 'cancelled'] },
      },
      // Finished, but not before the due date.
      {
        status: { $in: FINISHED_STATUSES },
        delivery_due_date: { $ne: null },
        completed_at: { $ne: null },
        $expr: { $gt: ['$completed_at', '$delivery_due_date'] },
      },
    ],
  };
}
