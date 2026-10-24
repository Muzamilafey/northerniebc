import { env, isProd } from '../config/env.js';
import { fetchJson, type DonationLike, type InitiateContext, type PaymentProvider, type RefundResult, type StatusResult } from './types.js';

const base = () => process.env.PAYPAL_BASE_URL || (env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');

let token: { value: string; exp: number } | undefined;
async function accessToken() {
  if (token && token.exp > Date.now() + 30_000) return token.value;
  const auth = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetchJson(`${base()}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  const b = r.body as { access_token?: string; expires_in?: number };
  if (r.status !== 200 || !b?.access_token) throw new Error(`PayPal auth failed (HTTP ${r.status})`);
  token = { value: b.access_token, exp: Date.now() + (b.expires_in ?? 300) * 1000 };
  return token.value;
}
const authHeaders = async () => ({ Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' });

interface Capture {
  id: string;
  status: string;
  amount?: { value: string; currency_code: string };
  seller_receivable_breakdown?: { paypal_fee?: { value: string } };
}

function captureFrom(order: { purchase_units?: { payments?: { captures?: Capture[] } }[] }): Capture | undefined {
  return order.purchase_units?.[0]?.payments?.captures?.[0];
}

function toStatus(order: { status?: string; purchase_units?: { payments?: { captures?: Capture[] } }[] }): StatusResult {
  const cap = captureFrom(order);
  if (order.status === 'COMPLETED' && cap?.status === 'COMPLETED') {
    return {
      outcome: 'SUCCESS',
      amountCents: Math.round(Number(cap.amount?.value) * 100),
      currency: cap.amount?.currency_code,
      providerReceipt: cap.id,
      feeCents: cap.seller_receivable_breakdown?.paypal_fee ? Math.round(Number(cap.seller_receivable_breakdown.paypal_fee.value) * 100) : undefined
    };
  }
  if (cap?.status === 'DECLINED' || cap?.status === 'FAILED') return { outcome: 'FAILED', detail: cap.status };
  if (order.status === 'VOIDED') return { outcome: 'CANCELLED' };
  return { outcome: 'PENDING', detail: order.status };
}

export const paypalProvider: PaymentProvider & {
  capture(d: DonationLike): Promise<StatusResult>;
  verifyWebhook(headers: Record<string, string | undefined>, event: unknown): Promise<boolean>;
} = {
  id: 'paypal',
  method: 'PAYPAL',
  label: 'PayPal',
  /** PayPal does not settle in KES; PayPal donations are taken in USD. */
  currency: 'USD',
  get mode() {
    return env.PAYPAL_ENV === 'live' ? 'production' : 'sandbox';
  },
  requires: {},
  configured() {
    return Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET && env.PAYPAL_WEBHOOK_ID);
  },
  operational() {
    if (!this.configured()) return false;
    if (isProd) return env.PAYPAL_ENV === 'live' && env.PAYPAL_VERIFIED_OPERATIONAL;
    return true;
  },
  async initiate(d: DonationLike, ctx: InitiateContext) {
    const r = await fetchJson(`${base()}/v2/checkout/orders`, {
      method: 'POST',
      headers: { ...(await authHeaders()), 'PayPal-Request-Id': d.reference },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{ reference_id: d.reference, custom_id: d.reference, description: 'Donation to The Northern IEBC', amount: { currency_code: 'USD', value: (d.amountCents / 100).toFixed(2) } }],
        payment_source: { paypal: { experience_context: { return_url: ctx.returnUrl, cancel_url: ctx.cancelUrl, shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' } } }
      })
    });
    const b = (r.body ?? {}) as { id?: string; links?: { rel: string; href: string }[]; message?: string };
    const link = b.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
    return { accepted: (r.status === 200 || r.status === 201) && Boolean(b.id && link), providerRequestId: b.id, redirectUrl: link?.href, responseDescription: b.message };
  },
  async queryStatus(d: DonationLike) {
    if (!d.providerReference) return { outcome: 'UNKNOWN' as const };
    const r = await fetchJson(`${base()}/v2/checkout/orders/${encodeURIComponent(d.providerReference)}`, { headers: await authHeaders() });
    if (r.status !== 200) return { outcome: 'UNKNOWN' as const, detail: `HTTP ${r.status}` };
    return toStatus(r.body as never);
  },
  async capture(d: DonationLike) {
    const r = await fetchJson(`${base()}/v2/checkout/orders/${encodeURIComponent(d.providerReference!)}/capture`, {
      method: 'POST',
      headers: { ...(await authHeaders()), 'PayPal-Request-Id': `${d.reference}-capture` }
    });
    if (r.status !== 200 && r.status !== 201) {
      // Already captured, or not approved yet: fall back to reading the order.
      return this.queryStatus(d);
    }
    return toStatus(r.body as never);
  },
  async refund(d: DonationLike, amountCents: number, refundRef: string): Promise<RefundResult> {
    const r = await fetchJson(`${base()}/v2/payments/captures/${encodeURIComponent(d.providerReceipt!)}/refund`, {
      method: 'POST',
      headers: { ...(await authHeaders()), 'PayPal-Request-Id': refundRef },
      body: JSON.stringify({ amount: { value: (amountCents / 100).toFixed(2), currency_code: 'USD' }, note_to_payer: 'Refund of donation' })
    });
    const b = (r.body ?? {}) as { id?: string; status?: string; message?: string };
    return { accepted: r.status === 200 || r.status === 201, providerRefundId: b.id, completed: b.status === 'COMPLETED', detail: b.message ?? b.status };
  },
  async verifyWebhook(h, event) {
    const r = await fetchJson(`${base()}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: await authHeaders(),
      body: JSON.stringify({
        auth_algo: h['paypal-auth-algo'],
        cert_url: h['paypal-cert-url'],
        transmission_id: h['paypal-transmission-id'],
        transmission_sig: h['paypal-transmission-sig'],
        transmission_time: h['paypal-transmission-time'],
        webhook_id: env.PAYPAL_WEBHOOK_ID,
        webhook_event: event
      })
    });
    return r.status === 200 && (r.body as { verification_status?: string })?.verification_status === 'SUCCESS';
  }
};
