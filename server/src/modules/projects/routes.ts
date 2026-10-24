import { Router } from 'express';
import { z } from 'zod';
import { withTransaction } from '../../db/mongo.js';
import { recordAudit } from '../../lib/audit.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { escapeRegex, pageParams, parse } from '../../lib/http.js';
import { percent } from '../../lib/money.js';
import { inScope } from '../../lib/permissions.js';
import { requirePermission } from '../../middleware/auth.js';
import { Contractor, DataSource, isValidFinancialYear, PHYSICAL_PROGRESS_BASIS, Project, PROJECT_SECTORS, PROJECT_STATUSES, ProjectUpdate, publicFilter, VERIFICATION_STATUSES } from '../../models/index.js';
import { objectId } from '../users/routes.js';

const SOURCE_FIELDS = 'name publisher url documentTitle publicationDate kind';

/** Gap (percentage points) between financial and physical progress that triggers an investigation flag. */
export const DISCREPANCY_THRESHOLD_POINTS = 30;

/**
 * Financial progress = amount paid ÷ (revised budget, else approved budget) × 100.
 * Physical progress is reported separately and only from inspection/official report/observation.
 */
export function progressOf(p: { approvedBudgetCents?: number | null; revisedBudgetCents?: number | null; amountPaidCents?: number | null; physicalProgress?: { percent: number; basis: string; assessedAt: Date } | null }) {
  const budget = p.revisedBudgetCents ?? p.approvedBudgetCents ?? null;
  const financial = p.amountPaidCents != null && budget ? percent(p.amountPaidCents, budget, 1) : null;
  const physical = p.physicalProgress ? p.physicalProgress.percent : null;
  const gap = financial != null && physical != null ? Math.round((financial - physical) * 10) / 10 : null;
  return {
    financial: { percent: financial, basis: p.revisedBudgetCents != null ? 'REVISED_BUDGET' : p.approvedBudgetCents != null ? 'APPROVED_BUDGET' : null, formula: 'amount paid ÷ (revised budget, else approved budget) × 100' },
    physical: p.physicalProgress ? { percent: physical, basis: p.physicalProgress.basis, assessedAt: p.physicalProgress.assessedAt } : null,
    gapPoints: gap,
    exceedsThreshold: gap != null && gap >= DISCREPANCY_THRESHOLD_POINTS
  };
}

function presentProject(p: Record<string, unknown>) {
  const kes = (c: unknown) => (typeof c === 'number' ? c / 100 : null);
  return {
    id: String(p._id),
    reference: p.reference,
    name: p.name,
    description: p.description,
    sector: p.sector,
    countyId: p.countyId,
    constituencyName: p.constituencyName,
    wardName: p.wardName,
    location: (p.location as { verified?: boolean } | undefined)?.verified ? p.location : null,
    department: p.departmentId,
    fundingSource: p.fundingSource,
    financialYear: p.financialYear,
    approvedBudgetKes: kes(p.approvedBudgetCents),
    revisedBudgetKes: kes(p.revisedBudgetCents),
    amountPaidKes: kes(p.amountPaidCents),
    amountPaidAsOf: p.amountPaidAsOf,
    contractor: p.contractorId,
    procurementReference: p.procurementReference,
    startDate: p.startDate,
    plannedCompletionDate: p.plannedCompletionDate,
    status: p.status,
    statusSource: p.statusSourceId,
    lastInspectionDate: p.lastInspectionDate,
    progress: progressOf(p as never),
    discrepancyFlag: (p.discrepancyFlag as { flagged?: boolean } | undefined)?.flagged ? p.discrepancyFlag : null,
    verificationStatus: p.verificationStatus,
    revision: p.revision,
    correctionReason: p.correctionReason,
    source: p.sourceId,
    sources: p.sourceIds,
    publishedAt: p.publishedAt
  };
}

