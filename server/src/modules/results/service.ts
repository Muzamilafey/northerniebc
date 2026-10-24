import { Types, type ClientSession } from 'mongoose';
import { withTransaction } from '../../db/mongo.js';
import { recordAudit } from '../../lib/audit.js';
import { canonicalJson, sha256 } from '../../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { shortCode, uuid } from '../../lib/ids.js';
import { enqueueOutbox } from '../../lib/outbox.js';
import { inScope } from '../../lib/permissions.js';
import {
  AgentAssignment,
  Election,
  PendingApproval,
  PollingStation,
  ResultSubmission,
  StationResult,
  StoredFile,
  SubmissionRevision,
  VerificationDecision,
  type Position,
  type PublicResultStatus
} from '../../models/index.js';
import type { AuthUser } from '../../types/express.js';
import { eligibleCandidates } from '../elections/service.js';
import { reconcile, sameFigures, type ResultFields } from './reconciliation.js';

export const DECLARATION_TEXT =
  'I declare that the figures entered are a true transcription of the official results declared at this polling station, and that I have not altered any figure.';

export interface SubmitInput {
  idempotencyKey: string;
  electionId: string;
  pollingStationId: string;
  position: Position;
  candidateVotes: { candidateId: string; votes: number }[];
  fields: ResultFields;
  formReference?: string;
  evidenceFileIds: string[];
  declarationAccepted: boolean;
  clientCreatedAt?: Date;
  clientDeviceId?: string;
  /** The revision the client last saw from the server; null for a first submission. */
  baseRevision: number | null;
  correctionReason?: string;
}

export interface Receipt {
  receiptId: string;
  submissionId: string;
  revision: number;
  serverReceivedAt: Date;
  payloadHash: string;
  status: string;
  reconciliationIssues: { rule: string; message: string }[];
  replayed: boolean;
}

function payloadForHash(i: SubmitInput, agentId: string, prevRevisionHash: string | null) {
  return {
    electionId: i.electionId,
    pollingStationId: i.pollingStationId,
    position: i.position,
    agentId,
    candidateVotes: [...i.candidateVotes].sort((a, b) => a.candidateId.localeCompare(b.candidateId)),
    fields: i.fields,
    formReference: i.formReference ?? null,
    evidenceFileIds: [...i.evidenceFileIds].sort(),
    correctionReason: i.correctionReason ?? null,
    prevRevisionHash
  };
}

/** Request fingerprint independent of server state, used to validate idempotent replays. */
function requestFingerprint(i: SubmitInput, agentId: string) {
  return sha256(canonicalJson({ ...payloadForHash(i, agentId, null), baseRevision: i.baseRevision }));
}

async function findReplay(i: SubmitInput, agent: AuthUser): Promise<Receipt | null> {
  const existing = await SubmissionRevision.findOne({ idempotencyKey: i.idempotencyKey }).lean();
  if (!existing) return null;
  const sub = await ResultSubmission.findOne({ submissionId: existing.submissionId }).lean();
  if (String(existing.agentId) !== agent.id || !sub) throw conflict('Idempotency key already used');
  const fp = requestFingerprint(i, agent.id);
  const storedFp = existing.requestFingerprint;
  if (storedFp && storedFp !== fp) throw conflict('Idempotency key reused with a different payload');
  return {
    receiptId: existing.receiptId,
    submissionId: existing.submissionId,
    revision: existing.revision,
    serverReceivedAt: existing.serverReceivedAt,
    payloadHash: existing.payloadHash,
    status: sub.status,
    reconciliationIssues: (existing.reconciliationIssues ?? []).map((x) => ({ rule: x.rule ?? '', message: x.message ?? '' })),
    replayed: true
  };
}

