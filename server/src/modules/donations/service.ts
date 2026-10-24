import { Types, type ClientSession } from 'mongoose';
import { env } from '../../config/env.js';
import { withTransaction } from '../../db/mongo.js';
import { recordAudit, type Actor } from '../../lib/audit.js';
import { blindIndex, decryptOptional, encryptOptional, randomToken, sha256 } from '../../lib/crypto.js';
import { badRequest, conflict, notFound, serviceUnavailable } from '../../lib/errors.js';
import { datedReference } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import { enqueueOutbox } from '../../lib/outbox.js';
import { Counter, Donation, DonationReceipt, PaymentCallback, PaymentTransaction, Refund, type DonationStatus, type PaymentMethod } from '../../models/index.js';
import { providerById, providerForMethod } from '../../payments/registry.js';
import { classifyStkResult } from '../../payments/mpesa.js';
import type { StatusResult } from '../../payments/types.js';
import { enqueueEmail } from '../notifications/service.js';
import { saveFile } from '../files/storage.js';
import { renderReceiptPdf, type ReceiptSnapshot } from './receipt.js';

export const TERMS_VERSION = '2026-10';

export function operatorConfigured() {
  return Boolean(env.OPERATOR_LEGAL_NAME && env.OPERATOR_CONTACT_EMAIL);
}

export function operatorInfo() {
  return {
    legalName: env.OPERATOR_LEGAL_NAME ?? null,
    email: env.OPERATOR_CONTACT_EMAIL ?? null,
    phone: env.OPERATOR_CONTACT_PHONE ?? null,
    address: env.OPERATOR_POSTAL_ADDRESS ?? null,
    registration: env.OPERATOR_REGISTRATION ?? null
  };
}

export interface CreateDonationInput {
  idempotencyKey: string;
  amount: number;
  method: PaymentMethod;
  phone?: string;
  name?: string;
  email?: string;
  message?: string;
  acknowledgement: 'NONE' | 'ANONYMOUS' | 'NAMED';
  goalId?: string;
}

function pushStatus(d: { status: DonationStatus; statusHistory: { status?: string | null; at?: Date | null; reason?: string | null }[] }, status: DonationStatus, reason: string) {
  d.status = status;
  d.statusHistory.push({ status, at: new Date(), reason });
}

export async function createDonation(input: CreateDonationInput, ctx: { ip?: string; ipHash?: string }) {
  if (!operatorConfigured()) throw serviceUnavailable('Donations are awaiting setup: the platform operator details have not been configured.');
  const provider = providerForMethod(input.method);
  if (!provider || !provider.operational()) throw badRequest('This payment method is not currently available');
  if (provider.requires.phone && !input.phone) throw badRequest('A mobile number is required for M-Pesa');
  if (provider.requires.email && !input.email) throw badRequest('An email address is required for card payments');
  if (input.acknowledgement === 'NAMED' && !input.name) throw badRequest('Provide a name to be acknowledged by name');

  const currency = provider.currency;
  const amountCents = Math.round(input.amount * 100);
  if (currency === 'KES') {
    if (!Number.isInteger(input.amount)) throw badRequest('Enter a whole number of Kenya shillings');
    if (input.amount < env.DONATION_MIN_KES || input.amount > env.DONATION_MAX_KES) throw badRequest(`Amount must be between KSh ${env.DONATION_MIN_KES} and KSh ${env.DONATION_MAX_KES}`);
  } else if (input.amount < 1 || input.amount > 10_000) throw badRequest('Amount must be between USD 1 and USD 10,000');

  const existing = await Donation.findOne({ idempotencyKey: input.idempotencyKey }).lean();
  if (existing) {
    if (existing.amountCents !== amountCents || existing.method !== input.method) throw conflict('Idempotency key reused with a different donation');
    return { donation: existing, replayed: true as const, statusToken: undefined, next: undefined };
  }

  const statusToken = randomToken(24);
  const reference = datedReference('NIE');
  const donation = await Donation.create({
    reference,
    idempotencyKey: input.idempotencyKey,
    amountCents,
    currency,
    method: input.method,
    provider: provider.id,
    providerMode: provider.mode,
    status: 'PENDING',
    statusHistory: [{ status: 'PENDING', at: new Date(), reason: 'created' }],
    donor: {
      nameEnc: encryptOptional(input.name),
      emailEnc: encryptOptional(input.email),
      phoneEnc: encryptOptional(input.phone),
      phoneIndex: input.phone ? blindIndex(input.phone) : undefined,
      message: input.message,
      acknowledgement: input.acknowledgement,
      consentAt: input.acknowledgement !== 'NONE' ? new Date() : undefined
    },
    goalId: input.goalId,
    termsVersion: TERMS_VERSION,
    statusTokenHash: sha256(statusToken),
    ipHash: ctx.ipHash
  });

  const returnUrl = `${env.PUBLIC_BASE_URL}/donate/status/${reference}?t=${statusToken}`;
  let result;
  try {
    result = await provider.initiate(donation, { phone: input.phone, email: input.email, returnUrl, cancelUrl: `${returnUrl}&cancelled=1` });
  } catch (err) {
    logger.error({ err: (err as Error).message, reference }, 'Payment initiation error');
    result = { accepted: false, responseDescription: 'Payment provider could not be reached' };
  }
  await PaymentTransaction.create({
    donationId: donation._id,
    provider: provider.id,
    kind: 'INITIATE',
    providerRequestId: result.providerRequestId,
    providerSecondaryId: result.providerSecondaryId,
    status: result.accepted ? 'ACCEPTED' : 'REJECTED',
    responseCode: result.responseCode,
    responseDescription: result.responseDescription?.slice(0, 500)
  });
  if (result.accepted) {
    // Accepted means "request queued", never "paid". The donation stays PENDING.
    donation.providerReference = result.providerRequestId;
    await donation.save();
  } else {
    pushStatus(donation, 'FAILED', `initiation_rejected: ${result.responseDescription ?? ''}`.slice(0, 200));
    await donation.save();
  }
  return {
    donation: donation.toObject(),
    replayed: false as const,
    statusToken,
    next: result.accepted
      ? result.redirectUrl
        ? { type: 'REDIRECT' as const, url: result.redirectUrl }
        : { type: 'STK_PUSH' as const, message: result.customerMessage ?? 'Complete the payment on your phone.' }
      : { type: 'FAILED' as const, message: 'The payment could not be started. No money has been taken. Please try again.' }
  };
}

