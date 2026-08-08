// One-off migration: `Order.completed_at` was added when the delay rule changed from "is it
// overdue right now" to "did it reach completed before its due date". Orders that finished
// before the field existed have no completion time on record, so isOrderDelayed() reads them
// as not-delayed — the same thing the app showed for them previously, but it means a genuinely
// late order from before the change won't carry the tag.
//
// OrderStatusHistory has the answer: it records every status change with its timestamp, and
// has done since the schema rewrite. This replays it to recover the moment each order last
// reached 'completed'.
//
// Only orders currently in a finished state (completed/paid) are touched, and only ones with
// no completed_at yet — reopened orders that are now back in progress are left alone, since
// their delay is judged against the clock. Safe to re-run.
//
// Usage:
//   npx tsx src/scripts/backfillCompletedAt.ts            (dry run — reports only)
//   npx tsx src/scripts/backfillCompletedAt.ts --apply
import 'dotenv/config';
import mongoose from 'mongoose';
import { Order, OrderStatusHistory } from '../models.js';

const FINISHED_STATUSES = ['completed', 'paid'];

async function main() {
  const apply = process.argv.includes('--apply');
  const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/apsaraclean';
  await mongoose.connect(MONGODB_URI, { family: 4 });
  console.log(apply ? 'Mode: APPLY' : 'Mode: DRY RUN (pass --apply to write)');

  const candidates = await Order.find({
    status: { $in: FINISHED_STATUSES },
    $or: [{ completed_at: null }, { completed_at: { $exists: false } }],
  }).select('_id order_number status delivery_due_date');

  console.log(`Finished orders with no completed_at: ${candidates.length}`);
  if (candidates.length === 0) {
    await mongoose.disconnect();
    return;
  }

  // The latest 'completed' entry, not the earliest: an order that was stepped back and
  // finished again was really done at the later moment.
  const history = await OrderStatusHistory.find({
    order_id: { $in: candidates.map((o) => o._id) },
    status: 'completed',
  }).select('order_id changed_at').sort({ changed_at: -1 });

  const completedAtByOrder = new Map<string, Date>();
  for (const entry of history) {
    const key = String(entry.order_id);
    if (!completedAtByOrder.has(key)) completedAtByOrder.set(key, entry.changed_at as Date);
  }

  let resolved = 0;
  let wouldBeDelayed = 0;
  let unresolved = 0;
  const writes: { updateOne: { filter: any; update: any } }[] = [];

  for (const order of candidates) {
    const completedAt = completedAtByOrder.get(String(order._id));
    if (!completedAt) {
      // Predates the status-history table, or its rows were pruned. Nothing to recover —
      // leaving completed_at null keeps it out of the delayed set rather than guessing.
      unresolved += 1;
      continue;
    }
    resolved += 1;
    if (order.delivery_due_date && completedAt.getTime() > order.delivery_due_date.getTime()) wouldBeDelayed += 1;
    writes.push({ updateOne: { filter: { _id: order._id }, update: { $set: { completed_at: completedAt } } } });
  }

  console.log(`  recoverable from history: ${resolved}`);
  console.log(`  no history to recover from (left as-is): ${unresolved}`);
  console.log(`  of the recoverable, newly marked delayed: ${wouldBeDelayed}`);

  if (apply && writes.length) {
    const result = await Order.bulkWrite(writes);
    console.log(`Updated ${result.modifiedCount} orders.`);
  } else if (!apply) {
    console.log('Dry run — nothing written.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