export async function submitResult(agent: AuthUser, i: SubmitInput, ip?: string, ipHash?: string): Promise<Receipt> {
  if (agent.role !== 'AGENT') throw forbidden('Only polling-station agents submit results');
  const replay = await findReplay(i, agent);
  if (replay) return replay;

  if (!i.declarationAccepted) throw badRequest('The agent declaration must be accepted');
  const election = await Election.findById(i.electionId).lean();
  if (!election) throw notFound('Election not found');
  if (election.status !== 'ACTIVE') throw unprocessable('This election is not accepting submissions');
  const posCfg = election.positions.find((p) => p.position === i.position && p.enabled);
  if (!posCfg) throw unprocessable('This position is not enabled for the election');

  const assignment = await AgentAssignment.findOne({ userId: agent.id, electionId: i.electionId, pollingStationId: i.pollingStationId, active: true }).lean();
  if (!assignment) throw forbidden('You are not assigned to this polling station');
  const station = await PollingStation.findById(i.pollingStationId).lean();
  if (!station || !station.active) throw notFound('Polling station not found');

  // Candidate list must be exactly the eligible ballot for this station and position.
  const eligible = await eligibleCandidates(station, i.position);
  if (eligible.length === 0) throw unprocessable('No candidates are configured for this position at this station');
  const eligibleIds = new Set(eligible.map((c) => String(c._id)));
  const seen = new Set<string>();
  for (const cv of i.candidateVotes) {
    if (!eligibleIds.has(cv.candidateId)) throw badRequest('A candidate is not on the ballot for this station and position');
    if (seen.has(cv.candidateId)) throw badRequest('Duplicate candidate in submission');
    seen.add(cv.candidateId);
  }
  if (seen.size !== eligibleIds.size) throw badRequest('Votes must be entered for every candidate on the ballot (use 0 where applicable)');

  if (posCfg.requireEvidence && i.evidenceFileIds.length === 0) throw badRequest('A photo or scan of the results form is required');
  if (i.evidenceFileIds.length) {
    const files = await StoredFile.find({ _id: { $in: i.evidenceFileIds }, purpose: 'RESULT_EVIDENCE', uploadedBy: agent.id }).lean();
    if (files.length !== new Set(i.evidenceFileIds).size) throw badRequest('Evidence files not found or not uploaded by you');
    if (files.some((f) => f.scanStatus === 'INFECTED')) throw badRequest('Evidence file failed malware scanning');
  }

  const issues = reconcile({
    candidateVotes: i.candidateVotes,
    fields: i.fields,
    rules: posCfg.rules as never,
    requiredFields: posCfg.requiredFields as never,
    stationRegisteredVoters: station.registeredVoters
  });

  try {
    return await withTransaction(async (s) => {
      const now = new Date();
      let sub = await ResultSubmission.findOne({ electionId: i.electionId, pollingStationId: i.pollingStationId, position: i.position, agentId: agent.id }).session(s);
      let revision: number;
      let prevHash: string | null = null;
      if (!sub) {
        if (i.baseRevision != null) throw conflict('No earlier submission exists on the server for this draft', { serverRevision: null });
        revision = 1;
        [sub] = await ResultSubmission.create(
          [
            {
              submissionId: uuid(),
              electionId: i.electionId,
              pollingStationId: station._id,
              countyId: station.countyId,
              constituencyId: station.constituencyId,
              wardId: station.wardId,
              position: i.position,
              agentId: agent.id,
              status: 'SUBMITTED',
              currentRevision: 1,
              flags: issues.map((x) => x.rule),
              lastServerReceivedAt: now
            }
          ],
          { session: s }
        );
      } else {
        if (i.baseRevision !== sub.currentRevision) {
          throw conflict('The server has a newer version of this result. Review it and resolve the conflict explicitly.', { serverRevision: sub.currentRevision });
        }
        if (!i.correctionReason || i.correctionReason.trim().length < 5) throw badRequest('A correction reason is required to amend a submitted result');
        const prev = await SubmissionRevision.findOne({ submissionId: sub.submissionId, revision: sub.currentRevision }).session(s).lean();
        prevHash = prev?.payloadHash ?? null;
        revision = sub.currentRevision + 1;
        sub.currentRevision = revision;
        sub.status = 'SUBMITTED';
        sub.flags = issues.map((x) => x.rule);
        sub.lastServerReceivedAt = now;
        await sub.save({ session: s });
      }

      const payloadHash = sha256(canonicalJson(payloadForHash(i, agent.id, prevHash)));
      const receiptId = `RCPT-${shortCode(10)}`;
      await SubmissionRevision.create(
        [
          {
            submissionId: sub!.submissionId,
            revision,
            idempotencyKey: i.idempotencyKey,
            requestFingerprint: requestFingerprint(i, agent.id),
            candidateVotes: i.candidateVotes,
            fields: i.fields,
            formReference: i.formReference,
            evidenceFileIds: i.evidenceFileIds,
            declarationAccepted: true,
            declarationText: DECLARATION_TEXT,
            correctionReason: i.correctionReason,
            clientCreatedAt: i.clientCreatedAt,
            clientDeviceId: i.clientDeviceId,
            serverReceivedAt: now,
            agentId: agent.id,
            reconciliationIssues: issues,
            payloadHash,
            prevRevisionHash: prevHash,
            receiptId,
            ipHash
          }
        ],
        { session: s }
      );

      await refreshStationResult(s, {
        electionId: i.electionId,
        pollingStationId: i.pollingStationId,
        position: i.position,
        station,
        changedSubmissionId: sub!.submissionId
      });
      const finalSub = await ResultSubmission.findById(sub!._id).session(s).lean();

      await recordAudit(s, {
        actor: { id: agent.id, role: agent.role, label: agent.fullName, ip },
        action: revision === 1 ? 'result.submitted' : 'result.amended',
        entityType: 'ResultSubmission',
        entityId: sub!.submissionId,
        after: { revision, payloadHash, candidateVotes: i.candidateVotes, fields: i.fields },
        meta: { receiptId, correctionReason: i.correctionReason, issues: issues.length }
      });
      await enqueueOutbox(s, 'results.submission', {
        electionId: i.electionId,
        countyId: String(station.countyId),
        constituencyId: String(station.constituencyId),
        pollingStationId: i.pollingStationId,
        position: i.position,
        submissionId: sub!.submissionId,
        revision
      });

      return {
        receiptId,
        submissionId: sub!.submissionId,
        revision,
        serverReceivedAt: now,
        payloadHash,
        status: finalSub!.status,
        reconciliationIssues: issues,
        replayed: false
      };
    });
  } catch (err) {
    // A concurrent retry with the same idempotency key may have won the race.
    if ((err as { code?: number }).code === 11000) {
      const again = await findReplay(i, agent);
      if (again) return again;
    }
    throw err;
  }
}

