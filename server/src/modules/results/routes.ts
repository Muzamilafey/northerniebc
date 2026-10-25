import { Router } from 'express';
import { z } from 'zod';
import { cached } from '../../lib/cache.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { pageParams, parse } from '../../lib/http.js';
import { inScope, scopeFilter } from '../../lib/permissions.js';
import { upload } from '../../lib/upload.js';
import { requirePermission } from '../../middleware/auth.js';
import { ipHash } from '../../middleware/security.js';
import {
  AgentAssignment,
  Candidate,
  Election,
  PendingApproval,
  PollingStation,
  POSITION_LABELS,
  POSITIONS,
  ResultSubmission,
  StationResult,
  StoredFile,
  SubmissionRevision,
  VerificationDecision,
  Constituency,
  Ward,
  County,
  CountSession,
  FormExtraction,
  FORM_TEMPLATES,
  Party,
  Session,
  TallyEvent,
  UNDO_REASONS,
  User,
  type Position
} from '../../models/index.js';
import { eligibleCandidates } from '../elections/service.js';
import { ALLOWED_MIME, saveFile } from '../files/storage.js';
import { objectId } from '../users/routes.js';
import { adminDashboard, breakdown, publicStatuses, tally, PUBLIC_DISCLAIMER } from './query.js';
import { candidateDifferences } from './reconciliation.js';
import { DECLARATION_TEXT, decide, startReview, submitResult } from './service.js';
import { assertVettedAgent, getCountSession, recordTallyEvents } from '../counting/service.js';
import { extractForm, extractionEnabled } from '../extraction/service.js';
import { verifyPassword } from '../auth/password.js';
import { recordAuditStandalone } from '../../lib/audit.js';
import { limiter } from '../../middleware/security.js';
import { env } from '../../config/env.js';
import { unauthorized as unauthorizedErr } from '../../lib/errors.js';
import { AGENT_LOGIN_CLOSED, agentLoginOpen } from '../settings/service.js';
import { intakeState } from '../elections/intake.js';

const nonNeg = z.number().int().min(0).max(10_000_000);
const fieldsSchema = z
  .object({
    registeredVoters: nonNeg.optional(),
    totalVotesCast: nonNeg.optional(),
    rejectedVotes: nonNeg.optional(),
    rejectedObjectedTo: nonNeg.optional(),
    disputedVotes: nonNeg.optional(),
    validVotes: nonNeg.optional()
  })
  .strict();

const submitSchema = z.object({
  idempotencyKey: z.string().uuid(),
  electionId: objectId,
  pollingStationId: objectId,
  position: z.enum(POSITIONS),
  candidateVotes: z.array(z.object({ candidateId: objectId, votes: nonNeg })).min(1).max(100),
  fields: fieldsSchema.default({}),
  formReference: z.string().max(120).optional(),
  evidenceFileIds: z.array(objectId).max(5).default([]),
  declarationAccepted: z.literal(true),
  clientCreatedAt: z.coerce.date().optional(),
  clientDeviceId: z.string().max(100).optional(),
  baseRevision: z.number().int().min(1).nullable().default(null),
  correctionReason: z.string().max(1000).optional(),
  countSessionId: z.string().uuid().optional()
});

const tallySchema = z.object({
  clientSessionId: z.string().uuid(),
  electionId: objectId,
  pollingStationId: objectId,
  position: z.enum(POSITIONS),
  events: z
    .array(
      z.object({
        seq: z.number().int().min(1),
        kind: z.enum(['INCREMENT', 'UNDO', 'SET']),
        candidateId: objectId,
        undoOfSeq: z.number().int().min(1).optional(),
        value: z.number().int().min(0).max(10_000_000).optional(),
        reasonCode: z.enum(UNDO_REASONS).optional(),
        reason: z.string().max(300).optional(),
        clientAt: z.coerce.date().optional()
      })
    )
    .min(1)
    .max(500)
});

const geoQuery = z
  .object({
    electionId: objectId,
    position: z.enum(POSITIONS),
    countyId: objectId.optional(),
    constituencyId: objectId.optional(),
    wardId: objectId.optional(),
    pollingStationId: objectId.optional()
  })
  .passthrough();

