import { Router } from 'express';
import { z } from 'zod';
import { withTransaction } from '../../db/mongo.js';
import { recordAudit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/http.js';
import { can, inScope, type Permission } from '../../lib/permissions.js';
import { requireAuth, mfaSatisfied } from '../../middleware/auth.js';
import { Donation, PendingApproval, Refund, ResultSubmission, User, type Role } from '../../models/index.js';
import { providerById } from '../../payments/registry.js';
import type { AuthUser } from '../../types/express.js';
import { confirmDonation, failDonation, refundCompleted } from '../donations/service.js';
import { applyDecision } from '../results/service.js';

const PERM: Record<string, Permission> = { RESULT_CORRECTION: 'results.verify', MANUAL_RECONCILIATION: 'donations.reconcile', REFUND: 'donations.refund' };

async function asAuthUser(id: unknown): Promise<AuthUser> {
  const u = await User.findById(id).lean();
  if (!u) throw notFound('Requesting user not found');
  return { id: String(u._id), role: u.role as Role, fullName: u.fullName, sessionId: '', mfa: true, scope: { countyIds: (u.scope?.countyIds ?? []).map(String), constituencyIds: (u.scope?.constituencyIds ?? []).map(String) } };
}

/** Second-reviewer approvals for critical actions. The approver must differ from the requester. */
export function approvalsRouter() {
  const r = Router();

  r.get('/', requireAuth, async (req, res) => {
    const kinds = Object.entries(PERM).filter(([, p]) => can(req.user!, p)).map(([k]) => k);
    if (!kinds.length || !mfaSatisfied(req.user!)) throw forbidden();
    const q = parse(z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).default('PENDING') }).passthrough(), req.query);
    const items = await PendingApproval.find({ kind: { $in: kinds }, status: q.status }).populate('requestedBy', 'fullName role').populate('decidedBy', 'fullName role').sort({ createdAt: -1 }).limit(200).lean();
    res.json({ items });
  });

  r.post('/:id/:decision', requireAuth, async (req, res) => {
    const decision = parse(z.enum(['approve', 'reject']), req.params.decision);
    const { note } = parse(z.object({ note: z.string().min(5).max(2000) }), req.body);
    const approver = req.user!;
    const p = await PendingApproval.findById(String(req.params.id));
    if (!p) throw notFound();
    if (!can(approver, PERM[p.kind]!) || !mfaSatisfied(approver)) throw forbidden();
    if (String(p.requestedBy) === approver.id) throw forbidden('The second reviewer must be a different person');
    if (p.status !== 'PENDING') throw conflict('Already decided');
    const actor = { id: approver.id, role: approver.role, label: approver.fullName, ip: req.ip };

    // Claim the approval atomically so concurrent approvers cannot both apply it.
    const claimed = await PendingApproval.findOneAndUpdate(
      { _id: p._id, status: 'PENDING' },
      { $set: { status: decision === 'approve' ? 'APPROVED' : 'REJECTED', decidedBy: approver.id, decidedAt: new Date(), decisionNote: note } },
      { new: true }
    );
    if (!claimed) throw conflict('Already decided');

    let message: string | undefined;
    try {
      if (decision === 'reject') {
        if (p.kind === 'REFUND') await Refund.updateOne({ _id: p.entityId, status: 'AWAITING_APPROVAL' }, { $set: { status: 'REJECTED' } });
        await withTransaction((s) => recordAudit(s, { actor, action: `approval.rejected`, entityType: 'PendingApproval', entityId: String(p._id), meta: { kind: p.kind, note } }));
        return res.json({ status: 'REJECTED' });
      }

      if (p.kind === 'RESULT_CORRECTION') {
        const payload = p.payload as { submissionId: string; revision: number; decision: 'VERIFY' | 'REJECT'; note: string };
        const sub = await ResultSubmission.findOne({ submissionId: payload.submissionId }).lean();
        if (!sub || !inScope(approver, sub)) throw forbidden();
        if (String(sub.agentId) === approver.id) throw forbidden();
        await applyDecision(await asAuthUser(p.requestedBy), payload, approver, req.ip);
      } else if (p.kind === 'MANUAL_RECONCILIATION') {
        const payload = p.payload as { outcome: 'SUCCESSFUL' | 'FAILED'; providerReceipt?: string; evidenceFileId: string; note: string };
        const d = await Donation.findById(p.entityId).lean();
        if (!d) throw notFound();
        if (payload.outcome === 'SUCCESSFUL') {
          const out = await confirmDonation(d._id, { source: 'MANUAL_RECONCILIATION', providerReceipt: payload.providerReceipt, amountCents: d.amountCents, currency: d.currency }, actor);
          if (!out.confirmed) throw conflict(`Could not confirm: ${out.reason}`);
        } else {
          const ok = await failDonation(d._id, 'FAILED', `manual_reconciliation: ${payload.note}`, actor);
          if (!ok) throw conflict('Donation is no longer pending');
        }
      } else if (p.kind === 'REFUND') {
        const rf = await Refund.findById(p.entityId);
        if (!rf || rf.status !== 'AWAITING_APPROVAL') throw conflict('Refund not awaiting approval');
        const d = await Donation.findById(rf.donationId);
        if (!d) throw notFound();
        const provider = providerById(d.provider);
        if (!provider?.refund || !provider.configured()) throw badRequest('Provider refunds are not configured');
        const result = await provider.refund(d, rf.amountCents, String(rf._id));
        await withTransaction(async (s) => {
          rf.approvedBy = approver.id as never;
          rf.providerRefundId = result.providerRefundId;
          rf.providerResponse = { detail: result.detail, accepted: result.accepted };
          rf.status = result.accepted ? 'SUBMITTED' : 'FAILED';
          await rf.save({ session: s });
          if (result.accepted) {
            d.status = 'REFUND_PENDING';
            d.statusHistory.push({ status: 'REFUND_PENDING', at: new Date(), reason: `refund ${String(rf._id)} submitted` });
            await d.save({ session: s });
          }
          await recordAudit(s, { actor, action: result.accepted ? 'refund.submitted' : 'refund.provider_rejected', entityType: 'Refund', entityId: String(rf._id), meta: { detail: result.detail } });
        });
        if (result.accepted && result.completed) await refundCompleted(rf._id, { sync: true }, actor);
        if (!result.accepted) message = `Approved, but the provider rejected the refund: ${result.detail ?? 'unknown reason'}. No money has been returned.`;
      }
      await withTransaction((s) => recordAudit(s, { actor, action: 'approval.approved', entityType: 'PendingApproval', entityId: String(p._id), meta: { kind: p.kind, note } }));
      res.json({ status: 'APPROVED', message });
    } catch (err) {
      // Roll the claim back so the request can be retried or rejected.
      await PendingApproval.updateOne({ _id: p._id }, { $set: { status: 'PENDING' }, $unset: { decidedBy: 1, decidedAt: 1, decisionNote: 1 } });
      throw err;
    }
  });

  return r;
}
