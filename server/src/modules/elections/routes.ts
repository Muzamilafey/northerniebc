import { Router } from 'express';
import { z } from 'zod';
import { withTransaction } from '../../db/mongo.js';
import { recordAudit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/http.js';
import { requirePermission } from '../../middleware/auth.js';
import {
  Candidate,
  Constituency,
  County,
  Election,
  PollingStation,
  POSITION_LABELS,
  POSITION_SCOPE,
  POSITIONS,
  RECONCILIATION_FIELDS,
  RECONCILIATION_RULES,
  Ward,
  type Position
} from '../../models/index.js';
import { objectId } from '../users/routes.js';

const positionConfig = z.object({
  position: z.enum(POSITIONS),
  enabled: z.boolean().default(true),
  formReferenceLabel: z.string().max(120).default('Official results form reference'),
  requiredFields: z.array(z.enum(RECONCILIATION_FIELDS)).default([]),
  rules: z.array(z.enum(RECONCILIATION_RULES)).default(['CANDIDATE_SUM_EQUALS_VALID']),
  requireEvidence: z.boolean().default(true),
  rulesSourceId: objectId.optional()
});

const electionBody = z.object({
  name: z.string().min(3).max(200),
  slug: z.string().regex(/^[a-z0-9-]{3,80}$/),
  type: z.enum(['GENERAL', 'BY_ELECTION']),
  electionDate: z.coerce.date(),
  countyIds: z.array(objectId).max(5).default([]),
  positions: z.array(positionConfig).max(6).default([]),
  publishProvisional: z.boolean().default(false),
  sourceId: objectId.optional()
});

const STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['ACTIVE'],
  ACTIVE: ['CLOSED'],
  CLOSED: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: []
};

/** Public election metadata (no internal fields). */
function publicElection(e: Record<string, unknown>) {
  const { createdBy: _c, __v: _v, ...rest } = e;
  return rest;
}

export function electionsPublicRouter() {
  const r = Router();

  r.get('/counties', async (_req, res) => {
    res.json({ items: await County.find().sort({ name: 1 }).lean() });
  });

  r.get('/elections', async (_req, res) => {
    const items = await Election.find({ status: { $ne: 'DRAFT' } }).sort({ electionDate: -1 }).lean();
    res.json({ items: items.map(publicElection), positionLabels: POSITION_LABELS });
  });

  r.get('/elections/:id', async (req, res) => {
    const e = await Election.findOne({ _id: String(req.params.id), status: { $ne: 'DRAFT' } }).lean();
    if (!e) throw notFound('Election not found');
    res.json({ election: publicElection(e), positionLabels: POSITION_LABELS });
  });

  r.get('/elections/:id/constituencies', async (req, res) => {
    const q = parse(z.object({ countyId: objectId.optional() }).passthrough(), req.query);
    const filter: Record<string, unknown> = { electionId: String(req.params.id) };
    if (q.countyId) filter.countyId = q.countyId;
    res.json({ items: await Constituency.find(filter).sort({ name: 1 }).select('code name countyId').lean() });
  });

  r.get('/elections/:id/wards', async (req, res) => {
    const q = parse(z.object({ constituencyId: objectId }).passthrough(), req.query);
    res.json({ items: await Ward.find({ electionId: String(req.params.id), constituencyId: q.constituencyId }).sort({ name: 1 }).select('code name constituencyId countyId').lean() });
  });

  r.get('/elections/:id/stations', async (req, res) => {
    const q = parse(z.object({ wardId: objectId }).passthrough(), req.query);
    res.json({
      items: await PollingStation.find({ electionId: String(req.params.id), wardId: q.wardId, active: true })
        .sort({ code: 1 })
        .select('code name wardId constituencyId countyId registeredVoters')
        .lean()
    });
  });

  r.get('/elections/:id/candidates', async (req, res) => {
    const q = parse(z.object({ position: z.enum(POSITIONS).optional(), scopeRefId: objectId.optional() }).passthrough(), req.query);
    const filter: Record<string, unknown> = { electionId: String(req.params.id), active: true };
    if (q.position) filter.position = q.position;
    if (q.scopeRefId) filter.scopeRefId = q.scopeRefId;
    const items = await Candidate.find(filter).sort({ position: 1, ballotOrder: 1, fullName: 1 }).select('-__v').lean();
    res.json({ items });
  });

  return r;
}

