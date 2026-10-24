import { env, isProd } from '../config/env.js';
import { setting as S, settingBool } from '../modules/settings/service.js';
import { fetchJson, type DonationLike, type InitiateContext, type PaymentProvider, type RefundResult, type StatusResult } from './types.js';

const baseUrl = () => process.env.MPESA_BASE_URL || (S('MPESA_ENV') === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke');

let token: { value: string; exp: number; key: string } | undefined;

async function accessToken(): Promise<string> {
  if (token && token.key === `${S('MPESA_ENV')}:${S('MPESA_CONSUMER_KEY')}` && token.exp > Date.now() + 30_000) return token.value;
  const auth = Buffer.from(`${S('MPESA_CONSUMER_KEY')}:${S('MPESA_CONSUMER_SECRET')}`).toString('base64');
  const r = await fetchJson(`${baseUrl()}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` } });
  const b = r.body as { access_token?: string; expires_in?: string | number };
  if (r.status !== 200 || !b?.access_token) throw new Error(`M-Pesa auth failed (HTTP ${r.status})`);
  token = { value: b.access_token, exp: Date.now() + Number(b.expires_in ?? 3599) * 1000, key: `${S('MPESA_ENV')}:${S('MPESA_CONSUMER_KEY')}` };
  return token.value;
}

export function resetMpesaToken() {
  token = undefined;
}

/** Daraja timestamps are East Africa Time (UTC+3), formatted YYYYMMDDHHmmss. */
export function darajaTimestamp(d = new Date()): string {
  return new Date(d.getTime() + 3 * 3600_000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function stkPassword(ts: string) {
  return Buffer.from(`${S('MPESA_SHORTCODE')}${S('MPESA_PASSKEY')}${ts}`).toString('base64');
}

export function mpesaCallbackUrl() {
  return `${env.API_BASE_URL}/api/payments/mpesa/callback/${S('MPESA_CALLBACK_TOKEN')}`;
}

/** STK result codes treated as definitive. Others remain pending for status query / reconciliation. */
const CANCELLED_CODES = new Set(['1032']);
const FAILED_CODES = new Set(['1', '1001', '1019', '1025', '1037', '2001', '9999', '1036', '1050']);

export function classifyStkResult(code: string | number | undefined): StatusResult['outcome'] {
  const c = String(code ?? '');
  if (c === '0') return 'SUCCESS';
  if (CANCELLED_CODES.has(c)) return 'CANCELLED';
  if (FAILED_CODES.has(c)) return 'FAILED';
  return 'UNKNOWN';
}

export const mpesaProvider: PaymentProvider = {
  id: 'mpesa',
  method: 'MPESA',
  label: 'M-Pesa',
  currency: 'KES',
  get mode() {
    return S('MPESA_ENV') === 'production' ? 'production' : 'sandbox';
  },
  requires: { phone: true },
  configured() {
    return Boolean(S('MPESA_CONSUMER_KEY') && S('MPESA_CONSUMER_SECRET') && S('MPESA_SHORTCODE') && S('MPESA_PASSKEY') && S('MPESA_CALLBACK_TOKEN') && S('MPESA_CALLBACK_TOKEN')!.length >= 24);
  },
  operational() {
    if (!this.configured()) return false;
    if (isProd) return S('MPESA_ENV') === 'production' && settingBool('MPESA_VERIFIED_OPERATIONAL');
    return true;
  },
  async initiate(d: DonationLike, ctx: InitiateContext) {
    if (d.currency !== 'KES' || d.amountCents % 100 !== 0) throw new Error('M-Pesa amounts must be whole Kenya shillings');
    const ts = darajaTimestamp();
    const r = await fetchJson(`${baseUrl()}/mpesa/stkpush/v1/processrequest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: S('MPESA_SHORTCODE'),
        Password: stkPassword(ts),
        Timestamp: ts,
        TransactionType: S('MPESA_TRANSACTION_TYPE') ?? 'CustomerPayBillOnline',
        Amount: d.amountCents / 100,
        PartyA: ctx.phone,
        PartyB: S('MPESA_PARTY_B') ?? S('MPESA_SHORTCODE'),
        PhoneNumber: ctx.phone,
        CallBackURL: mpesaCallbackUrl(),
        AccountReference: d.reference.slice(-12),
        TransactionDesc: 'Donation'
      })
    });
    const b = (r.body ?? {}) as Record<string, string>;
    const accepted = r.status === 200 && b.ResponseCode === '0' && Boolean(b.CheckoutRequestID);
    return {
      accepted,
      providerRequestId: b.CheckoutRequestID,
      providerSecondaryId: b.MerchantRequestID,
      customerMessage: accepted ? 'Check your phone and enter your M-Pesa PIN to complete the donation.' : undefined,
      responseCode: b.ResponseCode ?? b.errorCode ?? String(r.status),
      responseDescription: b.ResponseDescription ?? b.errorMessage ?? 'M-Pesa request was not accepted'
    };
  },
  async queryStatus(d: DonationLike): Promise<StatusResult> {
    if (!d.providerReference) return { outcome: 'UNKNOWN', detail: 'No CheckoutRequestID' };
    const ts = darajaTimestamp();
    const r = await fetchJson(`${baseUrl()}/mpesa/stkpushquery/v1/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ BusinessShortCode: S('MPESA_SHORTCODE'), Password: stkPassword(ts), Timestamp: ts, CheckoutRequestID: d.providerReference })
    });
    const b = (r.body ?? {}) as Record<string, string>;
    if (r.status !== 200 || b.ResponseCode !== '0') {
      // e.g. "The transaction is being processed" — not definitive.
      return { outcome: 'PENDING', detail: b.errorMessage ?? b.ResponseDescription ?? `HTTP ${r.status}`, code: b.errorCode };
    }
    return { outcome: classifyStkResult(b.ResultCode), detail: b.ResultDesc, code: String(b.ResultCode) };
  },
  async refund(d: DonationLike, amountCents: number, refundRef: string): Promise<RefundResult> {
    if (!S('MPESA_INITIATOR_NAME') || !S('MPESA_SECURITY_CREDENTIAL')) return { accepted: false, detail: 'M-Pesa reversal credentials are not configured' };
    if (!d.providerReceipt) return { accepted: false, detail: 'No M-Pesa receipt number on record' };
    const r = await fetchJson(`${baseUrl()}/mpesa/reversal/v1/request`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Initiator: S('MPESA_INITIATOR_NAME'),
        SecurityCredential: S('MPESA_SECURITY_CREDENTIAL'),
        CommandID: 'TransactionReversal',
        TransactionID: d.providerReceipt,
        Amount: amountCents / 100,
        ReceiverParty: S('MPESA_SHORTCODE'),
        RecieverIdentifierType: '11',
        ResultURL: `${env.API_BASE_URL}/api/payments/mpesa/reversal/${S('MPESA_CALLBACK_TOKEN')}/result`,
        QueueTimeOutURL: `${env.API_BASE_URL}/api/payments/mpesa/reversal/${S('MPESA_CALLBACK_TOKEN')}/timeout`,
        Remarks: `Refund ${refundRef}`.slice(0, 100),
        Occasion: d.reference.slice(0, 100)
      })
    });
    const b = (r.body ?? {}) as Record<string, string>;
    return { accepted: r.status === 200 && b.ResponseCode === '0', providerRefundId: b.ConversationID ?? b.OriginatorConversationID, detail: b.ResponseDescription ?? b.errorMessage };
  }
};

/** Requests an OAuth token with the configured credentials (Settings "Test" button). */
export async function testMpesaAuth() {
  resetMpesaToken();
  await accessToken();
  return { ok: true };
}
