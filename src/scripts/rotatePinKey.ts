// Re-encrypts every staff PIN under a new PIN_ENCRYPTION_KEY.
//
// Staff PINs are reversibly encrypted (AES-256-GCM), not hashed, because the owner needs to
// view a staff member's actual PIN on the Staff Page — but that also means there was no
// rotation story at all: if PIN_ENCRYPTION_KEY were ever changed (rotated on a schedule,
// or a redeploy landed on a host without the same env var), every existing PIN would become
// permanently undecryptable, locking out every manager/worker with no recovery path — not
// even the owner could view the old PINs to manually re-communicate them.
//
// This script decrypts every pin_encrypted value with the OLD key and re-encrypts it with
// the NEW key, so PIN_ENCRYPTION_KEY can actually be rotated without data loss. Run it,
// verify the report, THEN update the live PIN_ENCRYPTION_KEY env var to the new value and
// restart the server — not before, or new logins would decrypt against a key that no longer
// matches what's stored.
//
// Usage:
//   npx tsx src/scripts/rotatePinKey.ts --old=<32-byte-hex> --new=<32-byte-hex>
//   npx tsx src/scripts/rotatePinKey.ts --old=<32-byte-hex> --new=<32-byte-hex> --apply
//
// Dry-run by default (reports how many PINs would be re-encrypted, decrypts to verify the
// old key is actually correct, without writing anything). Pass --apply to write.
import 'dotenv/config';
import mongoose from 'mongoose';
import crypto from 'crypto';

function decrypt(encrypted: string, key: Buffer): string {
  const raw = Buffer.from(encrypted, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function encrypt(pin: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(pin, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function parseKey(hex: string | undefined, label: string): Buffer {
  if (!hex || hex.length !== 64) {
    throw new Error(`--${label} must be a 32-byte hex string (64 hex characters)`);
  }
  return Buffer.from(hex, 'hex');
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const oldHex = args.find((a) => a.startsWith('--old='))?.slice('--old='.length);
  const newHex = args.find((a) => a.startsWith('--new='))?.slice('--new='.length);

  const oldKey = parseKey(oldHex, 'old');
  const newKey = parseKey(newHex, 'new');
  if (oldHex === newHex) throw new Error('--old and --new keys are identical — nothing to rotate');

  const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/apsaraclean';
  await mongoose.connect(MONGODB_URI, { family: 4 });
  console.log('Connected to MongoDB');

  const users = mongoose.connection.collection('users');
  const staffWithPins = await users.find({ pin_encrypted: { $ne: null } }).toArray();

  console.log(`Found ${staffWithPins.length} staff account(s) with a PIN set.\n`);

  let decryptFailures = 0;
  const updates: { _id: mongoose.Types.ObjectId; newValue: string }[] = [];

  for (const doc of staffWithPins) {
    try {
      const plainPin = decrypt(doc.pin_encrypted, oldKey);
      const reEncrypted = encrypt(plainPin, newKey);
      updates.push({ _id: doc._id, newValue: reEncrypted });
    } catch (err: any) {
      decryptFailures++;
      console.error(`  FAILED to decrypt _id=${doc._id} (phone=${doc.phone ?? '?'}) with --old key: ${err.message}`);
    }
  }

  if (decryptFailures > 0) {
    console.error(
      `\n${decryptFailures} record(s) could not be decrypted with --old — this usually means --old is wrong. Aborting without writing anything.`
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`All ${updates.length} PIN(s) decrypted successfully with --old and re-encrypted with --new.`);

  if (!apply) {
    console.log('\nDry run only — no changes written. Re-run with --apply to write these changes.');
    console.log('After --apply succeeds, update the live PIN_ENCRYPTION_KEY env var to --new and restart the server.');
    await mongoose.disconnect();
    return;
  }

  for (const u of updates) {
    await users.updateOne({ _id: u._id }, { $set: { pin_encrypted: u.newValue } });
  }

  console.log(`\nRe-encrypted ${updates.length} PIN(s) with the new key.`);
  console.log('Now update PIN_ENCRYPTION_KEY to the --new value in .env and restart the server.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('PIN key rotation failed:', err);
  process.exit(1);
});
