import crypto from 'node:crypto';
import { env, isProd } from '../config/env.js';
import { timingSafeEqualStr } from '../lib/crypto.js';
import { fetchJson, type DonationLike, type InitiateContext, type PaymentProvider, type RefundResult, type StatusResult } from './types.js';

const base = () => process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co';
const headers = () => ({ Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' });

/** Paystack signs webhooks with HMAC-SHA512 of the raw body using the secret key. */
export function verifyPaystackSignature(raw: Buffer, signature: string | undefined): boolean {
  if (!env.PAYSTACK_SECRET_KEY || !signature) return false;
  const expected = crypto.createHmac('sha512', env.PAYSTACK_SECRET_KEY).update(raw).digest('hex');
  return timingSafeEqualStr(expected, signature);
}

export const paystackProvider: PaymentProvider = {
  id: 'paystack',
  method: 'CARD',
  label: 'Card (via Paystack hosted checkout)',
  currency: 'KES',
  get mode() {
    return env.PAYSTACK_SECRET_KEY?.startsWith('sk_live_') ? 'production' : 'sandbox';
  },
  requires: { email: true },
  configured() {
    return Boolean(env.PAYSTACK_SECRET_KEY);
  },
  operational() {
    if (!this.configured()) return false;
    if (isProd) return this.mode === 'production' && env.PAYSTACK_VERIFIED_OPERATIONAL;
    return true;
  },
  async initiate(d: DonationLike, ctx: InitiateContext) {
    const r = await fetchJson(`${base()}/transaction/initialize`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ email: ctx.email, amount: d.amountCents, currency: d.currency, reference: d.reference, callback_url: ctx.returnUrl, channels: ['card'] })
    });
    const b = (r.body ?? {}) as { status?: boolean; message?: string; data?: { authorization_url?: string; reference?: string; access_code?: string } };
    const accepted = r.status === 200 && b.status === true && Boolean(b.data?.authorization_url);
    return { accepted, providerRequestId: b.data?.reference ?? d.reference, providerSecondaryId: b.data?.access_code, redirectUrl: b.data?.authorization_url, responseDescription: b.message };
  },
  async queryStatus(d: DonationLike): Promise<StatusResult> {
    const r = await fetchJson(`${base()}/transaction/verify/${encodeURIComponent(d.reference)}`, { headers: headers() });
    const b = (r.body ?? {}) as { status?: boolean; data?: { status?: string; amount?: number; currency?: string; id?: number; fees?: number; gateway_response?: string } };
    if (r.status !== 200 || !b.status || !b.data) return { outcome: 'UNKNOWN', detail: `HTTP ${r.status}` };
    const st = b.data.status;
    const outcome = st === 'success' ? 'SUCCESS' : st === 'failed' ? 'FAILED' : st === 'abandoned' ? 'CANCELLED' : 'PENDING';
    return { outcome, amountCents: b.data.amount, currency: b.data.currency, providerReceipt: b.data.id != null ? String(b.data.id) : undefined, feeCents: b.data.fees, detail: b.data.gateway_response };
  },
  async refund(d: DonationLike, amountCents: number): Promise<RefundResult> {
    const r = await fetchJson(`${base()}/refund`, { method: 'POST', headers: headers(), body: JSON.stringify({ transaction: d.reference, amount: amountCents }) });
    const b = (r.body ?? {}) as { status?: boolean; message?: string; data?: { id?: number; status?: string } };
    return { accepted: r.status === 200 && b.status === true, providerRefundId: b.data?.id != null ? String(b.data.id) : undefined, completed: b.data?.status === 'processed', detail: b.message };
  }
};
