import 'dotenv/config';
import mongoose from 'mongoose';
import * as models from '../models.js';

/**
 * Builds (and drops) indexes to match the schemas, as an explicit deploy step.
 *
 * The server no longer does this on boot — `autoIndex` is off in production (see server.ts),
 * because Mongoose otherwise re-issues createIndex for every index in every schema on every
 * start, which competes with live traffic and slows startup on large collections.
 *
 *   npx tsx src/scripts/syncIndexes.ts
 *
 * `syncIndexes()` also *drops* indexes that are in the database but no longer in the schema —
 * which is the point here, since the Order index set was reshaped and the three superseded
 * indexes ({business_id, createdAt}, {business_id, deleted_at}, {business_id, branch_id,
 * status}) should not be left behind consuming write throughput and RAM.
 *
 * Run it during a deploy window. Index builds on a large collection are background operations
 * on a replica set but still consume IO, and the drops are immediate.
 */
async function main() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/apsaraclean';
  await mongoose.connect(uri, { family: 4 });
  console.log(`Connected to ${uri}\n`);

  const entries = Object.entries(models).filter(
    ([, value]) => value instanceof mongoose.Model || (value as any)?.prototype instanceof mongoose.Document
  ) as [string, mongoose.Model<any>][];

  // Indexes are created one at a time rather than through Model.syncIndexes().
  //
  // syncIndexes() issues them as a single createIndexes command, so one index the existing
  // data can't satisfy takes every other index on that model down with it — which is exactly
  // what happened here: a duplicate order_number blocked all six of the new performance
  // indexes on `orders` from being built, and the error gave no hint that the rest had been
  // skipped. Creating them individually means a data problem costs you that one constraint
  // and nothing else, and the summary names precisely which one to go and fix.
  const failures: string[] = [];

  for (const [name, model] of entries) {
    if (!model?.collection) continue;
    const schemaIndexes = model.schema.indexes();
    const created: string[] = [];

    for (const [key, options] of schemaIndexes) {
      try {
        await model.collection.createIndex(key as any, options as any);
        created.push(Object.keys(key).join('+'));
      } catch (err: any) {
        failures.push(`${name}.${Object.keys(key).join('+')}`);
        console.error(`${name.padEnd(20)} FAILED on {${Object.keys(key).join(', ')}}: ${err.message.split('\n')[0].slice(0, 160)}`);
        if (err.code === 11000) {
          console.error(`${''.padEnd(20)}  -> existing data violates this unique index; every other index on this model was still applied.`);
        }
      }
    }

    // Drop anything in the database that the schema no longer declares — the point of a sync
    // rather than a create. _id_ is never schema-declared and must never be dropped.
    const existing = await model.collection.indexes();
    const wanted = new Set(schemaIndexes.map(([key]: [any, any]) => JSON.stringify(key)));
    const dropped: string[] = [];
    for (const idx of existing) {
      if (idx.name === '_id_') continue;
      if (!wanted.has(JSON.stringify(idx.key))) {
        await model.collection.dropIndex(idx.name!);
        dropped.push(idx.name!);
      }
    }

    console.log(`${name.padEnd(20)} ${created.length} index(es) ok${dropped.length ? ` (dropped: ${dropped.join(', ')})` : ''}`);
  }

  if (failures.length) {
    console.log(`\nIndex sync finished with ${failures.length} failure(s): ${failures.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nIndex sync complete.');
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Index sync failed:', err);
  process.exit(1);
});