export function electionsAdminRouter() {
  const r = Router();
  const manage = requirePermission('elections.manage');
  const actor = (req: { user?: { id: string; role: string; fullName: string } ; ip?: string }) => ({ id: req.user!.id, role: req.user!.role, label: req.user!.fullName, ip: req.ip });

  r.get('/elections', requirePermission('results.monitor', 'elections.manage', 'agents.manage'), async (_req, res) => {
    res.json({ items: await Election.find().sort({ electionDate: -1 }).lean() });
  });

  r.post('/elections', manage, async (req, res) => {
    const body = parse(electionBody, req.body);
    const dupPositions = new Set(body.positions.map((p) => p.position));
    if (dupPositions.size !== body.positions.length) throw badRequest('Each position may appear only once');
    if (await Election.exists({ slug: body.slug })) throw conflict('Slug already in use');
    const e = await withTransaction(async (s) => {
      const [doc] = await Election.create([{ ...body, createdBy: req.user!.id }], { session: s });
      await recordAudit(s, { actor: actor(req), action: 'election.created', entityType: 'Election', entityId: String(doc!._id), after: body });
      return doc!;
    });
    res.status(201).json({ election: e });
  });

  r.patch('/elections/:id', manage, async (req, res) => {
    const body = parse(electionBody.partial().extend({ status: z.enum(['DRAFT', 'ACTIVE', 'CLOSED', 'ARCHIVED']).optional() }), req.body);
    const e = await Election.findById(String(req.params.id));
    if (!e) throw notFound();
    if (body.status && body.status !== e.status && !STATUS_TRANSITIONS[e.status]!.includes(body.status)) {
      throw badRequest(`Cannot move election from ${e.status} to ${body.status}`);
    }
    const before = e.toObject();
    await withTransaction(async (s) => {
      e.set(body);
      await e.save({ session: s });
      await recordAudit(s, { actor: actor(req), action: 'election.updated', entityType: 'Election', entityId: String(e._id), before: { status: before.status, positions: before.positions, publishProvisional: before.publishProvisional }, after: body });
    });
    res.json({ election: e });
  });

  const candidateBody = z.object({
    electionId: objectId,
    position: z.enum(POSITIONS),
    fullName: z.string().min(3).max(200),
    party: z.string().max(200).optional(),
    partyAbbreviation: z.string().max(20).optional(),
    independent: z.boolean().default(false),
    scopeRefId: objectId.nullable().optional(),
    ballotOrder: z.number().int().min(0).max(1000).optional(),
    sourceId: objectId.optional(),
    sourceReference: z.string().max(300).optional(),
    photoFileId: objectId.optional()
  });

  r.post('/candidates', requirePermission('candidates.manage'), async (req, res) => {
    const body = parse(candidateBody, req.body);
    await validateCandidateScope(body.electionId, body.position, body.scopeRefId ?? null);
    const c = await withTransaction(async (s) => {
      const [doc] = await Candidate.create([{ ...body, scopeType: POSITION_SCOPE[body.position], scopeRefId: body.scopeRefId ?? null }], { session: s });
      await recordAudit(s, { actor: actor(req), action: 'candidate.created', entityType: 'Candidate', entityId: String(doc!._id), after: body });
      return doc!;
    });
    res.status(201).json({ candidate: c });
  });

  r.patch('/candidates/:id', requirePermission('candidates.manage'), async (req, res) => {
    const body = parse(candidateBody.pick({ fullName: true, party: true, partyAbbreviation: true, ballotOrder: true, sourceId: true, sourceReference: true, photoFileId: true }).partial().extend({ active: z.boolean().optional(), reason: z.string().min(3).max(500) }), req.body);
    const c = await Candidate.findById(String(req.params.id));
    if (!c) throw notFound();
    const before = c.toObject();
    const { reason, ...changes } = body;
    await withTransaction(async (s) => {
      c.set(changes);
      await c.save({ session: s });
      await recordAudit(s, { actor: actor(req), action: 'candidate.updated', entityType: 'Candidate', entityId: String(c._id), before, after: changes, meta: { reason } });
    });
    res.json({ candidate: c });
  });

  return r;
}

export async function validateCandidateScope(electionId: string, position: Position, scopeRefId: string | null) {
  const scopeType = POSITION_SCOPE[position];
  if (scopeType === 'NATIONAL') {
    if (scopeRefId) throw badRequest('Presidential candidates have national scope; scopeRefId must be empty');
    return;
  }
  if (!scopeRefId) throw badRequest(`${POSITION_LABELS[position]} candidates need a ${scopeType.toLowerCase()} reference`);
  const exists =
    scopeType === 'COUNTY'
      ? await County.exists({ _id: scopeRefId })
      : scopeType === 'CONSTITUENCY'
        ? await Constituency.exists({ _id: scopeRefId, electionId })
        : await Ward.exists({ _id: scopeRefId, electionId });
  if (!exists) throw badRequest(`Unknown ${scopeType.toLowerCase()} for this election`);
}