interface RefreshArgs {
  electionId: string | Types.ObjectId;
  pollingStationId: string | Types.ObjectId;
  position: Position;
  station: { _id: unknown; countyId: unknown; constituencyId: unknown; wardId: unknown };
  changedSubmissionId: string;
}

/**
 * Recomputes the accepted station result after a submission changes. Rules:
 *  - a VERIFIED (or official-matched) station result is never replaced automatically;
 *  - otherwise the accepted result follows the earliest non-rejected submission;
 *  - disagreeing submissions mark the station as conflicted and hide provisional figures.
 */
async function refreshStationResult(s: ClientSession, a: RefreshArgs) {
  const subs = await ResultSubmission.find({ electionId: a.electionId, pollingStationId: a.pollingStationId, position: a.position, status: { $ne: 'REJECTED' } })
    .sort({ createdAt: 1 })
    .session(s);
  const latest = await Promise.all(
    subs.map(async (sub) => ({
      sub,
      rev: (await SubmissionRevision.findOne({ submissionId: sub.submissionId, revision: sub.currentRevision }).session(s).lean())!
    }))
  );
  const existing = await StationResult.findOne({ electionId: a.electionId, pollingStationId: a.pollingStationId, position: a.position }).session(s);
  const locked = existing && ['VERIFIED', 'MATCHED_OFFICIAL', 'OFFICIAL'].includes(existing.status);

  if (latest.length === 0) {
    if (existing && !locked) await StationResult.deleteOne({ _id: existing._id }, { session: s });
    return;
  }

  const reference = locked ? { candidateVotes: existing!.candidateVotes, fields: existing!.fields } : latest[0]!.rev;
  const conflicting = latest.filter((l) => !sameFigures(reference as never, l.rev as never));
  const hasConflict = conflicting.length > 0;

  for (const l of latest) {
    const flag = !sameFigures(reference as never, l.rev as never) || (hasConflict && l === latest[0]);
    if (l.sub.hasConflict !== flag) {
      l.sub.hasConflict = flag;
      await l.sub.save({ session: s });
    }
  }

  if (locked) {
    existing!.hasConflict = hasConflict;
    existing!.submissionCount = latest.length;
    await existing!.save({ session: s });
    if (hasConflict) {
      // Disagreement with a verified result goes back to reviewers; figures are not changed.
      await ResultSubmission.updateMany({ submissionId: { $in: conflicting.map((c) => c.sub.submissionId) }, status: 'SUBMITTED' }, { $set: { status: 'UNDER_REVIEW' } }, { session: s });
    }
    return;
  }

  const lead = latest[0]!;
  const status: PublicResultStatus = hasConflict || (lead.rev.reconciliationIssues?.length ?? 0) > 0 ? 'AWAITING_VERIFICATION' : 'PROVISIONAL';
  const values = {
    electionId: a.electionId,
    pollingStationId: a.pollingStationId,
    countyId: a.station.countyId,
    constituencyId: a.station.constituencyId,
    wardId: a.station.wardId,
    position: a.position,
    submissionId: lead.sub.submissionId,
    revision: lead.sub.currentRevision,
    candidateVotes: lead.rev.candidateVotes,
    fields: lead.rev.fields ?? {},
    status,
    hasConflict,
    submissionCount: latest.length
  };
  if (existing) {
    existing.set(values);
    await existing.save({ session: s });
  } else {
    await StationResult.create([values], { session: s });
  }
  await enqueueOutbox(s, 'results.station_result_changed', { electionId: String(a.electionId), pollingStationId: String(a.pollingStationId), position: a.position });
}

