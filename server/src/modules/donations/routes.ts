import express, { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { setting } from '../settings/service.js';
import { withTransaction } from '../../db/mongo.js';
import { recordAudit, recordAuditStandalone } from '../../lib/audit.js';
import { cached } from '../../lib/cache.js';
import { decryptOptional, maskPhone, sha256, timingSafeEqualStr } from '../../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { pageParams, parse } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { enqueueOutbox } from '../../lib/outbox.js';
import { requirePermission } from '../../middleware/auth.js';
import { donationLimiter, ipHash, limiter } from '../../middleware/security.js';
import {
  CONFIRMED_STATUSES,
  Donation,
  DonationReceipt,
  DonationReport,
  DONATION_STATUSES,
  FundraisingGoal,
  OperatingExpenditure,
  PAYMENT_METHODS,
  PaymentCallback,
  PaymentTransaction,
  PendingApproval,
  Refund,
  StoredFile
} from '../../models/index.js';
import { paypalProvider } from '../../payments/paypal.js';
import { verifyPaystackSignature } from '../../payments/paystack.js';
import { allProviders, providerById } from '../../payments/registry.js';
import { kenyanPhone, objectId } from '../users/routes.js';
import { renderReceiptPdf, type ReceiptSnapshot } from './receipt.js';
import {
  applyProviderStatus,
  createDonation,
  handleMpesaCallback,
  operatorConfigured,
  operatorInfo,
  refundCompleted,
  refundFailed,
  TERMS_VERSION
} from './service.js';

const SYSTEM = { label: 'payment-system' };

function publicStatus(d: { reference: string; status: string; amountCents: number; currency: string; method: string; confirmedAt?: Date | null; needsReconciliation?: boolean | null; createdAt?: Date }) {
  const messages: Record<string, string> = {
    PENDING: d.needsReconciliation
      ? 'We have not yet received a final confirmation from the payment provider. Your payment is being reconciled; do not pay again.'
      : 'Waiting for confirmation from the payment provider.',
    SUCCESSFUL: 'Payment confirmed. Thank you for your support.',
    FAILED: 'The payment did not go through. No money was received.',
    CANCELLED: 'The payment was cancelled. No money was received.',
    EXPIRED: 'The payment request expired. No money was received.',
    REFUND_PENDING: 'A refund is being processed.',
    PARTIALLY_REFUNDED: 'Part of this donation has been refunded.',
    REFUNDED: 'This donation has been refunded.',
    DISPUTED: 'This payment is under dispute with the provider.'
  };
  return { reference: d.reference, status: d.status, amount: d.amountCents / 100, currency: d.currency, method: d.method, confirmedAt: d.confirmedAt ?? null, message: messages[d.status], createdAt: d.createdAt };
}

/** Aggregated public figures. Only confirmed donations are counted; refunds and fees are shown separately. */
export async function donationTotals(from?: Date, to?: Date) {
  const match: Record<string, unknown> = { status: { $in: CONFIRMED_STATUSES } };
  if (from || to) match.confirmedAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) };
  const rows = await Donation.aggregate<{ _id: string; gross: number; fees: number; feesKnown: number; refunds: number; count: number }>([
    { $match: match },
    {
      $group: {
        _id: '$currency',
        gross: { $sum: '$amountCents' },
        fees: { $sum: { $ifNull: ['$feeCents', 0] } },
        feesKnown: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$feeCents', null] }, null] }, 1, 0] } },
        refunds: { $sum: '$refundedCents' },
        count: { $sum: 1 }
      }
    }
  ]);
  return rows.map((r) => ({
    currency: r._id,
    count: r.count,
    gross: r.gross / 100,
    paymentFees: r.fees / 100,
    feesRecordedFor: r.feesKnown,
    refunds: r.refunds / 100,
    net: (r.gross - r.fees - r.refunds) / 100
  }));
}

