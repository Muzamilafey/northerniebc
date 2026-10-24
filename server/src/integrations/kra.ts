import { setting } from '../modules/settings/service.js';
import { fetchJson } from '../payments/types.js';

/**
 * KRA PIN Checker (by ID) client. Credentials come from the admin Settings page or .env.
 * Sandbox: https://sbx.kra.go.ke. For production, set KRA_BASE_URL to the URL KRA issues.
 */
export const kraBaseUrl = () => setting('KRA_BASE_URL') ?? (setting('KRA_ENV') === 'production' ? undefined : 'https://sbx.kra.go.ke');
export const kraConfigured = () => Boolean(kraBaseUrl() && setting('KRA_CONSUMER_KEY') && setting('KRA_CONSUMER_SECRET'));

let token: { value: string; exp: number; key: string } | undefined;

async function accessToken(): Promise<string> {
  const key = `${kraBaseUrl()}|${setting('KRA_CONSUMER_KEY')}`;
  if (token && token.key === key && token.exp > Date.now() + 30_000) return token.value;
  const basic = Buffer.from(`${setting('KRA_CONSUMER_KEY')}:${setting('KRA_CONSUMER_SECRET')}`).toString('base64');
  const r = await fetchJson(`${kraBaseUrl()}/v1/token/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${basic}` }, timeoutMs: 15000 });
  const b = (r.body ?? {}) as { access_token?: string; expires_in?: string | number; errorMessage?: string };
  if (r.status !== 200 || !b.access_token) throw new KraError('AUTH', b.errorMessage ?? `KRA authorisation failed (HTTP ${r.status})`);
  token = { value: b.access_token, exp: Date.now() + Number(b.expires_in ?? 3599) * 1000, key };
  return token.value;
}

export class KraError extends Error {
  constructor(public kind: 'AUTH' | 'INVALID_ID' | 'BAD_REQUEST' | 'UNAVAILABLE', message: string) {
    super(message);
  }
}

export interface PinCheckResult {
  pin: string;
  name: string;
}

/** Looks up a Kenyan resident's KRA PIN and registered name by national ID number. */
export async function checkPinById(idNumber: string, taxpayerType: 'KE' | 'NKE' | 'NKENR' | 'COMP' = 'KE'): Promise<PinCheckResult> {
  if (!kraConfigured()) throw new KraError('UNAVAILABLE', 'KRA PIN Checker is not configured');
  let r;
  try {
    r = await fetchJson(`${kraBaseUrl()}/checker/v1/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await accessToken()}` },
      body: JSON.stringify({ TaxpayerType: taxpayerType, TaxpayerID: idNumber }),
      timeoutMs: 15000
    });
  } catch (e) {
    if (e instanceof KraError) throw e;
    throw new KraError('UNAVAILABLE', 'KRA service could not be reached');
  }
  const b = (r.body ?? {}) as { TaxpayerPIN?: string; TaxpayerName?: string; ErrorCode?: string; errorCode?: string; ErrorMessage?: string; errorMessage?: string };
  if (r.status === 200 && b.TaxpayerPIN && b.TaxpayerName) return { pin: b.TaxpayerPIN.trim(), name: b.TaxpayerName.replace(/\s+/g, ' ').trim() };
  const code = String(b.ErrorCode ?? b.errorCode ?? r.status);
  if (code === '30002') throw new KraError('INVALID_ID', 'The ID number could not be verified with KRA');
  if (code === '400') throw new KraError('BAD_REQUEST', b.ErrorMessage ?? b.errorMessage ?? 'Invalid request');
  if (r.status === 401) {
    token = undefined;
    throw new KraError('AUTH', 'KRA rejected the platform credentials');
  }
  throw new KraError('UNAVAILABLE', `KRA service error (${code})`);
}

/** Verifies the stored credentials by requesting a token (used by the Settings "Test" button). */
export async function testKraCredentials() {
  token = undefined;
  await accessToken();
  return { ok: true };
}

export function resetKraToken() {
  token = undefined;
}

/** "JOHN KAMAU MWANGI" -> "J*** K**** M*****". */
export function maskName(name: string) {
  return name
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0] + '*'.repeat(Math.max(2, w.length - 1)))
    .join(' ');
}
