import 'dotenv/config';
import mongoose from 'mongoose';

/**
 * Removes order documents that violate the core invariant: an order always belongs to a
 * business and always has a status. Nothing in the application can create such a document —
 * business_id and status are both required on the schema — so anything matching here was
 * written by an earlier version of the codebase.
 *
 * In this database that means 55 rows carrying the pre-revamp camelCase field set
 * (`orderNumber`, `customerName`, `businessId`, `services[]`, `totalAmount`, `photos`, …)
 * rather than the current snake_case one. They are invisible to every query the app issues,
 * they have no rows in orderservices/orderimages/orderstatushistories/orderratings, and the
 * `businessId` values they carry point at businesses that no longer exist.
 *
 * They are not empty, though — they hold real customer names, amounts and line items. So this
 * copies every document verbatim into `legacy_orders_archive` before deleting it. The archive
 * is a plain collection with no schema attached; restoring is an insertMany back into
 * `orders`, and nothing in the app reads it.
 *
 *   npx tsx src/scripts/purgeLegacyOrders.ts            (dry run)
 *   npx tsx src/scripts/purgeLegacyOrders.ts --apply
 */

const APPLY = process.argv.includes('--apply');
const ARCHIVE = 'legacy_orders_archive';

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/apsaraclean', { family: 4 });
  const db = mongoose.connection.db!;
  const orders = db.collection('orders');

  // Deliberately matches on the *absence* of the required fields rather than on the presence
  // of legacy ones — the invariant is what matters, not which old schema happened to write it.
  const invalid = { $or: [{ business_id: { $in: [null, undefined] } }, { status: { $in: [null, undefined] } }] };

  const docs = await orders.find(invalid).toArray();
  console.log(APPLY ? '=== APPLYING ===\n' : '=== DRY RUN (pass --apply to write) ===\n');
  console.log(`orders violating "must have business_id and status": ${docs.length}`);
  console.log(`orders total in collection: ${await orders.countDocuments()}`);

  if (!docs.length) {
    console.log('\nNothing to do.');
    await mongoose.disconnect();
    return;
  }

  // Refuse to touch anything still referenced by a child collection. If this ever fires, the
  // document is not the orphan this script assumes and needs looking at by hand.
  const ids = docs.map((d) => d._id);
  for (const coll of ['orderservices', 'orderimages', 'orderstatushistories', 'orderratings']) {
    const n = await db.collection(coll).countDocuments({ order_id: { $in: ids } });
    if (n > 0) {
      console.error(`\nABORTING: ${n} row(s) in ${coll} still reference these orders. They are not orphaned; resolve by hand.`);
      await mongoose.disconnect();
      process.exitCode = 1;
      return;
    }
  }
  console.log('all are unreferenced by orderservices / orderimages / orderstatushistories / orderratings');

  const withName = docs.filter((d) => d.customerName || d.customer_name).length;
  const withValue = docs.filter((d) => (d.totalAmount ?? d.total_price ?? 0) > 0).length;
  console.log(`  carrying a customer name: ${withName}`);
  console.log(`  carrying a non-zero amount: ${withValue}`);

  if (!APPLY) {
    console.log(`\nWould archive all ${docs.length} into "${ARCHIVE}", then delete them from "orders".`);
    console.log('Nothing was written.');
    await mongoose.disconnect();
    return;
  }

  // Archive first, delete second, and only delete the ids that actually landed in the
  // archive — so an interrupted run can never lose a document.
  const archive = db.collection(ARCHIVE);
  await archive.insertMany(docs.map((d) => ({ ...d, _archived_at: new Date(), _archived_reason: 'pre-revamp schema; no business_id/status' })), { ordered: false });
  const archivedIds = (await archive.find({ _id: { $in: ids } }).project({ _id: 1 }).toArray()).map((d) => d._id);
  console.log(`archived ${archivedIds.length}/${docs.length} into "${ARCHIVE}"`);

  if (archivedIds.length !== docs.length) {
    console.error('ABORTING before delete: archive count does not match. Nothing deleted.');
    await mongoose.disconnect();
    process.exitCode = 1;
    return;
  }

  const del = await orders.deleteMany({ _id: { $in: archivedIds } });
  console.log(`deleted ${del.deletedCount} from "orders"`);
  console.log(`orders remaining: ${await orders.countDocuments()}`);
  console.log(`\nTo restore: db.${ARCHIVE}.find().forEach(d => { delete d._archived_at; delete d._archived_reason; db.orders.insertOne(d); })`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Purge failed:', err);
  process.exit(1);
});