export function donationsPublicRouter() {
  const r = Router();

  r.get('/config', (_req, res) => {
    const providers = allProviders();
    res.json({
      accepting: operatorConfigured() && providers.some((p) => p.operational()),
      operatorConfigured: operatorConfigured(),
      operator: operatorInfo(),
      presetsKes: env.DONATION_PRESETS_KES.split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0),
      minKes: env.DONATION_MIN_KES,
      maxKes: env.DONATION_MAX_KES,
      methods: providers.map((p) => ({ method: p.method, label: p.label, currency: p.currency, operational: p.operational(), mode: p.mode, requires: p.requires })),
      recurringAvailable: false,
      termsVersion: TERMS_VERSION,
      taxWording: env.DONATION_TAX_WORDING,
      statusNote: operatorConfigured() ? undefined : 'Donations are awaiting setup. The legal operator and payment provider must be configured before payments can be accepted.'
    });
  });

  r.post('/', donationLimiter(), async (req, res) => {
    const body = parse(
      z.object({
        idempotencyKey: z.string().uuid(),
        amount: z.number().positive().max(1_000_000),
        method: z.enum(PAYMENT_METHODS),
        phone: kenyanPhone.optional(),
        name: z.string().trim().min(2).max(120).optional(),
        email: z.string().email().max(200).optional(),
        message: z.string().max(500).optional(),
        acknowledgement: z.enum(['NONE', 'ANONYMOUS', 'NAMED']).default('NONE'),
        goalId: objectId.optional(),
        acceptTerms: z.literal(true),
        termsVersion: z.literal(TERMS_VERSION)
      }),
      req.body
    );
    if (body.goalId && !(await FundraisingGoal.exists({ _id: body.goalId, active: true }))) throw badRequest('Unknown fundraising goal');
    const out = await createDonation(body, { ip: req.ip, ipHash: ipHash(req) });
    if (out.replayed) {
      return res.status(200).json({ donation: publicStatus(out.donation as never), replayed: true, message: 'This donation was already started. Check its status using the link you received.' });
    }
    res.status(201).json({ donation: publicStatus(out.donation as never), statusToken: out.statusToken, next: out.next });
  });

  async function loadWithToken(reference: string, token: unknown) {
    if (typeof token !== 'string' || token.length < 20) throw notFound();
    const d = await Donation.findOne({ reference });
    if (!d || !timingSafeEqualStr(d.statusTokenHash, sha256(token))) throw notFound();
    return d;
  }

  r.get('/:reference/status', limiter('donation-status', { windowMs: 60_000, limit: 60 }), async (req, res) => {
    const d = await loadWithToken(String(req.params.reference), req.query.t);
    // For hosted checkouts, the donor's return triggers a server-side verification with the provider.
    if (d.status === 'PENDING' && d.provider !== 'mpesa' && (!d.lastStatusQueryAt || Date.now() - d.lastStatusQueryAt.getTime() > 10_000)) {
      const provider = providerById(d.provider);
      if (provider?.configured()) {
        d.lastStatusQueryAt = new Date();
        await d.save();
        const st = d.provider === 'paypal' ? await paypalProvider.capture(d).catch(() => ({ outcome: 'UNKNOWN' as const })) : await provider.queryStatus(d).catch(() => ({ outcome: 'UNKNOWN' as const }));
        await applyProviderStatus(d._id, st, 'PROVIDER_QUERY');
      }
    }
    const fresh = await Donation.findById(d._id).populate('receiptId', 'receiptNumber issuedAt').lean();
    res.json({
      donation: publicStatus(fresh as never),
      receipt: fresh!.receiptId && fresh!.status !== 'PENDING' ? { receiptNumber: (fresh!.receiptId as unknown as { receiptNumber: string }).receiptNumber } : null
    });
  });

  r.get('/:reference/receipt.pdf', limiter('receipt', { windowMs: 60_000, limit: 20 }), async (req, res) => {
    const d = await loadWithToken(String(req.params.reference), req.query.t);
    if (!d.receiptId || !CONFIRMED_STATUSES.includes(d.status)) throw notFound('No receipt is available for this donation');
    const receipt = await DonationReceipt.findById(d.receiptId).lean();
    if (!receipt) throw notFound();
    const pdf = await renderReceiptPdf(receipt.snapshot as ReceiptSnapshot);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${receipt.receiptNumber}.pdf"`, 'Cache-Control': 'private, no-store' });
    res.send(pdf);
  });

  r.get('/public/summary', async (_req, res) => {
    res.json(
      await cached('donations:summary', 15_000, async () => {
        const now = new Date();
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const [allTime, thisMonth, goals, expenditure, reports, acks] = await Promise.all([
          donationTotals(),
          donationTotals(monthStart),
          FundraisingGoal.find({ active: true }).sort({ periodEnd: 1 }).lean(),
          OperatingExpenditure.aggregate<{ _id: string; total: number; n: number }>([{ $match: { published: true } }, { $group: { _id: '$category', total: { $sum: '$amountCents' }, n: { $sum: 1 } } }]),
          DonationReport.find().sort({ periodEnd: -1 }).select('title periodStart periodEnd totals publishedAt').lean(),
          Donation.aggregate<{ _id: string; n: number }>([{ $match: { status: { $in: CONFIRMED_STATUSES }, 'donor.acknowledgement': { $in: ['ANONYMOUS', 'NAMED'] } } }, { $group: { _id: '$donor.acknowledgement', n: { $sum: 1 } } }])
        ]);
        const goalProgress = [];
        for (const g of goals) {
          const match: Record<string, unknown> = { status: { $in: CONFIRMED_STATUSES }, currency: 'KES', confirmedAt: { $gte: g.periodStart, $lt: g.periodEnd } };
          if (g.restricted) match.goalId = g._id;
          const [agg] = await Donation.aggregate<{ total: number }>([{ $match: match }, { $group: { _id: null, total: { $sum: { $subtract: ['$amountCents', '$refundedCents'] } } } }]);
          const raised = (agg?.total ?? 0) / 100;
          goalProgress.push({
            id: String(g._id),
            title: g.title,
            category: g.category,
            description: g.description,
            targetKes: g.targetCents / 100,
            raisedKes: raised,
            percent: Math.min(100, Math.round((raised / (g.targetCents / 100)) * 1000) / 10),
            periodStart: g.periodStart,
            periodEnd: g.periodEnd,
            restricted: g.restricted,
            basis: g.restricted ? 'Donations designated to this restricted goal' : 'All confirmed KES donations in the goal period (donations support overall operations; this is not a separate account)'
          });
        }
        const kesNet = allTime.find((t) => t.currency === 'KES')?.net ?? 0;
        const totalExpenditure = expenditure.reduce((a, e) => a + e.total, 0) / 100;
        return {
          totals: allTime,
          currentMonth: { from: monthStart, totals: thisMonth },
          goals: goalProgress,
          expenditure: { publishedTotalKes: totalExpenditure, byCategory: expenditure.map((e) => ({ category: e._id, totalKes: e.total / 100, entries: e.n })) },
          availableBalance:
            expenditure.length > 0
              ? { kes: Math.round((kesNet - totalExpenditure) * 100) / 100, formula: 'Net confirmed KES donations − published operating expenditure (all periods)', note: 'Calculated only from published records; excludes other income and unpublished costs.' }
              : null,
          acknowledgements: Object.fromEntries(acks.map((a) => [a._id, a.n])),
          reports,
          note: 'Totals include only payments confirmed by the payment provider. Pending and failed payments are excluded.',
          generatedAt: new Date()
        };
      })
    );
  });

  r.get('/public/acknowledgements', async (_req, res) => {
    const items = await Donation.find({ status: { $in: CONFIRMED_STATUSES }, 'donor.acknowledgement': 'NAMED' }).sort({ confirmedAt: -1 }).limit(200).select('donor.nameEnc confirmedAt').lean();
    res.json({ items: items.map((d) => ({ name: decryptOptional(d.donor?.nameEnc), month: d.confirmedAt?.toISOString().slice(0, 7) })) });
  });

  return r;
}

