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
  FORM_TEMPLATES,
  Party,
  StoredFile,
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
  formCode: z.string().regex(/^[0-9]{2}[A-Z]$/).optional(),
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
    const items = await Candidate.find(filter).sort({ position: 1, ballotOrder: 1, fullName: 1 }).select('-__v').populate('partyId', 'name abbreviation logoFileId').lean();
    res.json({ items });
  });

  r.get('/parties', async (_req, res) => {
    res.json({ items: await Party.find({ active: true }).sort({ name: 1 }).select('name abbreviation logoFileId').lean() });
  });

  return r;
}

export function electionsAdminRouter() {
  const r = Router();
  const manage = requirePermission('elections.manage');
  const actor = (req: { user?: { id: string; role: string; fullName: string } ; ip?: string }) => ({ id: req.user!.id, role: req.user!.role, label: req.user!.fullName, ip: req.ip });

  r.get('/form-templates', requirePermission('elections.manage'), (_req, res) => {
    res.json({ templates: FORM_TEMPLATES, note: 'Starting templates only. Confirm each against the forms gazetted for the specific election.' });
  });

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
    partyId: objectId.nullable().optional(),
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
    Object.assign(body, await partyFields(body.partyId, body.independent));
    if (body.photoFileId) await assertImage(body.photoFileId, 'CANDIDATE_PHOTO');
    const c = await withTransaction(async (s) => {
      const [doc] = await Candidate.create([{ ...body, scopeType: POSITION_SCOPE[body.position], scopeRefId: body.scopeRefId ?? null }], { session: s });
      await recordAudit(s, { actor: actor(req), action: 'candidate.created', entityType: 'Candidate', entityId: String(doc!._id), after: body });
      return doc!;
    });
    res.status(201).json({ candidate: c });
  });

  r.patch('/candidates/:id', requirePermission('candidates.manage'), async (req, res) => {
    const body = parse(candidateBody.pick({ fullName: true, partyId: true, independent: true, party: true, partyAbbreviation: true, ballotOrder: true, sourceId: true, sourceReference: true, photoFileId: true }).partial().extend({ active: z.boolean().optional(), reason: z.string().min(3).max(500) }), req.body);
    if (body.partyId !== undefined || body.independent !== undefined) Object.assign(body, await partyFields(body.partyId, body.independent ?? false));
    if (body.photoFileId) await assertImage(body.photoFileId, 'CANDIDATE_PHOTO');
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

  // ---- Aspirant listing for administrators (includes inactive) ----
  r.get('/candidates', requirePermission('candidates.manage'), async (req, res) => {
    const q = parse(z.object({ electionId: objectId, position: z.enum(POSITIONS).optional(), scopeRefId: objectId.optional() }).passthrough(), req.query);
    const filter: Record<string, unknown> = { electionId: q.electionId };
    if (q.position) filter.position = q.position;
    if (q.scopeRefId) filter.scopeRefId = q.scopeRefId;
    const items = await Candidate.find(filter).sort({ position: 1, scopeRefId: 1, ballotOrder: 1, fullName: 1 }).populate('partyId', 'name abbreviation logoFileId').lean();
    res.json({ items });
  });

  // ---- Parties ----
  const partyBody = z.object({
    name: z.string().trim().min(2).max(200),
    abbreviation: z.string().trim().min(1).max(20),
    logoFileId: objectId.nullable().optional(),
    active: z.boolean().optional(),
    sourceReference: z.string().max(300).optional()
  });

  r.get('/parties', requirePermission('candidates.manage'), async (_req, res) => {
    res.json({ items: await Party.find().sort({ name: 1 }).lean() });
  });

  r.post('/parties', requirePermission('candidates.manage'), async (req, res) => {
    const body = parse(partyBody, req.body);
    if (body.logoFileId) await assertImage(body.logoFileId, 'PARTY_LOGO');
    if (await Party.exists({ $or: [{ abbreviation: body.abbreviation.toUpperCase() }, { name: body.name }] }).collation({ locale: 'en', strength: 2 })) throw conflict('A party with this name or abbreviation already exists');
    const p = await withTransaction(async (s) => {
      const [doc] = await Party.create([body], { session: s });
      await recordAudit(s, { actor: actor(req), action: 'party.created', entityType: 'Party', entityId: String(doc!._id), after: body });
      return doc!;
    });
    res.status(201).json({ party: p });
  });

  r.patch('/parties/:id', requirePermission('candidates.manage'), async (req, res) => {
    const body = parse(partyBody.partial(), req.body);
    if (body.logoFileId) await assertImage(body.logoFileId, 'PARTY_LOGO');
    const p = await Party.findById(String(req.params.id));
    if (!p) throw notFound();
    const before = p.toObject();
    await withTransaction(async (s) => {
      p.set(body);
      await p.save({ session: s });
      // Keep the ballot name of this party's aspirants in step with the party record.
      if (body.name || body.abbreviation) await Candidate.updateMany({ partyId: p._id }, { $set: { party: p.name, partyAbbreviation: p.abbreviation } }, { session: s });
      await recordAudit(s, { actor: actor(req), action: 'party.updated', entityType: 'Party', entityId: String(p._id), before, after: body });
    });
    res.json({ party: p });
  });

  // ---- Counties ----
  const countyBody = z.object({
    code: z.string().trim().regex(/^\d{3}$/, 'County code is three digits, e.g. 007'),
    name: z.string().trim().min(2).max(100),
    region: z.string().trim().max(100).optional(),
    logoFileId: objectId.nullable().optional()
  });

  r.post('/counties', requirePermission('counties.manage'), async (req, res) => {
    const body = parse(countyBody, req.body);
    if (body.logoFileId) await assertImage(body.logoFileId, 'COUNTY_LOGO');
    const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (await County.exists({ $or: [{ code: body.code }, { slug }] })) throw conflict('A county with this code or name already exists');
    const c = await withTransaction(async (s) => {
      const [doc] = await County.create([{ ...body, slug }], { session: s });
      await recordAudit(s, { actor: actor(req), action: 'county.created', entityType: 'County', entityId: String(doc!._id), after: body });
      return doc!;
    });
    res.status(201).json({ county: c });
  });

  r.patch('/counties/:id', requirePermission('counties.manage'), async (req, res) => {
    // Codes are fixed once created (records reference them); name, region and logo can change.
    const body = parse(countyBody.omit({ code: true }).partial(), req.body);
    if (body.logoFileId) await assertImage(body.logoFileId, 'COUNTY_LOGO');
    const c = await County.findById(String(req.params.id));
    if (!c) throw notFound();
    const before = c.toObject();
    await withTransaction(async (s) => {
      c.set(body);
      await c.save({ session: s });
      await recordAudit(s, { actor: actor(req), action: 'county.updated', entityType: 'County', entityId: String(c._id), before, after: body });
    });
    res.json({ county: c });
  });

  return r;
}

/** Copies the party's ballot name onto the aspirant; independents carry no party. */
async function partyFields(partyId: string | null | undefined, independent: boolean) {
  if (independent) return { partyId: null, party: 'Independent', partyAbbreviation: 'IND', independent: true };
  if (!partyId) return {};
  const p = await Party.findById(partyId).lean();
  if (!p || !p.active) throw badRequest('Unknown or inactive party');
  return { partyId: p._id, party: p.name, partyAbbreviation: p.abbreviation, independent: false };
}

async function assertImage(fileId: string, purpose: 'PARTY_LOGO' | 'COUNTY_LOGO' | 'CANDIDATE_PHOTO') {
  const f = await StoredFile.findById(fileId).lean();
  if (!f || f.purpose !== purpose) throw badRequest('Upload the image first');
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
