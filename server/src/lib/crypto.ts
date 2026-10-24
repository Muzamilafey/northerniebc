import crypto from 'node:crypto';
import { env } from '../config/env.js';

const encKey = Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64');
const blindKey = Buffer.from(env.BLIND_INDEX_KEY, 'base64');

/** AES-256-GCM field encryption. Output: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(payload: string): string {
  const [v, iv, tag, ct] = payload.split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unsupported ciphertext format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

export const encryptOptional = (v?: string | null) => (v ? encrypt(v) : undefined);
export const decryptOptional = (v?: string | null) => (v ? decrypt(v) : undefined);

/** Deterministic keyed hash, used to look up encrypted values without decrypting. */
export function blindIndex(value: string): string {
  return crypto.createHmac('sha256', blindKey).update(value.trim().toLowerCase()).digest('hex');
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Stable JSON serialisation (sorted keys) so hashes are reproducible. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const v = value as Record<string, unknown>;
    if (typeof (v as { toHexString?: unknown }).toHexString === 'function') {
      return (v as unknown as { toHexString(): string }).toHexString();
    }
    return Object.keys(v)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        if (v[k] !== undefined) acc[k] = sortKeys(v[k]);
        return acc;
      }, {});
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Masks a phone number for display, e.g. 2547******89. */
export function maskPhone(phone?: string | null): string | undefined {
  if (!phone) return undefined;
  if (phone.length <= 6) return '****';
  return phone.slice(0, 4) + '*'.repeat(phone.length - 6) + phone.slice(-2);
}