// ---------------- Verification ----------------

async function loadForReview(reviewer: AuthUser, submissionId: string) {
  const sub = await ResultSubmission.findOne({ submissionId });
  if (!sub) throw notFound('Submission not found');
  if (!inScope(reviewer, sub)) throw forbidden('Submission is outside your scope');
  if (String(sub.agentId) === reviewer.id) throw forbidden('You cannot review your own submission');
  return sub;
}

export async function startReview(reviewer: AuthUser, submissionId: string, note: string, ip?: string) {
  const sub = await loadForReview(reviewer, submissionId);
  if (sub.status !== 'SUBMITTED') throw conflict(`Submission is ${sub.status}`);
  await withTransaction(async (s) => {
    sub.status = 'UNDER_REVIEW';
    await sub.save({ session: s });
    await VerificationDecision.create([{ submissionId, revision: sub.currentRevision, decision: 'START_REVIEW', reviewerId: reviewer.id, note, at: new Date() }], { session: s });
    await recordAudit(s, { actor: { id: reviewer.id, role: reviewer.role, label: reviewer.fullName, ip }, action: 'result.review_started', entityType: 'ResultSubmission', entityId: submissionId });
  });
}

export type DecisionResult = { applied: true } | { applied: false; approvalId: string };

/**
 * Verify or reject a specific revision. Changing an already-verified station result
 * (replacing it, or rejecting the submission behind it) is a critical correction and
 * requires a second reviewer.
 */
export async function decide(reviewer: AuthUser, args: { submissionId: string; revision: number; decision: 'VERIFY' | 'REJECT'; note: string }, ip?: string): Promise<DecisionResult> {
  const sub = await loadForReview(reviewer, args.submissionId);
  if (args.revision !== sub.currentRevision) throw conflict('A newer revision exists; review the latest revision', { currentRevision: sub.currentRevision });
  if (sub.status === 'VERIFIED' && args.decision === 'VERIFY') throw conflict('Already verified');
  if (sub.status === 'REJECTED') throw conflict('Submission already rejected');

  const sr = await StationResult.findOne({ electionId: sub.electionId, pollingStationId: sub.pollingStationId, position: sub.position }).lean();
  const srLocked = sr && ['VERIFIED', 'MATCHED_OFFICIAL', 'OFFICIAL'].includes(sr.status);
  const rev = await SubmissionRevision.findOne({ submissionId: sub.submissionId, revision: sub.currentRevision }).lean();
  const critical =
    srLocked &&
    ((args.decision === 'VERIFY' && !sameFigures(sr as never, rev as never)) ||
      (args.decision === 'REJECT' && sr!.submissionId === sub.submissionId));

  if (critical) {
    const existingPending = await PendingApproval.findOne({ kind: 'RESULT_CORRECTION', entityId: sub.submissionId, status: 'PENDING' });
    if (existingPending) throw conflict('A correction for this submission is already awaiting a second reviewer');
    const approval = await withTransaction(async (s) => {
      const [p] = await PendingApproval.create(
        [{ kind: 'RESULT_CORRECTION', entityId: sub.submissionId, payload: args, reason: args.note, requestedBy: reviewer.id }],
        { session: s }
      );
      await recordAudit(s, { actor: { id: reviewer.id, role: reviewer.role, label: reviewer.fullName, ip }, action: 'result.correction_requested', entityType: 'ResultSubmission', entityId: sub.submissionId, meta: args });
      return p!;
    });
    return { applied: false, approvalId: String(approval._id) };
  }
  await applyDecision(reviewer, args, undefined, ip);
  return { applied: true };
}

