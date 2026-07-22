import crypto from 'crypto';

// Staff PINs must be shown back to the owner on the Staff Page (per PRD), so unlike a
// password they can't be one-way hashed — they're reversibly encrypted instead with
// AES-256-GCM under a server-only key.
const KEY_HEX = process.env.PIN_ENCRYPTION_KEY;
if (!KEY_HEX || KEY_HEX.length !== 64) {
  throw new Error('PIN_ENCRYPTION_KEY environment variable must be set to a 32-byte hex string');
}
const KEY = Buffer.from(KEY_HEX, 'hex');

export function encryptPin(pin: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(pin, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decryptPin(encrypted: string): string {
  const raw = Buffer.from(encrypted, 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
