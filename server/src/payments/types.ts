import type { PaymentMethod } from '../models/donations.js';

export interface DonationLike {
  _id: unknown;
  reference: string;
  amountCents: number;
  currency: string;
  providerReference?: string | null;
  providerReceipt?: string | null;
}

export interface InitiateContext {
  phone?: string;
  email?: string;
  returnUrl: string;
  cancelUrl: string;
}

export interface InitiateResult {
  accepted: boolean;
  providerRequestId?: string;
  providerSecondaryId?: string;
  /** For hosted checkout providers. */
  redirectUrl?: string;
  customerMessage?: string;
  responseCode?: string;
  responseDescription?: string;
}

export type ProviderOutcome = 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'PENDING' | 'UNKNOWN';

export interface StatusResult {
  outcome: ProviderOutcome;
  amountCents?: number;
  currency?: string;
  providerReceipt?: string;
  feeCents?: number;
  detail?: string;
  code?: string;
}

export interface RefundResult {
  accepted: boolean;
  providerRefundId?: string;
  /** True when the provider confirmed completion synchronously. */
  completed?: boolean;
  detail?: string;
}

export interface PaymentProvider {
  id: 'mpesa' | 'paystack' | 'paypal';
  method: PaymentMethod;
  label: string;
  currency: 'KES' | 'USD';
  mode: 'sandbox' | 'production';
  /** Credentials and callback configuration are present. */
  configured(): boolean;
  /**
   * May be offered to donors. In production this additionally requires the operator's explicit
   * attestation (…_VERIFIED_OPERATIONAL=true) that the live flow was tested end to end.
   */
  operational(): boolean;
  requires: { phone?: boolean; email?: boolean };
  initiate(d: DonationLike, ctx: InitiateContext): Promise<InitiateResult>;
  queryStatus(d: DonationLike): Promise<StatusResult>;
  refund?(d: DonationLike, amountCents: number, refundRef: string): Promise<RefundResult>;
}

export async function fetchJson(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 20000) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: res.status, body };
}