/** Provider callbacks/webhooks. Mounted before the JSON body parser so raw bodies are available. */
export function paymentCallbacksRouter() {
  const r = Router();
  const allowedIps = () => (setting('MPESA_ALLOWED_CALLBACK_IPS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  r.post('/mpesa/callback/:token', express.json({ limit: '32kb' }), async (req, res) => {
    const cbToken = setting('MPESA_CALLBACK_TOKEN');
    const tokenOk = Boolean(cbToken) && timingSafeEqualStr(String(req.params.token), cbToken!);
    const ips = allowedIps();
    const ipOk = ips.length === 0 || ips.includes(req.ip ?? '');
    if (!tokenOk) return res.status(404).end();
    try {
      const out = await handleMpesaCallback(req.body, req.ip, ipOk ? 'PASSED' : 'FAILED');
      logger.info({ outcome: out.outcome, duplicate: out.duplicate }, 'M-Pesa callback handled');
    } catch (err) {
      logger.error({ err }, 'M-Pesa callback processing error');
    }
    // Always acknowledge so Safaricom does not retry indefinitely; processing state is stored.
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  });

  r.post('/mpesa/reversal/:token/:kind', express.json({ limit: '32kb' }), async (req, res) => {
    const cbToken = setting('MPESA_CALLBACK_TOKEN');
    if (!cbToken || !timingSafeEqualStr(String(req.params.token), cbToken)) return res.status(404).end();
    const result = (req.body as { Result?: { ResultCode?: number | string; ResultDesc?: string; ConversationID?: string; OriginatorConversationID?: string } })?.Result;
    const conv = result?.ConversationID ?? result?.OriginatorConversationID;
    const dedupeKey = `mpesa-reversal:${conv ?? sha256(JSON.stringify(req.body ?? null))}:${result?.ResultCode ?? req.params.kind}`;
    try {
      await PaymentCallback.create({ provider: 'mpesa', dedupeKey, receivedAt: new Date(), sourceIp: req.ip, authenticityCheck: 'PASSED', body: { kind: req.params.kind, ...result } });
      const refund = conv ? await Refund.findOne({ providerRefundId: conv, status: 'SUBMITTED' }) : null;
      if (refund) {
        if (req.params.kind === 'result' && String(result?.ResultCode) === '0') await refundCompleted(refund._id, result, SYSTEM);
        else await refundFailed(refund._id, result?.ResultDesc ?? String(req.params.kind), SYSTEM);
      }
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) logger.error({ err }, 'Reversal callback error');
    }
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  });

  r.post('/paystack/webhook', express.raw({ type: '*/*', limit: '64kb' }), async (req, res) => {
    const raw = req.body as Buffer;
    const ok = verifyPaystackSignature(raw, req.headers['x-paystack-signature'] as string | undefined);
    if (!ok) return res.status(401).end();
    const evt = JSON.parse(raw.toString('utf8')) as { event?: string; data?: { reference?: string; id?: number; transaction_reference?: string; status?: string } };
    const dedupeKey = `paystack:${evt.event}:${evt.data?.id ?? evt.data?.reference}`;
    try {
      await PaymentCallback.create({ provider: 'paystack', dedupeKey, receivedAt: new Date(), sourceIp: req.ip, authenticityCheck: 'PASSED', body: { event: evt.event, reference: evt.data?.reference, id: evt.data?.id, status: evt.data?.status } });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return res.status(200).end();
      throw err;
    }
    if (evt.event === 'charge.success' && evt.data?.reference) {
      const d = await Donation.findOne({ reference: evt.data.reference, provider: 'paystack' });
      // Re-verify with the API rather than trusting the webhook body.
      if (d) await applyProviderStatus(d._id, await providerById('paystack')!.queryStatus(d), 'PROVIDER_CALLBACK');
    }
    if (evt.event === 'refund.processed' && evt.data?.id != null) {
      const refund = await Refund.findOne({ providerRefundId: String(evt.data.id), status: 'SUBMITTED' });
      if (refund) await refundCompleted(refund._id, { event: evt.event }, SYSTEM);
    }
    res.status(200).end();
  });

  r.post('/paypal/webhook', express.json({ limit: '64kb' }), async (req, res) => {
    const evt = req.body as { id?: string; event_type?: string; resource?: { id?: string; supplementary_data?: { related_ids?: { order_id?: string } } } };
    const ok = await paypalProvider.verifyWebhook(req.headers as Record<string, string>, evt).catch(() => false);
    if (!ok) return res.status(401).end();
    try {
      await PaymentCallback.create({ provider: 'paypal', dedupeKey: `paypal:${evt.id}`, receivedAt: new Date(), sourceIp: req.ip, authenticityCheck: 'PASSED', body: { event_type: evt.event_type, resource_id: evt.resource?.id } });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return res.status(200).end();
      throw err;
    }
    const orderId = evt.resource?.supplementary_data?.related_ids?.order_id;
    if (orderId && (evt.event_type === 'PAYMENT.CAPTURE.COMPLETED' || evt.event_type === 'PAYMENT.CAPTURE.DENIED')) {
      const d = await Donation.findOne({ provider: 'paypal', providerReference: orderId });
      if (d) await applyProviderStatus(d._id, await paypalProvider.queryStatus(d), 'PROVIDER_CALLBACK');
    }
    if (evt.event_type === 'PAYMENT.CAPTURE.REFUNDED' && evt.resource?.id) {
      const refund = await Refund.findOne({ providerRefundId: evt.resource.id, status: 'SUBMITTED' });
      if (refund) await refundCompleted(refund._id, { event: evt.event_type }, SYSTEM);
    }
    res.status(200).end();
  });

  return r;
}