export async function applyDecision(
  reviewer: AuthUser,
  args: { submissionId: string; revision: number; decision: 'VERIFY' | 'REJECT'; note: string },
  secondReviewer: AuthUser | undefined,
  ip?: string,
  outerSession?: ClientSession
) {
  const run = async (s: ClientSession) => {
    const sub = await ResultSubmission.findOne({ submissionId: args.submissionId }).session(s);
    if (!sub) throw notFound();
    if (sub.currentRevision !== args.revision) throw conflict('Submission changed since the decision was requested');
    const rev = await SubmissionRevision.findOne({ submissionId: sub.submissionId, revision: sub.currentRevision }).session(s).lean();
    const station = await PollingStation.findById(sub.pollingStationId).session(s).lean();
    const now = new Date();
    await VerificationDecision.create(
      [{ submissionId: sub.submissionId, revision: sub.currentRevision, decision: args.decision, reviewerId: reviewer.id, secondReviewerId: secondReviewer?.id, note: args.note, at: now }],
      { session: s }
    );
    sub.status = args.decision === 'VERIFY' ? 'VERIFIED' : 'REJECTED';
    await sub.save({ session: s });

    const filter = { electionId: sub.electionId, pollingStationId: sub.pollingStationId, position: sub.position };
    if (args.decision === 'VERIFY') {
      const others = await ResultSubmission.find({ ...filter, status: { $ne: 'REJECTED' }, _id: { $ne: sub._id } }).session(s);
      let stillConflicting = false;
      for (const o of others) {
        const orev = await SubmissionRevision.findOne({ submissionId: o.submissionId, revision: o.currentRevision }).session(s).lean();
        const differs = !sameFigures(rev as never, orev as never);
        stillConflicting ||= differs && o.status !== 'REJECTED';
        o.hasConflict = differs;
        await o.save({ session: s });
      }
      sub.hasConflict = false;
      await sub.save({ session: s });
      await StationResult.findOneAndUpdate(
        filter,
        {
          $set: {
            countyId: sub.countyId,
            constituencyId: sub.constituencyId,
            wardId: sub.wardId,
            submissionId: sub.submissionId,
            revision: sub.currentRevision,
            candidateVotes: rev!.candidateVotes,
            fields: rev!.fields ?? {},
            status: 'VERIFIED',
            hasConflict: stillConflicting,
            verifiedBy: reviewer.id,
            verifiedAt: now
          },
          $unset: { officialMatch: 1 }
        },
        { upsert: true, session: s }
      );
      await enqueueOutbox(s, 'results.station_result_changed', { electionId: String(sub.electionId), pollingStationId: String(sub.pollingStationId), position: sub.position });
    } else {
      const sr = await StationResult.findOne(filter).session(s);
      if (sr && sr.submissionId === sub.submissionId) {
        // Release the lock so the station result is recomputed from remaining submissions.
        sr.status = 'AWAITING_VERIFICATION';
        await sr.save({ session: s });
      }
      await refreshStationResult(s, { electionId: sub.electionId, pollingStationId: sub.pollingStationId, position: sub.position as Position, station: station!, changedSubmissionId: sub.submissionId });
    }
    await recordAudit(s, {
      actor: { id: reviewer.id, role: reviewer.role, label: reviewer.fullName, ip },
      action: args.decision === 'VERIFY' ? 'result.verified' : 'result.rejected',
      entityType: 'ResultSubmission',
      entityId: sub.submissionId,
      after: { status: sub.status, revision: sub.currentRevision },
      meta: { note: args.note, secondReviewerId: secondReviewer?.id }
    });
    await enqueueOutbox(s, 'results.verification', { electionId: String(sub.electionId), countyId: String(sub.countyId), submissionId: sub.submissionId, decision: args.decision });
  };
  if (outerSession) return run(outerSession);
  return withTransaction(run);
}