export function agentRouter() {
  const r = Router();
  const agent = requirePermission('results.submit');
  // Closing agent sign-in also stops agents who are already signed in.
  r.use((req, _res, next) => next(agentLoginOpen() ? undefined : forbidden(AGENT_LOGIN_CLOSED)));

  /** Re-confirms the agent's password; required shortly before submitting a result. */
  r.post('/confirm-identity', agent, limiter('step-up', { windowMs: 15 * 60_000, limit: 10 }), async (req, res) => {
    const { password } = parse(z.object({ password: z.string().min(1).max(256) }), req.body);
    const u = await User.findById(req.user!.id).select('+passwordHash');
    if (!u || !(await verifyPassword(u.passwordHash, password))) {
      await recordAuditStandalone({ actor: { id: req.user!.id, role: req.user!.role, ip: req.ip }, action: 'auth.step_up_failed', entityType: 'User', entityId: req.user!.id });
      throw unauthorizedErr('Incorrect password');
    }
    const until = new Date(Date.now() + env.SUBMIT_REAUTH_MINUTES * 60_000);
    await Session.updateOne({ familyId: req.user!.sessionId }, { $set: { stepUpUntil: until } });
    await recordAuditStandalone({ actor: { id: req.user!.id, role: req.user!.role, ip: req.ip }, action: 'auth.step_up', entityType: 'User', entityId: req.user!.id });
    res.json({ confirmedUntil: until });
  });

  /** Live counting: each "+" tap is sent here immediately (queued on the phone when offline). */
  r.post('/tally-events', agent, async (req, res) => {
    const body = parse(tallySchema, req.body);
    res.json(await recordTallyEvents(req.user!, body, req.ip));
  });

  r.get('/count-sessions/:clientSessionId', agent, async (req, res) => {
    res.json({ session: await getCountSession(req.user!, String(req.params.clientSessionId)) });
  });

  r.post('/form-extract', agent, limiter('form-extract', { windowMs: 60 * 60_000, limit: env.FORM_EXTRACTIONS_PER_HOUR, keyGenerator: (req) => req.user?.id ?? req.ip ?? 'anon' }), async (req, res) => {
    const body = parse(z.object({ fileId: objectId, electionId: objectId, pollingStationId: objectId, position: z.enum(POSITIONS) }), req.body);
    await assertVettedAgent(req.user!);
    const assignment = await AgentAssignment.exists({ userId: req.user!.id, electionId: body.electionId, pollingStationId: body.pollingStationId, active: true });
    if (!assignment) throw forbidden('You are not assigned to this polling station');
    const f = await StoredFile.findOne({ _id: body.fileId, uploadedBy: req.user!.id, purpose: 'RESULT_EVIDENCE' }).lean();
    if (!f) throw notFound('Upload the form photo first');
    res.json(await extractForm({ ...body, requestedBy: req.user!.id }));
  });

  r.get('/assignments', agent, async (req, res) => {
    const me = await User.findById(req.user!.id).select('vetting').lean();
    const assignments = await AgentAssignment.find({ userId: req.user!.id, active: true }).lean();
    const out = [];
    for (const a of assignments) {
      const [election, station, county, constituency, ward] = await Promise.all([
        Election.findById(a.electionId).lean(),
        PollingStation.findById(a.pollingStationId).lean(),
        County.findById(a.countyId).select('name').lean(),
        Constituency.findById(a.constituencyId).select('name').lean(),
        Ward.findById(a.wardId).select('name').lean()
      ]);
      if (!election || !station || election.status === 'ARCHIVED' || election.status === 'DRAFT') continue;
      const ballots = [];
      for (const p of election.positions.filter((x) => x.enabled)) {
        const candidates = await eligibleCandidates(station, p.position as Position);
        const sub = await ResultSubmission.findOne({ electionId: election._id, pollingStationId: station._id, position: p.position, agentId: req.user!.id }).lean();
        const tpl = FORM_TEMPLATES[p.position as Position];
        ballots.push({
          position: p.position,
          label: POSITION_LABELS[p.position as Position],
          formCode: p.formCode ?? tpl.formCode,
          formTitle: p.formCode && p.formCode !== tpl.formCode ? `Form ${p.formCode}` : tpl.title,
          formReferenceLabel: p.formReferenceLabel,
          requiredFields: p.requiredFields,
          rules: p.rules,
          requireEvidence: p.requireEvidence,
          candidates: await Promise.all(candidates.map(async (c) => ({ id: String(c._id), fullName: c.fullName, party: c.party, partyAbbreviation: c.partyAbbreviation, photoFileId: c.photoFileId ?? null, partyLogoFileId: c.partyId ? ((await Party.findById(c.partyId).select('logoFileId').lean())?.logoFileId ?? null) : null }))),
          submission: sub ? { submissionId: sub.submissionId, status: sub.status, currentRevision: sub.currentRevision, hasConflict: sub.hasConflict } : null
        });
      }
      out.push({
        assignmentId: String(a._id),
        election: { id: String(election._id), name: election.name, status: election.status, acceptingSubmissions: intakeState(election).open, intake: intakeState(election) },
        station: { id: String(station._id), code: station.code, name: station.name, registeredVoters: station.registeredVoters ?? null },
        county: county?.name,
        constituency: constituency?.name,
        ward: ward?.name,
        ballots
      });
    }
    res.json({
      assignments: out,
      declarationText: DECLARATION_TEXT,
      serverTime: new Date(),
      vettingStatus: me?.vetting?.status ?? 'PENDING',
      requireSubmitReauth: env.REQUIRE_SUBMIT_REAUTH,
      aiFormReading: extractionEnabled()
    });
  });

  r.post('/evidence', agent, upload.single('file'), async (req, res) => {
    if (!req.file) throw badRequest('No file uploaded');
    const f = await saveFile(req.file.buffer, {
      purpose: 'RESULT_EVIDENCE',
      allowed: [...ALLOWED_MIME.image, ...ALLOWED_MIME.document],
      originalName: req.file.originalname,
      uploadedBy: req.user!.id,
      uploaderIpHash: ipHash(req)
    });
    res.status(201).json({ fileId: String(f._id), sha256: f.sha256, scanStatus: f.scanStatus });
  });

  r.post('/submissions', agent, async (req, res) => {
    const body = parse(submitSchema, req.body);
    const receipt = await submitResult(req.user!, body, req.ip, ipHash(req));
    res.status(receipt.replayed ? 200 : 201).json({ receipt });
  });

  r.get('/submissions', agent, async (req, res) => {
    const subs = await ResultSubmission.find({ agentId: req.user!.id }).sort({ updatedAt: -1 }).limit(200).lean();
    const revs = await SubmissionRevision.find({ submissionId: { $in: subs.map((s) => s.submissionId) } })
      .select('submissionId revision receiptId serverReceivedAt payloadHash candidateVotes fields formReference correctionReason reconciliationIssues')
      .sort({ revision: -1 })
      .lean();
    res.json({
      items: subs.map((s) => ({
        submissionId: s.submissionId,
        electionId: s.electionId,
        pollingStationId: s.pollingStationId,
        position: s.position,
        status: s.status,
        currentRevision: s.currentRevision,
        hasConflict: s.hasConflict,
        revisions: revs.filter((r) => r.submissionId === s.submissionId)
      }))
    });
  });

  return r;
}

