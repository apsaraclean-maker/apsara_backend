import 'dotenv/config';
import mongoose from 'mongoose';

/**
 * One-off migration: converts every ISO-string timestamp in the database to a BSON Date, and
 * backfills the newly-materialised `is_delayed` flag on orders.
 *
 * ─── This must run before the new server code serves traffic ──────────────────
 *
 * It is not optional and not lazy. MongoDB compares across BSON types by *type bracket*, not
 * by value: a range query like `{ createdAt: { $gte: <Date> } }` does not match a document
 * whose createdAt is still the string "2026-08-08T…". It doesn't error — it silently returns
 * nothing. Un-migrated rows would therefore vanish from every date-filtered list, every
 * dashboard count and every report, while looking perfectly healthy in the collection.
 *
 * Run it against a restorable snapshot first. It is idempotent — already-converted fields are
 * skipped by the `$type: 'string'` filter, so re-running is safe and cheap.
 *
 *   npx tsx src/scripts/migrateTimestampsToDate.ts            (dry run: reports, changes nothing)
 *   npx tsx src/scripts/migrateTimestampsToDate.ts --apply    (writes)
 *
 * Date-only business keys are deliberately excluded: Payment.cycle_start_date /
 * cycle_end_date / payment_date and OrderDailyCounter.order_date are exact-match identifiers
 * ("2026-08-08", "260808"), not instants, and the code still compares them as strings.
 */

const APPLY = process.argv.includes('--apply');

// collection → timestamp fields on it
const TARGETS: Record<string, string[]> = {
  businesses: ['createdAt', 'updatedAt'],
  branches: ['createdAt', 'updatedAt', 'deleted_at'],
  users: ['createdAt', 'updatedAt', 'deleted_at', 'locked_until'],
  services: ['createdAt', 'updatedAt', 'deleted_at'],
  orders: ['createdAt', 'updatedAt', 'deleted_at', 'delivery_due_date', 'completed_at'],
  orderimages: ['createdAt'],
  orderstatushistories: ['changed_at'],
  orderratings: ['createdAt', 'submitted_at'],
  featureevents: ['createdAt'],
  articles: ['createdAt'],
  washingmethods: ['createdAt'],
  adminusers: ['createdAt', 'updatedAt'],
  payments: ['createdAt', 'updatedAt'],
  archivedusers: ['archived_at'],
};

async function main() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/apsaraclean';
  await mongoose.connect(uri, { family: 4 });
  const db = mongoose.connection.db!;
  console.log(`Connected to ${uri}`);
  console.log(APPLY ? '\n=== APPLYING CHANGES ===\n' : '\n=== DRY RUN (pass --apply to write) ===\n');

  let totalConverted = 0;

  for (const [collectionName, fields] of Object.entries(TARGETS)) {
    const collection = db.collection(collectionName);
    if (!(await db.listCollections({ name: collectionName }).hasNext())) {
      console.log(`${collectionName}: (collection does not exist, skipping)`);
      continue;
    }

    for (const field of fields) {
      // Only documents where the field is still a string. Nulls and existing Dates are left
      // alone, which is what makes a re-run a no-op.
      const filter = { [field]: { $type: 'string' } };
      const count = await collection.countDocuments(filter);
      if (!count) continue;

      totalConverted += count;
      console.log(`${collectionName}.${field}: ${count} string value(s)`);

      if (APPLY) {
        // $toDate parses the stored ISO-8601 strings directly in the server, so nothing has
        // to be read into this process. Documents whose value won't parse are left untouched
        // rather than being written as null — losing a timestamp is worse than not converting
        // it, and the count above will keep reporting them so they can't pass unnoticed.
        await collection.updateMany(filter, [
          {
            $set: {
              [field]: {
                $convert: { input: `$${field}`, to: 'date', onError: `$${field}`, onNull: null },
              },
            },
          },
        ]);
      }
    }
  }

  // ─── Backfill is_delayed ────────────────────────────────────────────────────
  // The flag is now stored rather than computed per query, so existing orders need their
  // value set once. Done after the date conversion above, since the rule compares timestamps.
  //
  // Expressed as a query rather than by reading orders into this process and deciding here:
  // the collection can be arbitrarily large, and pulling all of it back just to compute a
  // boolean is exactly the pattern this whole change set is removing. This is the same rule
  // as computeIsDelayed() in utils/orderDelay.ts — keep the two in step.
  const orders = db.collection('orders');
  const now = new Date();

  const isDelayedExpr = {
    $and: [
      { $ne: ['$delivery_due_date', null] },
      { $ne: ['$status', 'cancelled'] },
      {
        $cond: [
          { $in: ['$status', ['completed', 'paid']] },
          // Finished: late only if the completion landed after the due date.
          { $and: [{ $ne: ['$completed_at', null] }, { $gt: ['$completed_at', '$delivery_due_date'] }] },
          // Still open: late once the due date is behind us.
          { $lt: ['$delivery_due_date', now] },
        ],
      },
    ],
  };

  const toFlagCount = await orders.countDocuments({ $expr: { $and: [isDelayedExpr, { $ne: ['$is_delayed', true] }] } });
  const toClearCount = await orders.countDocuments({ $expr: { $and: [{ $not: isDelayedExpr }, { $eq: ['$is_delayed', true] }] } });

  console.log(`\norders.is_delayed: ${toFlagCount} to set true, ${toClearCount} to set false`);
  if (APPLY) {
    await orders.updateMany({ $expr: isDelayedExpr }, { $set: { is_delayed: true } });
    await orders.updateMany({ $expr: { $not: isDelayedExpr } }, { $set: { is_delayed: false } });
  }

  console.log(
    `\n${APPLY ? 'Converted' : 'Would convert'} ${totalConverted} timestamp value(s) across ${Object.keys(TARGETS).length} collections.`
  );
  if (!APPLY) console.log('Nothing was written. Re-run with --apply once the numbers look right.');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