export function donationsAdminRouter() {
  const r = Router();
  const view = requirePermission('donations.view');
  const reconcile = requirePermission('donations.reconcile');
  const refund = requirePermission('donations.refund');
  const configure = requirePermission('donations.configure');
  const actorOf = (req: express.Request) => ({ id: req.user!.id, role: req.user!.role, label: req.user!.fullName, ip: req.ip });

  r.get('/summary', view, async (_req, res) => {
    const [byStatus, byMonth, byMethod, totals, reconciliation, receiptsMissing, goals] = await Promise.all([
      Donation.aggregate([{ $group: { _id: '$status', n: { $sum: 1 }, amount: { $sum: '$amountCents' } } }]),
      Donation.aggregate([{ $match: { status: { $in: CONFIRMED_STATUSES } } }, { $group: { _id: { month: { $dateToString: { format: '%Y-%m', date: '$confirmedAt' } }, currency: '$currency' }, gross: { $sum: '$amountCents' }, n: { $sum: 1 } } }, { $sort: { '_id.month': 1 } }]),
      Donation.aggregate([{ $match: { status: { $in: CONFIRMED_STATUSES } } }, { $group: { _id: { method: '$method', currency: '$currency' }, gross: { $sum: '$amountCents' }, n: { $sum: 1 } } }]),
      donationTotals(),
      Donation.countDocuments({ needsReconciliation: true }),
      Donation.countDocuments({ status: { $in: CONFIRMED_STATUSES }, receiptId: null }),
      FundraisingGoal.find().sort({ periodEnd: -1 }).lean()
    ]);
    res.json({ byStatus, byMonth, byMethod, totals, reconciliationDiscrepancies: reconciliation, confirmedWithoutReceipt: receiptsMissing, goals, providers: allProviders().map((p) => ({ id: p.id, method: p.method, mode: p.mode, configured: p.configured(), operational: p.operational() })) });
  });

  r.get('/', view, async (req, res) => {
    const q = parse(z.object({ status: z.enum(DONATION_STATUSES).optional(), method: z.enum(PAYMENT_METHODS).optional(), reconciliation: z.enum(['true']).optional(), reference: z.string().max(40).optional() }).passthrough(), req.query);
    const { page, limit, skip } = pageParams(req.query, 200);
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.method) filter.method = q.method;
    if (q.reconciliation) filter.needsReconciliation = true;
    if (q.reference) filter.reference = q.reference;
    const [items, total] = await Promise.all([
      Donation.find(filter).select('-donor.nameEnc -donor.emailEnc -donor.phoneEnc -donor.phoneIndex -statusTokenHash -idempotencyKey -ipHash').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Donation.countDocuments(filter)
    ]);
    res.json({ items, total, page, limit });
  });

  r.get('/:id', view, async (req, res) => {
    const d = await Donation.findById(String(req.params.id)).populate('receiptId', 'receiptNumber issuedAt emailedAt').lean();
    if (!d) throw notFound();
    const [txns, callbacks, refunds, approvals] = await Promise.all([
      PaymentTransaction.find({ donationId: d._id }).sort({ createdAt: 1 }).lean(),
      PaymentCallback.find({ donationId: d._id }).sort({ receivedAt: 1 }).lean(),
      Refund.find({ donationId: d._id }).sort({ createdAt: -1 }).lean(),
      PendingApproval.find({ entityId: String(d._id) }).sort({ createdAt: -1 }).lean()
    ]);
    await recordAuditStandalone({ actor: actorOf(req), action: 'donation.viewed', entityType: 'Donation', entityId: d.reference });
    const { statusTokenHash: _s, idempotencyKey: _i, ipHash: _ip, ...rest } = d;
    res.json({
      donation: {
        ...rest,
        donor: {
          name: decryptOptional(d.donor?.nameEnc) ?? null,
          email: decryptOptional(d.donor?.emailEnc) ?? null,
          phoneMasked: maskPhone(decryptOptional(d.donor?.phoneEnc)) ?? null,
          message: d.donor?.message,
          acknowledgement: d.donor?.acknowledgement
        }
      },
      transactions: txns,
      callbacks,
      refunds,
      approvals
    });
  });

  r.post('/:id/requery', reconcile, async (req, res) => {
    const d = await Donation.findById(String(req.params.id));
    if (!d) throw notFound();
    const provider = providerById(d.provider);
    if (!provider?.configured()) throw badRequest('Provider not configured');
    const st = await provider.queryStatus(d);
    await PaymentTransaction.create({ donationId: d._id, provider: d.provider, kind: 'STATUS_QUERY', providerRequestId: d.providerReference, status: 'COMPLETED', responseCode: st.code, responseDescription: st.detail?.slice(0, 300), responseSummary: { outcome: st.outcome } });
    const applied = d.provider === 'mpesa' && st.outcome === 'SUCCESS' ? { applied: false, reason: 'mpesa_success_requires_callback_or_reconciliation' } : await applyProviderStatus(d._id, st, 'PROVIDER_QUERY');
    await recordAuditStandalone({ actor: actorOf(req), action: 'donation.requeried', entityType: 'Donation', entityId: d.reference, meta: { outcome: st.outcome } });
    res.json({ providerOutcome: st.outcome, ...applied });
  });

  /**
   * Manual reconciliation never takes effect directly: it creates a request that a second
   * authorised person must approve, citing provider evidence.
   */
  r.post('/:id/reconcile', reconcile, async (req, res) => {
    const body = parse(
      z.object({
        outcome: z.enum(['SUCCESSFUL', 'FAILED']),
        providerReceipt: z.string().min(4).max(60).optional(),
        evidenceFileId: objectId,
        note: z.string().min(20).max(2000)
      }),
      req.body
    );
    const d = await Donation.findById(String(req.params.id));
    if (!d) throw notFound();
    if (!['PENDING', 'FAILED', 'EXPIRED', 'CANCELLED'].includes(d.status)) throw conflict(`Cannot reconcile a ${d.status} donation`);
    if (body.outcome === 'SUCCESSFUL' && !body.providerReceipt) throw badRequest('Provide the provider transaction reference from the provider statement');
    const ev = await StoredFile.findOne({ _id: body.evidenceFileId, purpose: 'RECONCILIATION_EVIDENCE' }).lean();
    if (!ev) throw badRequest('Upload the provider statement or evidence first');
    if (await PendingApproval.exists({ kind: 'MANUAL_RECONCILIATION', entityId: String(d._id), status: 'PENDING' })) throw conflict('A reconciliation request is already pending');
    const p = await withTransaction(async (s) => {
      const [a] = await PendingApproval.create([{ kind: 'MANUAL_RECONCILIATION', entityId: String(d._id), payload: body, reason: body.note, requestedBy: req.user!.id }], { session: s });
      await recordAudit(s, { actor: actorOf(req), action: 'donation.reconciliation_requested', entityType: 'Donation', entityId: d.reference, meta: body });
      return a!;
    });
    res.status(202).json({ approvalId: String(p._id), message: 'Awaiting approval by a second authorised person.' });
  });

  r.post('/:id/refunds', refund, async (req, res) => {
    const body = parse(z.object({ amount: z.number().positive(), reason: z.string().min(10).max(1000) }), req.body);
    const d = await Donation.findById(String(req.params.id));
    if (!d) throw notFound();
    if (!['SUCCESSFUL', 'PARTIALLY_REFUNDED'].includes(d.status)) throw conflict('Only confirmed donations can be refunded');
    const cents = Math.round(body.amount * 100);
    const pending = await Refund.aggregate<{ t: number }>([{ $match: { donationId: d._id, status: { $in: ['AWAITING_APPROVAL', 'SUBMITTED'] } } }, { $group: { _id: null, t: { $sum: '$amountCents' } } }]);
    if (cents + (d.refundedCents ?? 0) + (pending[0]?.t ?? 0) > d.amountCents) throw badRequest('Refund exceeds the refundable amount');
    const provider = providerById(d.provider);
    if (!provider?.refund) throw badRequest('This provider does not support refunds through the platform');
    const out = await withTransaction(async (s) => {
      const [rf] = await Refund.create([{ donationId: d._id, amountCents: cents, reason: body.reason, requestedBy: req.user!.id }], { session: s });
      const [a] = await PendingApproval.create([{ kind: 'REFUND', entityId: String(rf!._id), payload: { donationId: String(d._id), amountCents: cents }, reason: body.reason, requestedBy: req.user!.id }], { session: s });
      await recordAudit(s, { actor: actorOf(req), action: 'refund.requested', entityType: 'Refund', entityId: String(rf!._id), after: { amountCents: cents, donation: d.reference }, meta: { reason: body.reason } });
      return { refundId: String(rf!._id), approvalId: String(a!._id) };
    });
    res.status(202).json({ ...out, message: 'Refund awaiting approval by a second authorised person. It will be processed through the payment provider.' });
  });

  // ---- Goals, expenditure and reports ----
  const goalBody = z.object({
    title: z.string().min(3).max(200),
    category: z.enum(['HOSTING', 'ELECTION_DATA', 'BUDGET_RESEARCH', 'PUBLIC_REPORTING', 'SECURITY_MAINTENANCE', 'ACCESSIBILITY_OUTREACH', 'GENERAL']),
    description: z.string().max(2000).optional(),
    targetKes: z.number().positive(),
    periodStart: z.coerce.date(),
    periodEnd: z.coerce.date(),
    restricted: z.boolean().default(false),
    active: z.boolean().default(true)
  });

  r.post('/goals', configure, async (req, res) => {
    const b = parse(goalBody, req.body);
    if (b.periodEnd <= b.periodStart) throw badRequest('Period end must be after start');
    const { targetKes, ...rest } = b;
    const g = await withTransaction(async (s) => {
      const [doc] = await FundraisingGoal.create([{ ...rest, targetCents: Math.round(targetKes * 100), createdBy: req.user!.id }], { session: s });
      await recordAudit(s, { actor: actorOf(req), action: 'goal.created', entityType: 'FundraisingGoal', entityId: String(doc!._id), after: b });
      return doc!;
    });
    res.status(201).json({ goal: g });
  });

  r.patch('/goals/:id', configure, async (req, res) => {
    const b = parse(goalBody.partial(), req.body);
    const g = await FundraisingGoal.findById(String(req.params.id));
    if (!g) throw notFound();
    const before = g.toObject();
    const { targetKes, ...rest } = b;
    await withTransaction(async (s) => {
      g.set({ ...rest, ...(targetKes ? { targetCents: Math.round(targetKes * 100) } : {}) });
      await g.save({ session: s });
      await recordAudit(s, { actor: actorOf(req), action: 'goal.updated', entityType: 'FundraisingGoal', entityId: String(g._id), before, after: b });
    });
    res.json({ goal: g });
  });

  r.get('/expenditure/list', view, async (_req, res) => {
    res.json({ items: await OperatingExpenditure.find().sort({ spentOn: -1 }).lean() });
  });

  r.post('/expenditure', configure, async (req, res) => {
    const b = parse(
      z.object({
        category: z.enum(['HOSTING', 'ELECTION_DATA', 'BUDGET_RESEARCH', 'PUBLIC_REPORTING', 'SECURITY_MAINTENANCE', 'ACCESSIBILITY_OUTREACH', 'PAYMENT_FEES', 'ADMINISTRATION', 'OTHER']),
        description: z.string().min(3).max(500),
        amountKes: z.number().positive(),
        spentOn: z.coerce.date(),
        goalId: objectId.optional(),
        documentFileId: objectId.optional(),
        documentReference: z.string().min(2).max(200)
      }),
      req.body
    );
    const { amountKes, ...rest } = b;
    const e = await withTransaction(async (s) => {
      const [doc] = await OperatingExpenditure.create([{ ...rest, amountCents: Math.round(amountKes * 100), createdBy: req.user!.id }], { session: s });
      await recordAudit(s, { actor: actorOf(req), action: 'expenditure.created', entityType: 'OperatingExpenditure', entityId: String(doc!._id), after: b });
      return doc!;
    });
    res.status(201).json({ expenditure: e });
  });

  r.post('/expenditure/:id/publish', configure, async (req, res) => {
    const e = await OperatingExpenditure.findById(String(req.params.id));
    if (!e) throw notFound();
    if (String(e.createdBy) === req.user!.id && env.FOUR_EYES_IMPORTS) throw forbidden('A different person must publish this expenditure record');
    await withTransaction(async (s) => {
      e.published = true;
      await e.save({ session: s });
      await recordAudit(s, { actor: actorOf(req), action: 'expenditure.published', entityType: 'OperatingExpenditure', entityId: String(e._id) });
      await enqueueOutbox(s, 'donation.status_changed', {});
    });
    res.json({ expenditure: e });
  });

  r.post('/reports', configure, async (req, res) => {
    const b = parse(z.object({ title: z.string().min(3).max(200), periodStart: z.coerce.date(), periodEnd: z.coerce.date(), narrative: z.string().max(10000).optional() }), req.body);
    const totals = await donationTotals(b.periodStart, b.periodEnd);
    const exp = await OperatingExpenditure.aggregate([{ $match: { published: true, spentOn: { $gte: b.periodStart, $lt: b.periodEnd } } }, { $group: { _id: '$category', totalCents: { $sum: '$amountCents' } } }]);
    const rep = await withTransaction(async (s) => {
      const [doc] = await DonationReport.create([{ ...b, totals: { donations: totals, expenditure: exp.map((x) => ({ category: x._id, totalKes: x.totalCents / 100 })) }, publishedAt: new Date(), publishedBy: req.user!.id }], { session: s });
      await recordAudit(s, { actor: actorOf(req), action: 'donation_report.published', entityType: 'DonationReport', entityId: String(doc!._id), after: { title: b.title } });
      return doc!;
    });
    res.status(201).json({ report: rep });
  });

  return r;
}
