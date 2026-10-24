import argon2 from 'argon2';

/** Argon2id with OWASP-recommended parameters (m=19 MiB, t=2, p=1). */
const OPTIONS: argon2.Options = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (pw: string) => argon2.hash(pw, OPTIONS);
export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}

/** Precomputed hash used to equalise timing when the account does not exist. */
let dummyHash: Promise<string> | undefined;
export const getDummyHash = () => (dummyHash ??= hashPassword('dummy-password-for-timing-equalisation'));

const COMMON = new Set([
  'password1234', 'password12345', '123456789012', 'qwertyuiop12', 'iloveyou1234', 'kenya1234567',
  'welcome12345', 'admin1234567', 'letmein12345', 'changeme1234', 'nairobi12345', 'password@123'
]);

export function passwordProblems(pw: string, context: string[] = []): string[] {
  const problems: string[] = [];
  if (pw.length < 12) problems.push('Password must be at least 12 characters long');
  if (pw.length > 256) problems.push('Password is too long');
  if (COMMON.has(pw.toLowerCase())) problems.push('Password is too common');
  const lower = pw.toLowerCase();
  for (const c of context) {
    if (c && c.length >= 4 && lower.includes(c.toLowerCase())) problems.push('Password must not contain your name or email');
  }
  if (new Set(pw).size < 5) problems.push('Password must contain more distinct characters');
  return problems;
}
