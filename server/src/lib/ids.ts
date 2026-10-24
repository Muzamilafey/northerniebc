import crypto from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function shortCode(len = 8): string {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

export function datedReference(prefix: string, date = new Date()): string {
  const d = date.toISOString().slice(0, 10).replace(/-/g, '');
  return `${prefix}-${d}-${shortCode(6)}`;
}

export const uuid = () => crypto.randomUUID();