async function nextReceiptNumber(s: ClientSession) {
  const year = new Date().getUTCFullYear();
  const c = await Counter.findOneAndUpdate({ _id: `receipt-${year}` }, { $inc: { seq: 1 } }, { upsert: true, new: true, session: s });
  return `NIE-R-${year}-${String(c!.seq).padStart(6, '0')}`;
}

/**
 * Marks a PENDING donation as SUCCESSFUL. Idempotent: the conditional update on status
 * guarantees a donation is confirmed (and receipted) at most once, however many callbacks arrive.
 */
export async function confirmDonation(
  donationId: Types.ObjectId | string,
  conf: { source: 'PROVIDER_CALLBACK' | 'PROVIDER_QUERY' | 'MANUAL_RECONCILIATION'; providerReceipt?: string; feeCents?: number; amountCents: number; currency: string },
  actor: Actor
): Promise<{ confirmed: boolean; reason?: string }> {
  return withTransaction(async (s) => {
    const d = await Donation.findById(donationId).session(s);
    if (!d) throw notFound();
    if (d.status === 'SUCCESSFUL') return { confirmed: false, reason: 'already_confirmed' };
    if (d.status !== 'PENDING' && !(conf.source === 'MANUAL_RECONCILIATION' && ['FAILED', 'EXPIRED', 'CANCELLED'].includes(d.status))) {
      return { confirmed: false, reason: `status_${d.status}` };
    }
    if (conf.amountCents !== d.amountCents || conf.currency !== d.currency) {
      d.needsReconciliation = true;
      d.statusHistory.push({ status: d.status, at: new Date(), reason: `amount_mismatch: provider ${conf.currency} ${conf.amountCents / 100}` });
      await d.save({ session: s });
      await recordAudit(s, { actor, action: 'donation.amount_mismatch', entityType: 'Donation', entityId: d.reference, meta: { expected: d.amountCents, received: conf.amountCents, currency: conf.currency } });
      return { confirmed: false, reason: 'amount_mismatch' };
    }
    if (conf.providerReceipt && (await Donation.exists({ providerReceipt: conf.providerReceipt, _id: { $ne: d._id } }).session(s))) {
      d.needsReconciliation = true;
      await d.save({ session: s });
      return { confirmed: false, reason: 'receipt_already_used' };
    }
    const prev = d.status;
    pushStatus(d, 'SUCCESSFUL', conf.source.toLowerCase());
    d.confirmedAt = new Date();
    d.confirmationSource = conf.source;
    d.providerReceipt = conf.providerReceipt;
    if (conf.feeCents != null) d.feeCents = conf.feeCents;
    d.needsReconciliation = false;

    const receiptNumber = await nextReceiptNumber(s);
    const accessToken = randomToken(24);
    const snapshot: ReceiptSnapshot = {
      receiptNumber,
      donationReference: d.reference,
      amount: d.amountCents / 100,
      currency: d.currency,
      confirmedAt: d.confirmedAt.toISOString(),
      paymentMethod: providerById(d.provider)?.label ?? d.method,
      providerReceipt: d.providerReceipt,
      paymentStatus: 'Payment received and confirmed by the payment provider',
      donorName: decryptOptional(d.donor?.nameEnc),
      operator: {
        legalName: env.OPERATOR_LEGAL_NAME!,
        email: env.OPERATOR_CONTACT_EMAIL,
        phone: env.OPERATOR_CONTACT_PHONE,
        address: env.OPERATOR_POSTAL_ADDRESS,
        registration: env.OPERATOR_REGISTRATION
      },
      taxWording: env.DONATION_TAX_WORDING
    };
    if (conf.source === 'MANUAL_RECONCILIATION') snapshot.paymentStatus = 'Payment received; confirmed through documented reconciliation with provider records';
    const [receipt] = await DonationReceipt.create([{ receiptNumber, donationId: d._id, snapshot, accessTokenHash: sha256(accessToken), issuedAt: new Date() }], { session: s });
    d.receiptId = receipt!._id;
    await d.save({ session: s });

    const email = decryptOptional(d.donor?.emailEnc);
    if (email) {
      const pdf = await renderReceiptPdf(snapshot);
      const file = await saveFile(pdf, { purpose: 'RECEIPT', allowed: ['application/pdf'], trusted: true, originalName: `${receiptNumber}.pdf` });
      await enqueueEmail(
        email,
        `Your donation receipt ${receiptNumber}`,
        [`Thank you for supporting The Northern IEBC.`, ``, `Amount: ${d.currency} ${(d.amountCents / 100).toFixed(2)}`, `Reference: ${d.reference}`, `Receipt: ${receiptNumber}`, ``, env.DONATION_TAX_WORDING].join('\n'),
        [{ filename: `${receiptNumber}.pdf`, fileId: file._id }],
        s
      );
    }
    await recordAudit(s, { actor, action: 'donation.confirmed', entityType: 'Donation', entityId: d.reference, before: { status: prev }, after: { status: 'SUCCESSFUL', receiptNumber }, meta: { source: conf.source } });
    await enqueueOutbox(s, 'donation.confirmed', { reference: d.reference });
    return { confirmed: true };
  });
}

