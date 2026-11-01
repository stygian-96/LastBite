import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

const IV_LEN = 12;
const TAG_LEN = 16;

function key(): Buffer {
  const k = Buffer.from(env().ENCRYPTION_KEY, 'base64');
  if (k.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes, base64 encoded');
  return k;
}

/** AES-256-GCM. Output layout: IV (12) + auth tag (16) + ciphertext. */
export function encrypt(plain: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decrypt(data: Buffer): string {
  const iv = data.subarray(0, IV_LEN);
  const tag = data.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const body = data.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function mac(id: string): string {
  return createHmac('sha256', env().SESSION_SECRET).update(id).digest('base64url');
}

/** Returns `<id>.<hmac>`. */
export function signAnonId(id: string): string {
  return `${id}.${mac(id)}`;
}

/** Returns the id when the signature is valid, otherwise null. */
export function verifyAnonId(signed: string): string | null {
  const dot = signed.lastIndexOf('.');
  if (dot <= 0) return null;
  const id = signed.slice(0, dot);
  const given = Buffer.from(signed.slice(dot + 1));
  const expected = Buffer.from(mac(id));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return id;
}
