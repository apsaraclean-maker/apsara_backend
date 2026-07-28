// One-off migration: the app used to store an integer `roleId` on User documents before
// the schema rewrite (models.ts) switched to a string `role` enum ('admin'|'owner'|
// 'manager'|'worker'). Any User document created before that rewrite may still carry the
// old integer field instead of (or alongside) the new string one.
//
// No definitive old-scheme mapping survives in this codebase or its history — the only
// remaining trace is a stale UI comment ("Conditional render based on user.roleId") in an
// unrelated doc-sync script, not a data dictionary. Rather than guess and risk silently
// mis-assigning a real owner/manager/worker, this script is dry-run by default: it reports
// every document it would touch and the mapping it would apply, and only writes when given
// a mapping explicitly confirmed via --apply.
//
// Usage:
//   npx tsx src/scripts/migrateRoleIds.ts                 (dry run — reports only)
//   npx tsx src/scripts/migrateRoleIds.ts --apply          (applies the default mapping below)
//   npx tsx src/scripts/migrateRoleIds.ts --apply --map=1:owner,2:manager,3:worker,0:admin
import 'dotenv/config';
import mongoose from 'mongoose';
const DEFAULT_MAPPING = { '1': 'owner', '2': 'manager', '3': 'worker', '0': 'admin' };
const VALID_ROLES = new Set(['admin', 'owner', 'manager', 'worker']);
function parseMapping(raw) {
    if (!raw)
        return DEFAULT_MAPPING;
    const map = {};
    for (const pair of raw.split(',')) {
        const [id, role] = pair.split(':');
        if (!id || !role || !VALID_ROLES.has(role)) {
            throw new Error(`Invalid --map entry "${pair}" — expected format like "1:owner"`);
        }
        map[id] = role;
    }
    return map;
}
async function main() {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    const mapArg = args.find((a) => a.startsWith('--map='))?.slice('--map='.length);
    const mapping = parseMapping(mapArg);
    const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/apsaraclean';
    await mongoose.connect(MONGODB_URI, { family: 4 });
    console.log('Connected to MongoDB');
    const users = mongoose.connection.collection('users');
    // Anything with a numeric roleId, or whose `role` isn't one of the four valid strings
    // (covers documents that never had roleId either, e.g. missing/null/garbage `role`).
    const candidates = await users
        .find({ $or: [{ roleId: { $exists: true } }, { role: { $nin: Array.from(VALID_ROLES) } }] })
        .toArray();
    if (candidates.length === 0) {
        console.log('No legacy roleId / invalid role documents found. Nothing to do.');
        await mongoose.disconnect();
        return;
    }
    console.log(`Found ${candidates.length} document(s) needing attention:\n`);
    const updates = [];
    for (const doc of candidates) {
        const roleId = doc.roleId !== undefined ? String(doc.roleId) : undefined;
        const mapped = roleId !== undefined ? mapping[roleId] ?? null : null;
        console.log(`  _id=${doc._id}  phone=${doc.phone ?? '?'}  roleId=${doc.roleId ?? '—'}  role=${doc.role ?? '—'}  -> ${mapped ?? 'UNRESOLVED (needs manual review)'}`);
        updates.push({ _id: doc._id, from: doc.roleId ?? doc.role, to: mapped });
    }
    if (!apply) {
        console.log('\nDry run only — no changes made. Re-run with --apply to write these changes.');
        await mongoose.disconnect();
        return;
    }
    let applied = 0;
    let skipped = 0;
    for (const u of updates) {
        if (!u.to) {
            skipped++;
            continue;
        }
        await users.updateOne({ _id: u._id }, { $set: { role: u.to }, $unset: { roleId: '' } });
        applied++;
    }
    console.log(`\nApplied ${applied} update(s). Skipped ${skipped} document(s) with no resolvable mapping — review those manually.`);
    await mongoose.disconnect();
}
main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
});