export async function failDonation(donationId: Types.ObjectId | string, status: 'FAILED' | 'CANCELLED' | 'EXPIRED', reason: string, actor: Actor) {
  return withTransaction(async (s) => {
    const d = await Donation.findById(donationId).session(s);
    if (!d || d.status !== 'PENDING') return false;
    pushStatus(d, status, reason.slice(0, 200));
    d.needsReconciliation = false;
    await d.save({ session: s });
    await recordAudit(s, { actor, action: `donation.${status.toLowerCase()}`, entityType: 'Donation', entityId: d.reference, meta: { reason } });
    await enqueueOutbox(s, 'donation.status_changed', { reference: d.reference });
    return true;
  });
}

const SYSTEM: Actor = { label: 'payment-system' };

/** Applies a provider status result to a donation. Never marks success without a SUCCESS outcome. */
export async function applyProviderStatus(donationId: Types.ObjectId | string, st: StatusResult, source: 'PROVIDER_CALLBACK' | 'PROVIDER_QUERY') {
  const d = await Donation.findById(donationId).lean();
  if (!d) return { applied: false, reason: 'not_found' };
  switch (st.outcome) {
    case 'SUCCESS':
      return confirmDonation(d._id, { source, providerReceipt: st.providerReceipt, feeCents: st.feeCents, amountCents: st.amountCents ?? -1, currency: st.currency ?? d.currency }, SYSTEM).then((r) => ({ applied: r.confirmed, reason: r.reason }));
    case 'FAILED':
    case 'CANCELLED':
      return { applied: await failDonation(d._id, st.outcome, `${source}: ${st.detail ?? st.code ?? ''}`, SYSTEM) };
    default:
      return { applied: false, reason: 'pending' };
  }
}

/**
 * Handles an M-Pesa STK callback. The callback is stored first (deduplicated), validated
 * against the pending transaction and amount, and — because Daraja callbacks are unsigned —
 * success is confirmed with an STK status query before the donation is marked successful.
 */