export function verificationRouter() {
  const r = Router();
  const monitor = requirePermission('results.monitor');
  const verify = requirePermission('results.verify');

  r.get('/dashboard', monitor, async (req, res) => {
    const q = parse(geoQuery.partial({ position: true }), req.query);
    res.json(await adminDashboard(q.electionId, q, scopeFilter(req.user!), q.position));
  });

  r.get('/tally', monitor, async (req, res) => {
    const q = parse(geoQuery, req.query);
    res.json(await tally({ electionId: q.electionId, position: q.position, geo: q, audience: 'admin', scope: scopeFilter(req.user!) }));
  });

  r.get('/submissions', monitor, async (req, res) => {
    const q = parse(
      geoQuery
        .partial({ position: true })
        .extend({ status: z.enum(['SUBMITTED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED']).optional(), conflict: z.enum(['true', 'false']).optional(), candidateId: objectId.optional() }),
      req.query
    );
    const { page, limit, skip } = pageParams(req.query, 200);
    const filter: Record<string, unknown> = { electionId: q.electionId, ...scopeFilter(req.user!) };
    for (const k of ['countyId', 'constituencyId', 'wardId', 'pollingStationId', 'position', 'status'] as const) if (q[k]) filter[k] = q[k];
    if (q.conflict) filter.hasConflict = q.conflict === 'true';
    if (q.candidateId) {
      const ids = await SubmissionRevision.distinct('submissionId', { 'candidateVotes.candidateId': q.candidateId });
      filter.submissionId = { $in: ids };
    }
    const [items, total] = await Promise.all([
      ResultSubmission.find(filter)
        .populate('pollingStationId', 'code name')
        .populate('agentId', 'fullName agentCode')
        .sort({ hasConflict: -1, lastServerReceivedAt: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ResultSubmission.countDocuments(filter)
    ]);
    res.json({ items, total, page, limit });
  });

  r.get('/submissions/:submissionId', monitor, async (req, res) => {
    const sub = await ResultSubmission.findOne({ submissionId: String(req.params.submissionId) })
      .populate('pollingStationId')
      .populate('agentId', 'fullName agentCode')
      .lean();
    if (!sub) throw notFound();
    if (!inScope(req.user!, sub)) throw forbidden();
    const station = sub.pollingStationId as unknown as { _id: unknown; electionId: unknown; countyId: unknown; constituencyId: unknown; wardId: unknown };
    const [revisions, decisions, stationResult, siblings, candidates, approvals] = await Promise.all([
      SubmissionRevision.find({ submissionId: sub.submissionId }).sort({ revision: -1 }).populate('evidenceFileIds', 'originalName mime size sha256 scanStatus').lean(),
      VerificationDecision.find({ submissionId: sub.submissionId }).populate('reviewerId', 'fullName role').populate('secondReviewerId', 'fullName role').sort({ at: -1 }).lean(),
      StationResult.findOne({ electionId: sub.electionId, pollingStationId: station._id, position: sub.position }).lean(),
      ResultSubmission.find({ electionId: sub.electionId, pollingStationId: station._id, position: sub.position, submissionId: { $ne: sub.submissionId } }).populate('agentId', 'fullName agentCode').lean(),
      eligibleCandidates(station, sub.position as Position),
      PendingApproval.find({ kind: 'RESULT_CORRECTION', entityId: sub.submissionId }).sort({ createdAt: -1 }).lean()
    ]);
    const current = revisions.find((r) => r.revision === sub.currentRevision)!;
    const countSession = current.countSessionId ? await CountSession.findOne({ clientSessionId: current.countSessionId }).lean() : null;
    const tallyEvents = countSession ? await TallyEvent.find({ sessionId: countSession._id, $or: [{ kind: { $ne: 'INCREMENT' } }, { 'flags.0': { $exists: true } }] }).sort({ seq: 1 }).limit(500).lean() : [];
    const extractions = await FormExtraction.find({ fileId: { $in: current.evidenceFileIds.map((f) => (f as unknown as { _id: unknown })._id) } }).sort({ createdAt: -1 }).lean();
    const comparisons = await Promise.all(
      siblings.map(async (o) => {
        const orev = await SubmissionRevision.findOne({ submissionId: o.submissionId, revision: o.currentRevision }).lean();
        return { submission: o, revision: orev, differences: candidateDifferences(current.candidateVotes, orev?.candidateVotes ?? []) };
      })
    );
    res.json({ submission: sub, revisions, decisions, stationResult, comparisons, candidates, approvals, countSession, tallyEvents, extractions, aiFormReading: extractionEnabled() });
  });

  /** Reviewers can run the AI reader on a submission's attached form. */
  r.post('/submissions/:submissionId/extract', verify, limiter('review-extract', { windowMs: 60 * 60_000, limit: 120 }), async (req, res) => {
    const { fileId } = parse(z.object({ fileId: objectId }), req.body);
    const sub = await ResultSubmission.findOne({ submissionId: String(req.params.submissionId) }).lean();
    if (!sub) throw notFound();
    if (!inScope(req.user!, sub)) throw forbidden();
    const rev = await SubmissionRevision.findOne({ submissionId: sub.submissionId, evidenceFileIds: fileId }).lean();
    if (!rev) throw badRequest('That file is not attached to this submission');
    res.json(await extractForm({ fileId, electionId: String(sub.electionId), pollingStationId: String(sub.pollingStationId), position: sub.position as Position, requestedBy: req.user!.id }));
  });

  r.post('/submissions/:submissionId/start-review', verify, async (req, res) => {
    const { note } = parse(z.object({ note: z.string().min(3).max(2000) }), req.body);
    await startReview(req.user!, String(req.params.submissionId), note, req.ip);
    res.status(204).end();
  });

  r.post('/submissions/:submissionId/decision', verify, async (req, res) => {
    const body = parse(z.object({ revision: z.number().int().min(1), decision: z.enum(['VERIFY', 'REJECT']), note: z.string().min(5).max(2000) }), req.body);
    const result = await decide(req.user!, { submissionId: String(req.params.submissionId), ...body }, req.ip);
    res.status(result.applied ? 200 : 202).json(result);
  });

  return r;
}

export function publicResultsRouter() {
  const r = Router();

  r.get('/results/tally', async (req, res) => {
    const q = parse(geoQuery, req.query);
    const key = `tally:${q.electionId}:${JSON.stringify(q)}`;
    // Pages refresh every second; one computation per second per query, however many viewers.
    res.set('Cache-Control', 'public, max-age=1');
    res.json(await cached(key, 1000, () => tally({ electionId: q.electionId, position: q.position, geo: q, audience: 'public' })));
  });

  r.get('/results/breakdown', async (req, res) => {
    const q = parse(
      z.object({ electionId: objectId, position: z.enum(POSITIONS), level: z.enum(['county', 'constituency', 'ward', 'station']), parentId: objectId.optional() }).passthrough(),
      req.query
    );
    const key = `tally:${q.electionId}:breakdown:${JSON.stringify(q)}`;
    res.set('Cache-Control', 'public, max-age=1');
    res.json({ items: await cached(key, 1000, () => breakdown({ ...q, audience: 'public' })), disclaimer: PUBLIC_DISCLAIMER });
  });

  /** All positions for one polling station (shareable station page). No agent or evidence data. */
  r.get('/results/stations/:stationId', async (req, res) => {
    res.set('Cache-Control', 'public, max-age=1');
    res.json(await cached(`tally:station:${String(req.params.stationId)}`, 1000, () => stationPage(String(req.params.stationId))));
  });

  async function stationPage(stationId: string) {
    const station = await PollingStation.findById(stationId).select('code name countyId constituencyId wardId electionId registeredVoters').lean();
    if (!station) throw notFound();
    const election = await Election.findById(station.electionId).lean();
    if (!election || election.status === 'DRAFT') throw notFound();
    const visible = publicStatuses(election.publishProvisional);
    const results = await StationResult.find({ electionId: station.electionId, pollingStationId: station._id })
      .select('position status candidateVotes fields updatedAt officialMatch.matches officialMatch.checkedAt')
      .lean();
    const ids = results.flatMap((x) => x.candidateVotes.map((c) => c.candidateId));
    const cands = await Candidate.find({ _id: { $in: ids } }).select('fullName party partyAbbreviation photoFileId partyId').populate('partyId', 'logoFileId').lean();
    const cm = new Map(cands.map((c) => [String(c._id), { fullName: c.fullName, party: c.party, partyAbbreviation: c.partyAbbreviation, photoFileId: c.photoFileId ?? null, partyLogoFileId: (c.partyId as unknown as { logoFileId?: unknown } | null)?.logoFileId ?? null }]));
    return {
      station,
      results: POSITIONS.filter((p) => election.positions.some((x) => x.position === p && x.enabled)).map((p) => {
        const sr = results.find((x) => x.position === p);
        if (!sr) return { position: p, status: 'NO_RESULTS' };
        if (!visible.includes(sr.status)) return { position: p, status: 'AWAITING_VERIFICATION' };
        return {
          position: p,
          status: sr.status,
          updatedAt: sr.updatedAt,
          fields: sr.fields,
          officialMatch: sr.officialMatch?.checkedAt ? { matches: sr.officialMatch.matches, checkedAt: sr.officialMatch.checkedAt } : null,
          candidates: sr.candidateVotes.map((c) => ({ candidateId: String(c.candidateId), votes: c.votes, ...cm.get(String(c.candidateId)) }))
        };
      }),
      disclaimer: PUBLIC_DISCLAIMER
    };
  }

  return r;
}

/** Evidence files are private: reviewers in scope, or the uploading agent, may view them. */
export async function canViewEvidence(user: { id: string; role: string } & Parameters<typeof inScope>[0], fileId: string) {
  const f = await StoredFile.findById(fileId).lean();
  if (!f) return false;
  if (String(f.uploadedBy) === user.id) return true;
  const rev = await SubmissionRevision.findOne({ evidenceFileIds: f._id }).lean();
  if (!rev) return false;
  const sub = await ResultSubmission.findOne({ submissionId: rev.submissionId }).lean();
  return Boolean(sub && inScope(user, sub));
}