export function projectsPublicRouter() {
  const r = Router();

  r.get('/projects', async (req, res) => {
    const q = parse(
      z.object({
        countyId: objectId.optional(),
        status: z.enum(PROJECT_STATUSES).optional(),
        sector: z.enum(PROJECT_SECTORS).optional(),
        departmentId: objectId.optional(),
        financialYear: z.string().max(10).optional(),
        flagged: z.enum(['true']).optional(),
        q: z.string().max(100).optional(),
        sort: z.enum(['name', 'budget', 'updated']).default('updated')
      }).passthrough(),
      req.query
    );
    const { page, limit, skip } = pageParams(req.query);
    const filter: Record<string, unknown> = { ...publicFilter };
    if (q.countyId) filter.countyId = q.countyId;
    if (q.status) filter.status = q.status;
    if (q.sector) filter.sector = q.sector;
    if (q.departmentId) filter.departmentId = q.departmentId;
    if (q.financialYear) filter.financialYear = q.financialYear;
    if (q.flagged) filter['discrepancyFlag.flagged'] = true;
    if (q.q) filter.$or = [{ name: new RegExp(escapeRegex(q.q), 'i') }, { reference: new RegExp(escapeRegex(q.q), 'i') }];
    const sort: Record<string, 1 | -1> = q.sort === 'name' ? { name: 1 } : q.sort === 'budget' ? { approvedBudgetCents: -1 } : { updatedAt: -1 };
    const [items, total] = await Promise.all([
      Project.find(filter).sort(sort).skip(skip).limit(limit).populate('departmentId', 'name').populate('contractorId', 'name').lean(),
      Project.countDocuments(filter)
    ]);
    res.json({ items: items.map((p) => presentProject(p as never)), total, page, limit });
  });

  r.get('/projects/map', async (req, res) => {
    const q = parse(z.object({ countyId: objectId.optional(), status: z.enum(PROJECT_STATUSES).optional(), sector: z.enum(PROJECT_SECTORS).optional() }).passthrough(), req.query);
    const filter: Record<string, unknown> = { ...publicFilter, 'location.verified': true };
    if (q.countyId) filter.countyId = q.countyId;
    if (q.status) filter.status = q.status;
    if (q.sector) filter.sector = q.sector;
    const items = await Project.find(filter).select('reference name status sector location countyId').limit(2000).lean();
    res.json({ items: items.map((p) => ({ reference: p.reference, name: p.name, status: p.status, sector: p.sector, lat: p.location!.lat, lng: p.location!.lng, countyId: p.countyId })) });
  });

  r.get('/projects/:reference', async (req, res) => {
    const ref = String(req.params.reference);
    const p = await Project.findOne({ reference: ref, ...publicFilter })
      .populate('departmentId', 'name slug')
      .populate('contractorId', 'name')
      .populate('sourceId', SOURCE_FIELDS)
      .populate('sourceIds', SOURCE_FIELDS)
      .populate('statusSourceId', SOURCE_FIELDS)
      .populate('physicalProgress.sourceId', SOURCE_FIELDS)
      .lean();
    if (!p) throw notFound('Project not found');
    const [history, revisions] = await Promise.all([
      ProjectUpdate.find({ projectReference: ref }).sort({ at: -1 }).select('kind summary at after sourceId').populate('sourceId', SOURCE_FIELDS).lean(),
      Project.find({ reference: ref, workflowStatus: 'PUBLISHED' }).sort({ revision: -1 }).select('revision status amountPaidCents physicalProgress correctionReason publishedAt isCurrent').lean()
    ]);
    res.json({
      project: { ...presentProject(p as never), physicalProgressDetail: p.physicalProgress ?? null },
      history,
      revisions: revisions.map((r) => ({ ...r, amountPaidKes: r.amountPaidCents != null ? r.amountPaidCents / 100 : null })),
      note: 'Financial progress (money paid) and physical progress (work delivered) are measured separately. Spending the allocated money does not mean a project is complete.'
    });
  });

  return r;
}

const projectBody = z.object({
  reference: z.string().min(2).max(100),
  name: z.string().min(3).max(300),
  description: z.string().max(5000).optional(),
  sector: z.enum(PROJECT_SECTORS).default('OTHER'),
  countyId: objectId,
  constituencyName: z.string().max(100).optional(),
  wardName: z.string().max(100).optional(),
  location: z.object({ lat: z.number().min(-5).max(6), lng: z.number().min(33).max(43), verified: z.boolean().default(false) }).optional(),
  departmentId: objectId.optional(),
  fundingSource: z.string().max(100).optional(),
  financialYear: z.string().refine(isValidFinancialYear).optional(),
  approvedBudgetKes: z.number().min(0).optional(),
  revisedBudgetKes: z.number().min(0).optional(),
  amountPaidKes: z.number().min(0).optional(),
  amountPaidAsOf: z.coerce.date().optional(),
  contractorName: z.string().max(300).optional(),
  procurementReference: z.string().max(200).optional(),
  startDate: z.coerce.date().optional(),
  plannedCompletionDate: z.coerce.date().optional(),
  status: z.enum(PROJECT_STATUSES).default('UNVERIFIED'),
  statusSourceId: objectId.optional(),
  physicalProgress: z
    .object({
      percent: z.number().min(0).max(100),
      basis: z.enum(PHYSICAL_PROGRESS_BASIS),
      assessedAt: z.coerce.date(),
      assessedBy: z.string().max(200).optional(),
      sourceId: objectId.optional(),
      evidenceFileIds: z.array(objectId).max(10).default([]),
      notes: z.string().max(2000).optional()
    })
    .optional(),
  sourceId: objectId,
  sourceIds: z.array(objectId).max(20).default([]),
  verificationStatus: z.enum(VERIFICATION_STATUSES).default('OFFICIAL_SOURCE_REPORTED')
});