export async function handleMpesaCallback(body: unknown, sourceIp: string | undefined, authenticity: 'PASSED' | 'FAILED') {
  const cb = (body as { Body?: { stkCallback?: Record<string, unknown> } })?.Body?.stkCallback;
  const checkoutId = typeof cb?.CheckoutRequestID === 'string' ? cb.CheckoutRequestID : undefined;
  const resultCode = cb?.ResultCode != null ? String(cb.ResultCode) : undefined;
  const dedupeKey = `mpesa:${checkoutId ?? sha256(JSON.stringify(body ?? null))}:${resultCode ?? 'x'}`;
  const items = ((cb?.CallbackMetadata as { Item?: { Name: string; Value?: unknown }[] } | undefined)?.Item ?? []).reduce<Record<string, unknown>>((a, i) => ((a[i.Name] = i.Value), a), {});
  const redacted = { CheckoutRequestID: checkoutId, MerchantRequestID: cb?.MerchantRequestID, ResultCode: resultCode, ResultDesc: cb?.ResultDesc, Amount: items.Amount, MpesaReceiptNumber: items.MpesaReceiptNumber, TransactionDate: items.TransactionDate };

  let record;
  try {
    record = await PaymentCallback.create({ provider: 'mpesa', dedupeKey, receivedAt: new Date(), sourceIp, authenticityCheck: authenticity, body: redacted });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return { duplicate: true };
    throw err;
  }
  if (authenticity === 'FAILED' || !checkoutId) {
    record.outcome = 'rejected';
    record.processed = true;
    await record.save();
    return { duplicate: false, outcome: 'rejected' };
  }
  return processMpesaCallback(record._id);
}

export async function processMpesaCallback(callbackId: Types.ObjectId) {
  const record = await PaymentCallback.findById(callbackId);
  if (!record || record.processed) return { duplicate: false, outcome: 'already_processed' };
  const b = record.body as { CheckoutRequestID?: string; ResultCode?: string; Amount?: number; MpesaReceiptNumber?: string; ResultDesc?: string };
  const txn = await PaymentTransaction.findOne({ provider: 'mpesa', kind: 'INITIATE', providerRequestId: b.CheckoutRequestID }).lean();
  const d = txn ? await Donation.findById(txn.donationId) : null;
  let outcome: string;
  if (!d) outcome = 'unknown_transaction';
  else {
    record.donationId = d._id;
    const provider = providerById('mpesa')!;
    const classified = b.ResultCode != null ? classifyStkResult(b.ResultCode) : 'UNKNOWN';
    if (classified === 'SUCCESS') {
      if (Math.round(Number(b.Amount) * 100) !== d.amountCents) {
        d.needsReconciliation = true;
        await d.save();
        outcome = 'amount_mismatch';
      } else {
        let confirmed = true;
        if (process.env.MPESA_SKIP_STATUS_QUERY !== '1') {
          const q = await provider.queryStatus(d).catch((e: Error) => ({ outcome: 'UNKNOWN' as const, detail: e.message }));
          confirmed = q.outcome === 'SUCCESS';
        }
        if (confirmed) {
          const r = await confirmDonation(d._id, { source: 'PROVIDER_CALLBACK', providerReceipt: b.MpesaReceiptNumber, amountCents: d.amountCents, currency: 'KES' }, SYSTEM);
          outcome = r.confirmed ? 'confirmed' : (r.reason ?? 'not_confirmed');
        } else {
          // Leave pending; the background job re-queries and escalates to manual reconciliation.
          outcome = 'awaiting_provider_confirmation';
          await PaymentCallback.updateOne({ _id: record._id }, { $set: { outcome, donationId: d._id } });
          return { duplicate: false, outcome };
        }
      }
    } else if (classified === 'CANCELLED' || classified === 'FAILED') {
      await failDonation(d._id, classified, `callback ${b.ResultCode}: ${b.ResultDesc ?? ''}`, SYSTEM);
      outcome = classified.toLowerCase();
    } else {
      outcome = 'unclassified_result';
      d.needsReconciliation = true;
      await d.save();
    }
  }
  record.outcome = outcome;
  record.processed = true;
  await record.save();
  return { duplicate: false, outcome };
}

/** Background job: re-query stale pending donations and escalate unresolved ones. */
export async function processPendingDonations() {
  // Callbacks stored but awaiting provider confirmation.
  const pendingCallbacks = await PaymentCallback.find({ provider: 'mpesa', processed: false, authenticityCheck: 'PASSED', receivedAt: { $lt: new Date(Date.now() - 60_000) } }).limit(50);
  for (const c of pendingCallbacks) await processMpesaCallback(c._id).catch((err) => logger.warn({ err: err.message }, 'Callback reprocess failed'));

  const stale = await Donation.find({
    status: 'PENDING',
    createdAt: { $lt: new Date(Date.now() - 2 * 60_000) },
    $or: [{ lastStatusQueryAt: null }, { lastStatusQueryAt: { $lt: new Date(Date.now() - 60_000) } }]
  }).limit(50);
  for (const d of stale) {
    const provider = providerById(d.provider);
    const ageMin = (Date.now() - d.createdAt.getTime()) / 60_000;
    let st: StatusResult = { outcome: 'UNKNOWN' };
    if (provider?.configured() && d.providerReference && d.statusQueryAttempts < 10) {
      st = await provider.queryStatus(d).catch((e: Error) => ({ outcome: 'UNKNOWN' as const, detail: e.message }));
      await PaymentTransaction.create({ donationId: d._id, provider: d.provider, kind: 'STATUS_QUERY', providerRequestId: d.providerReference, status: st.outcome === 'UNKNOWN' ? 'ERROR' : 'COMPLETED', responseCode: st.code, responseDescription: st.detail?.slice(0, 300) });
      await Donation.updateOne({ _id: d._id }, { $set: { lastStatusQueryAt: new Date() }, $inc: { statusQueryAttempts: 1 } });
    }
    if (st.outcome === 'SUCCESS' && d.provider === 'mpesa') {
      // STK query confirms success but carries no receipt/amount; find the stored callback.
      const cb = await PaymentCallback.findOne({ provider: 'mpesa', 'body.CheckoutRequestID': d.providerReference, 'body.ResultCode': '0' }).lean();
      const amt = Math.round(Number((cb?.body as { Amount?: number })?.Amount) * 100);
      if (cb && amt === d.amountCents) {
        await confirmDonation(d._id, { source: 'PROVIDER_QUERY', providerReceipt: (cb.body as { MpesaReceiptNumber?: string }).MpesaReceiptNumber, amountCents: amt, currency: 'KES' }, SYSTEM);
        await PaymentCallback.updateOne({ _id: cb._id }, { $set: { processed: true, outcome: 'confirmed_by_query' } });
      } else {
        await Donation.updateOne({ _id: d._id }, { $set: { needsReconciliation: true } });
      }
    } else if (st.outcome !== 'UNKNOWN' && st.outcome !== 'PENDING') {
      await applyProviderStatus(d._id, st, 'PROVIDER_QUERY');
    } else if (ageMin > env.DONATION_PENDING_TIMEOUT_MINUTES) {
      // Unresolved after the timeout: never assumed paid or unpaid; staff reconcile against provider statements.
      await Donation.updateOne({ _id: d._id, status: 'PENDING' }, { $set: { needsReconciliation: true } });
    }
  }
}

export async function refundCompleted(refundId: Types.ObjectId | string, providerResponse: unknown, actor: Actor) {
  return withTransaction(async (s) => {
    const r = await Refund.findById(refundId).session(s);
    if (!r || r.status !== 'SUBMITTED') return false;
    const d = await Donation.findById(r.donationId).session(s);
    if (!d) return false;
    r.status = 'COMPLETED';
    r.completedAt = new Date();
    r.providerResponse = providerResponse;
    await r.save({ session: s });
    d.refundedCents = (d.refundedCents ?? 0) + r.amountCents;
    pushStatus(d, d.refundedCents >= d.amountCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED', `refund ${String(r._id)} completed`);
    await d.save({ session: s });
    await recordAudit(s, { actor, action: 'refund.completed', entityType: 'Refund', entityId: String(r._id), after: { amountCents: r.amountCents, donation: d.reference } });
    await enqueueOutbox(s, 'donation.status_changed', { reference: d.reference });
    return true;
  });
}

export async function refundFailed(refundId: Types.ObjectId | string, detail: string, actor: Actor) {
  return withTransaction(async (s) => {
    const r = await Refund.findById(refundId).session(s);
    if (!r || r.status !== 'SUBMITTED') return false;
    r.status = 'FAILED';
    r.providerResponse = { detail };
    await r.save({ session: s });
    const d = await Donation.findById(r.donationId).session(s);
    if (d && d.status === 'REFUND_PENDING') {
      pushStatus(d, d.refundedCents > 0 ? 'PARTIALLY_REFUNDED' : 'SUCCESSFUL', `refund ${String(r._id)} failed`);
      await d.save({ session: s });
    }
    await recordAudit(s, { actor, action: 'refund.failed', entityType: 'Refund', entityId: String(r._id), meta: { detail } });
    return true;
  });
}