export async function toProjectDoc(b: z.infer<typeof projectBody>) {
  if (b.status === 'COMPLETED' && !b.physicalProgress && !b.statusSourceId) {
    throw badRequest('A COMPLETED status needs a documented source or inspection; spending alone does not establish completion');
  }
  if (b.physicalProgress?.basis === 'INSPECTION' && !b.physicalProgress.sourceId && b.physicalProgress.evidenceFileIds.length === 0) {
    throw badRequest('Inspection-based progress needs an inspection report source or evidence files');
  }
  let contractorId;
  if (b.contractorName) {
    const c = await Contractor.findOneAndUpdate({ name: b.contractorName.trim() }, { $setOnInsert: { name: b.contractorName.trim() } }, { upsert: true, new: true, collation: { locale: 'en', strength: 2 } });
    contractorId = c._id;
  }
  const { approvedBudgetKes, revisedBudgetKes, amountPaidKes, contractorName: _c, ...rest } = b;
  const cents = (v?: number) => (v == null ? undefined : Math.round(v * 100));
  return {
    ...rest,
    contractorId,
    approvedBudgetCents: cents(approvedBudgetKes),
    revisedBudgetCents: cents(revisedBudgetKes),
    amountPaidCents: cents(amountPaidKes),
    lastInspectionDate: b.physicalProgress?.basis === 'INSPECTION' ? b.physicalProgress.assessedAt : undefined
  };
}
export { projectBody };

export function projectsAdminRouter() {
  const r = Router();
  const manage = requirePermission('projects.manage');

  r.post('/projects', manage, async (req, res) => {
    const body = parse(projectBody, req.body);
    if (!inScope(req.user!, body)) throw forbidden();
    if (!(await DataSource.exists({ _id: body.sourceId }))) throw badRequest('Unknown source');
    if (await Project.exists({ reference: body.reference, isCurrent: true })) throw badRequest('A project with this reference already exists; submit a correction instead');
    const data = await toProjectDoc(body);
    const p = await withTransaction(async (s) => {
      const [doc] = await Project.create([{ ...data, createdBy: req.user!.id }], { session: s });
      await ProjectUpdate.create([{ projectReference: doc!.reference, projectId: doc!._id, kind: 'CREATED', summary: 'Project record created (unpublished)', actorId: req.user!.id }], { session: s });
      await recordAudit(s, { actor: { id: req.user!.id, role: req.user!.role, ip: req.ip }, action: 'Project.created', entityType: 'Project', entityId: String(doc!._id), after: body });
      return doc!;
    });
    res.status(201).json({ project: p });
  });

  /**
   * Flags a documented discrepancy between payments and delivery for investigation.
   * The flag is neutral wording; it is not a finding of wrongdoing.
   */
  r.post('/projects/:id/flag', requirePermission('projects.manage', 'citizen.moderate'), async (req, res) => {
    const body = parse(z.object({ flagged: z.boolean(), reason: z.string().min(10).max(2000), evidenceSourceIds: z.array(objectId).max(10).default([]) }), req.body);
    const p = await Project.findById(String(req.params.id));
    if (!p) throw notFound();
    if (!inScope(req.user!, p)) throw forbidden();
    if (body.flagged && body.evidenceSourceIds.length === 0) throw badRequest('Flags must cite source evidence');
    const before = p.discrepancyFlag;
    await withTransaction(async (s) => {
      p.set('discrepancyFlag', { flagged: body.flagged, reason: body.reason, flaggedAt: new Date(), flaggedBy: req.user!.id, evidenceSourceIds: body.evidenceSourceIds });
      await p.save({ session: s });
      await ProjectUpdate.create([{ projectReference: p.reference, projectId: p._id, kind: 'FLAG', summary: body.flagged ? `Flagged for investigation: ${body.reason}` : `Flag cleared: ${body.reason}`, actorId: req.user!.id }], { session: s });
      await recordAudit(s, { actor: { id: req.user!.id, role: req.user!.role, ip: req.ip }, action: 'Project.flag_changed', entityType: 'Project', entityId: String(p._id), before, after: body });
    });
    res.json({ project: p });
  });

  /** Projects where financial progress exceeds physical progress by the threshold — candidates for a flag. */
  r.get('/projects-discrepancies', manage, async (_req, res) => {
    const items = await Project.find({ ...publicFilter, physicalProgress: { $exists: true }, amountPaidCents: { $exists: true } }).lean();
    res.json({ threshold: DISCREPANCY_THRESHOLD_POINTS, items: items.map((p) => ({ id: String(p._id), reference: p.reference, name: p.name, progress: progressOf(p as never), flagged: p.discrepancyFlag?.flagged ?? false })).filter((x) => x.progress.exceedsThreshold) });
  });

  return r;
}
