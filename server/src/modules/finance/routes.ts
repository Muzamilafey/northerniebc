import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { withTransaction } from '../../db/mongo.js';
import { recordAudit } from '../../lib/audit.js';
import { cached } from '../../lib/cache.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { pageParams, parse } from '../../lib/http.js';
import { percent } from '../../lib/money.js';
import { inScope, scopeFilter } from '../../lib/permissions.js';
import { requirePermission } from '../../middleware/auth.js';
import {
  AuditFinding,
  BUDGET_METRICS,
  BudgetFigure,
  County,
  DataSource,
  Department,
  DISBURSEMENT_STAGES,
  isValidFinancialYear,
  PERCENT_METRICS,
  Project,
  publicFilter,
  TreasuryDisbursement,
  VERIFICATION_STATUSES,
  WORKFLOW_STATUSES,
  type BudgetMetric
} from '../../models/index.js';
import { objectId } from '../users/routes.js';
import { advanceRecord, correctRecord, editUnpublished, modelFor, RECORD_KINDS, type RecordKind } from '../publishing/service.js';

const fy = z.string().refine(isValidFinancialYear, 'Financial year must look like 2023/24');

const SOURCE_FIELDS = 'name publisher url documentTitle publicationDate retrievedAt kind verificationStatus';

/** Shapes a published figure for public display, including its provenance. */
function presentFigure(f: Record<string, unknown> & { value: number; unit: string; sourceId?: unknown }) {
  return {
    id: String(f._id),
    metric: f.metric,
    value: f.unit === 'BASIS_POINTS' ? f.value / 100 : f.value / 100,
    unit: f.unit === 'BASIS_POINTS' ? 'PERCENT' : 'KES',
    periodLabel: f.periodLabel,
    periodStart: f.periodStart ?? null,
    periodEnd: f.periodEnd,
    publicationDate: f.publicationDate ?? null,
    verificationStatus: f.verificationStatus,
    revision: f.revision,
    correctionReason: f.correctionReason ?? null,
    departmentId: f.departmentId ?? null,
    fundingSource: f.fundingSource ?? null,
    sourcePage: f.sourcePage ?? null,
    source: f.sourceId ?? null,
    publishedAt: f.publishedAt ?? null
  };
}

/** Latest published figure per metric (most recent period end). Missing metrics are explicit. */
async function metricSummary(filter: Record<string, unknown>) {
  const rows = await BudgetFigure.find({ ...publicFilter, ...filter }).sort({ periodEnd: -1, publishedAt: -1 }).populate('sourceId', SOURCE_FIELDS).lean();
  const out: Record<string, ReturnType<typeof presentFigure> | { available: false }> = {};
  for (const m of BUDGET_METRICS) {
    const f = rows.find((r) => r.metric === m);
    out[m] = f ? { ...presentFigure(f as never), available: true } as never : { available: false };
  }
  return out;
}

/** Derived ratios, each with its formula and inputs so it can be reproduced. */
function derived(summary: Record<string, { available?: boolean; value?: number; periodLabel?: unknown; id?: string } | { available: false }>) {
  const get = (m: BudgetMetric) => {
    const v = summary[m] as { available?: boolean; value?: number; periodLabel?: string; id?: string };
    return v && v.available !== false ? v : null;
  };
  const budget = get('REVISED_BUDGET') ?? get('APPROVED_BUDGET');
  const spent = get('ACTUAL_EXPENDITURE');
  const devBudget = get('DEVELOPMENT_BUDGET');
  const devSpent = get('DEVELOPMENT_EXPENDITURE');
  const mk = (label: string, num: typeof spent, den: typeof budget, formula: string) => ({
    label,
    formula,
    value: num && den ? percent(num.value!, den.value!) : null,
    inputs: num && den ? [{ id: num.id, period: num.periodLabel }, { id: den.id, period: den.periodLabel }] : [],
    available: Boolean(num && den),
    note: num && den && num.periodLabel !== den.periodLabel ? 'Inputs cover different reporting periods; compare with care.' : undefined
  });
  return {
    budgetUtilisation: mk('Budget utilisation', spent, budget, 'ACTUAL_EXPENDITURE ÷ (REVISED_BUDGET, else APPROVED_BUDGET) × 100'),
    developmentAbsorption: mk('Development absorption', devSpent, devBudget, 'DEVELOPMENT_EXPENDITURE ÷ DEVELOPMENT_BUDGET × 100')
  };
}

export function financePublicRouter() {
  const r = Router();

  r.get('/budgets/years', async (req, res) => {
    const q = parse(z.object({ countyId: objectId.optional() }).passthrough(), req.query);
    const years = await BudgetFigure.distinct('financialYear', { ...publicFilter, ...(q.countyId ? { countyId: q.countyId } : {}) });
    const dYears = await TreasuryDisbursement.distinct('financialYear', { ...publicFilter, ...(q.countyId ? { countyId: q.countyId } : {}) });
    res.json({ items: [...new Set([...years, ...dYears])].sort().reverse() });
  });

  r.get('/budgets/summary', async (req, res) => {
    const q = parse(z.object({ countyId: objectId, financialYear: fy, departmentId: objectId.optional(), fundingSource: z.string().max(100).optional() }).passthrough(), req.query);
    const key = `public:budget-summary:${JSON.stringify(q)}`;
    res.json(
      await cached(key, 30_000, async () => {
        const county = await County.findById(q.countyId).lean();
        if (!county) throw notFound('County not found');
        const filter: Record<string, unknown> = { countyId: q.countyId, financialYear: q.financialYear, departmentId: q.departmentId ?? null, projectId: null };
        if (q.fundingSource) filter.fundingSource = q.fundingSource;
        const metrics = await metricSummary(filter);
        const anyData = Object.values(metrics).some((m) => (m as { available?: boolean }).available);
        return {
          county: { id: String(county._id), name: county.name },
          financialYear: q.financialYear,
          metrics,
          derived: derived(metrics as never),
          dataAvailable: anyData,
          message: anyData ? undefined : 'No verified budget information has been published for this county and financial year yet.',
          generatedAt: new Date()
        };
      })
    );
  });

  r.get('/budgets/figures', async (req, res) => {
    const q = parse(
      z.object({
        countyId: objectId.optional(),
        financialYear: fy.optional(),
        departmentId: objectId.optional(),
        metric: z.enum(BUDGET_METRICS).optional(),
        fundingSource: z.string().max(100).optional(),
        projectId: objectId.optional(),
        constituency: z.string().max(100).optional(),
        ward: z.string().max(100).optional()
      }).passthrough(),
      req.query
    );
    const { page, limit, skip } = pageParams(req.query, 200);
    const filter: Record<string, unknown> = { ...publicFilter };
    if (q.countyId) filter.countyId = q.countyId;
    if (q.financialYear) filter.financialYear = q.financialYear;
    if (q.departmentId) filter.departmentId = q.departmentId;
    if (q.metric) filter.metric = q.metric;
    if (q.fundingSource) filter.fundingSource = q.fundingSource;
    if (q.projectId) filter.projectId = q.projectId;
    if (q.constituency) filter.constituencyName = q.constituency;
    if (q.ward) filter.wardName = q.ward;
    const [items, total] = await Promise.all([
      BudgetFigure.find(filter).sort({ financialYear: -1, metric: 1 }).skip(skip).limit(limit).populate('sourceId', SOURCE_FIELDS).populate('departmentId', 'name slug').lean(),
      BudgetFigure.countDocuments(filter)
    ]);
    res.json({ items: items.map((f) => ({ ...presentFigure(f as never), department: f.departmentId ?? null, financialYear: f.financialYear, countyId: f.countyId })), total, page, limit });
  });

  r.get('/budgets/compare', async (req, res) => {
    const q = parse(z.object({ financialYear: fy, metric: z.enum(BUDGET_METRICS) }).passthrough(), req.query);
    const counties = await County.find().sort({ name: 1 }).lean();
    const items = [];
    for (const c of counties) {
      const f = await BudgetFigure.findOne({ ...publicFilter, countyId: c._id, financialYear: q.financialYear, metric: q.metric, departmentId: null, projectId: null }).sort({ periodEnd: -1 }).populate('sourceId', SOURCE_FIELDS).lean();
      items.push({ county: { id: String(c._id), name: c.name, slug: c.slug }, figure: f ? presentFigure(f as never) : null });
    }
    res.json({ financialYear: q.financialYear, metric: q.metric, items });
  });

  r.get('/departments', async (req, res) => {
    const q = parse(z.object({ countyId: objectId }).passthrough(), req.query);
    res.json({ items: await Department.find({ countyId: q.countyId, active: true }).sort({ name: 1 }).lean() });
  });

  r.get('/departments/:id', async (req, res) => {
    const q = parse(z.object({ financialYear: fy.optional() }).passthrough(), req.query);
    const dept = await Department.findById(String(req.params.id)).lean();
    if (!dept) throw notFound();
    const years = await BudgetFigure.distinct('financialYear', { ...publicFilter, departmentId: dept._id });
    const year = q.financialYear ?? years.sort().reverse()[0];
    const metrics = year ? await metricSummary({ departmentId: dept._id, financialYear: year, projectId: null }) : null;
    const [projects, findings, projectFigures] = await Promise.all([
      Project.find({ ...publicFilter, departmentId: dept._id }).select('reference name status approvedBudgetCents revisedBudgetCents amountPaidCents physicalProgress financialYear').limit(100).lean(),
      AuditFinding.find({ ...publicFilter, departmentId: dept._id }).select('findingKey financialYear category amountQuestionedCents description reportTitle latestKnownStatus').limit(100).lean(),
      year ? BudgetFigure.find({ ...publicFilter, departmentId: dept._id, financialYear: year, projectId: { $ne: null } }).populate('projectId', 'reference name').populate('sourceId', SOURCE_FIELDS).lean() : []
    ]);
    res.json({
      department: dept,
      financialYear: year ?? null,
      availableYears: years.sort().reverse(),
      metrics,
      derived: metrics ? derived(metrics as never) : null,
      projectAllocations: projectFigures.map((f) => ({ ...presentFigure(f as never), project: f.projectId })),
      projects,
      auditFindings: findings,
      explanation:
        'Allocation (what the budget provides), release (what Treasury transfers), receipt (what the county records as received), expenditure (what is paid out) and physical delivery (what exists on the ground) are separate measures and are shown separately.'
    });
  });

  r.get('/disbursements', async (req, res) => {
    const q = parse(z.object({ countyId: objectId.optional(), financialYear: fy }).passthrough(), req.query);
    const counties = q.countyId ? await County.find({ _id: q.countyId }).lean() : await County.find().sort({ name: 1 }).lean();
    const items = [];
    for (const c of counties) {
      const rows = await TreasuryDisbursement.find({ ...publicFilter, countyId: c._id, financialYear: q.financialYear }).sort({ asOfDate: -1 }).populate('sourceId', SOURCE_FIELDS).lean();
      const latest = Object.fromEntries(
        DISBURSEMENT_STAGES.map((st) => {
          const row = rows.find((x) => x.stage === st);
          return [st, row ? { amountKes: row.amountCents / 100, asOfDate: row.asOfDate, source: row.sourceId, publicationDate: row.publicationDate ?? null, explanation: row.officialExplanation ?? null, verificationStatus: row.verificationStatus, id: String(row._id) } : null];
        })
      ) as Record<string, { amountKes: number; asOfDate: Date } | null>;
      const sched = latest.SCHEDULED;
      const disb = latest.DISBURSED;
      items.push({
        county: { id: String(c._id), name: c.name, slug: c.slug },
        stages: latest,
        outstandingAgainstSchedule:
          sched && disb
            ? {
                amountKes: Math.round((sched.amountKes - disb.amountKes) * 100) / 100,
                formula: 'SCHEDULED (cumulative) − DISBURSED (cumulative)',
                note: sched.asOfDate.getTime() !== disb.asOfDate.getTime() ? 'Schedule and disbursement figures have different as-of dates.' : undefined
              }
            : null,
        history: rows.map((x) => ({ stage: x.stage, amountKes: x.amountCents / 100, asOfDate: x.asOfDate, scheduleLabel: x.scheduleLabel, source: x.sourceId, explanation: x.officialExplanation })),
        note: 'An approved allocation is not evidence that funds were released or received. Each stage is reported only where documented.'
      });
    }
    res.json({ financialYear: q.financialYear, items });
  });

  return r;
}

// ------------------------- admin -------------------------

const figureBody = z.object({
  countyId: objectId,
  financialYear: fy,
  departmentId: objectId.nullable().optional(),
  projectId: objectId.nullable().optional(),
  constituencyName: z.string().max(100).optional(),
  wardName: z.string().max(100).optional(),
  fundingSource: z.string().max(100).optional(),
  metric: z.enum(BUDGET_METRICS),
  /** KES for money metrics, percent for percentage metrics. */
  value: z.number().finite(),
  periodLabel: z.string().min(2).max(100),
  periodStart: z.coerce.date().optional(),
  periodEnd: z.coerce.date(),
  publicationDate: z.coerce.date().optional(),
  sourceId: objectId,
  sourcePage: z.string().max(50).optional(),
  verificationStatus: z.enum(VERIFICATION_STATUSES).default('OFFICIAL_SOURCE_REPORTED'),
  notes: z.string().max(2000).optional()
});

export function toFigureDoc(b: z.infer<typeof figureBody>) {
  const isPct = PERCENT_METRICS.includes(b.metric);
  if (!isPct && b.value < 0 && b.metric !== 'UNSPENT_BALANCE') throw badRequest('Monetary values cannot be negative for this metric');
  return { ...b, value: Math.round(b.value * 100), unit: isPct ? 'BASIS_POINTS' : 'KES_CENTS' };
}

const disbursementBody = z.object({
  countyId: objectId,
  financialYear: fy,
  stage: z.enum(DISBURSEMENT_STAGES),
  fundingStream: z.string().max(100).default('EQUITABLE_SHARE'),
  amountKes: z.number().finite().min(0),
  asOfDate: z.coerce.date(),
  scheduleLabel: z.string().max(100).optional(),
  officialExplanation: z.string().max(2000).optional(),
  publicationDate: z.coerce.date().optional(),
  sourceId: objectId,
  sourcePage: z.string().max(50).optional(),
  verificationStatus: z.enum(VERIFICATION_STATUSES).default('OFFICIAL_SOURCE_REPORTED')
});

export function financeAdminRouter() {
  const r = Router();
  const imp = requirePermission('finance.import');
  const anyFinance = requirePermission('finance.import', 'finance.review', 'finance.publish', 'projects.manage');

  r.get('/records/:kind', anyFinance, async (req, res) => {
    const kind = parse(z.enum(RECORD_KINDS), req.params.kind) as RecordKind;
    const q = parse(z.object({ workflowStatus: z.enum(WORKFLOW_STATUSES).optional(), countyId: objectId.optional(), financialYear: z.string().optional(), current: z.enum(['true', 'false', 'all']).default('all') }).passthrough(), req.query);
    const { page, limit, skip } = pageParams(req.query, 200);
    const filter: Record<string, unknown> = { ...scopeFilter(req.user!) };
    if (q.workflowStatus) filter.workflowStatus = q.workflowStatus;
    if (q.countyId) filter.countyId = new Types.ObjectId(q.countyId);
    if (q.financialYear) filter.financialYear = q.financialYear;
    if (q.current !== 'all') filter.isCurrent = q.current === 'true';
    const model = modelFor(kind);
    const [items, total] = await Promise.all([
      model.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).populate('sourceId', 'name documentTitle url').lean(),
      model.countDocuments(filter)
    ]);
    res.json({ items, total, page, limit });
  });

  r.get('/records/:kind/:id/history', anyFinance, async (req, res) => {
    const kind = parse(z.enum(RECORD_KINDS), req.params.kind) as RecordKind;
    const model = modelFor(kind);
    type Rec = Record<string, unknown> & { _id: unknown; supersedesId?: unknown };
    const chain: Rec[] = [];
    let cur = (await model.findById(String(req.params.id)).lean()) as Rec | null;
    if (!cur) throw notFound();
    if (!inScope(req.user!, cur as never)) throw forbidden();
    // Walk back through superseded revisions, and forward through newer ones.
    while (cur) {
      chain.push(cur);
      cur = cur.supersedesId ? ((await model.findById(cur.supersedesId).lean()) as Rec | null) : null;
    }
    let fwd = (await model.findOne({ supersedesId: chain[0]!._id }).lean()) as Rec | null;
    while (fwd) {
      chain.unshift(fwd);
      fwd = (await model.findOne({ supersedesId: fwd._id }).lean()) as Rec | null;
    }
    res.json({ items: chain });
  });

  r.post('/records/:kind/:id/advance', anyFinance, async (req, res) => {
    const kind = parse(z.enum(RECORD_KINDS), req.params.kind) as RecordKind;
    const body = parse(z.object({ to: z.enum(['VALIDATED', 'REVIEWED', 'PUBLISHED']), note: z.string().max(2000).optional() }), req.body);
    const doc = await advanceRecord(kind, String(req.params.id), body.to, req.user!, body.note, req.ip);
    res.json({ record: doc });
  });

  r.post('/records/:kind/:id/correct', anyFinance, async (req, res) => {
    const kind = parse(z.enum(RECORD_KINDS), req.params.kind) as RecordKind;
    const body = parse(z.object({ changes: z.record(z.unknown()), reason: z.string().min(10).max(2000) }), req.body);
    const changes = normaliseChanges(kind, body.changes);
    const doc = await correctRecord(kind, String(req.params.id), changes, body.reason, req.user!, req.ip);
    res.status(201).json({ record: doc });
  });

  r.patch('/records/:kind/:id', anyFinance, async (req, res) => {
    const kind = parse(z.enum(RECORD_KINDS), req.params.kind) as RecordKind;
    const body = parse(z.object({ changes: z.record(z.unknown()) }), req.body);
    const doc = await editUnpublished(kind, String(req.params.id), normaliseChanges(kind, body.changes), req.user!, req.ip);
    res.json({ record: doc });
  });

  r.post('/figures', imp, async (req, res) => {
    const body = parse(figureBody, req.body);
    if (!inScope(req.user!, body)) throw forbidden();
    if (!(await DataSource.exists({ _id: body.sourceId }))) throw badRequest('Unknown source');
    const doc = await withTransaction(async (s) => {
      const [d] = await BudgetFigure.create([{ ...toFigureDoc(body), createdBy: req.user!.id }], { session: s });
      await recordAudit(s, { actor: { id: req.user!.id, role: req.user!.role, ip: req.ip }, action: 'BudgetFigure.created', entityType: 'BudgetFigure', entityId: String(d!._id), after: body });
      return d!;
    });
    res.status(201).json({ record: doc });
  });

  r.post('/disbursements', imp, async (req, res) => {
    const body = parse(disbursementBody, req.body);
    if (!inScope(req.user!, body)) throw forbidden();
    if (!(await DataSource.exists({ _id: body.sourceId }))) throw badRequest('Unknown source');
    const { amountKes, ...rest } = body;
    const doc = await withTransaction(async (s) => {
      const [d] = await TreasuryDisbursement.create([{ ...rest, amountCents: Math.round(amountKes * 100), createdBy: req.user!.id }], { session: s });
      await recordAudit(s, { actor: { id: req.user!.id, role: req.user!.role, ip: req.ip }, action: 'TreasuryDisbursement.created', entityType: 'TreasuryDisbursement', entityId: String(d!._id), after: body });
      return d!;
    });
    res.status(201).json({ record: doc });
  });

  r.post('/departments', imp, async (req, res) => {
    const body = parse(z.object({ countyId: objectId, name: z.string().min(2).max(200) }), req.body);
    if (!inScope(req.user!, body)) throw forbidden();
    const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const d = await Department.create({ ...body, slug });
    res.status(201).json({ department: d });
  });

  return r;
}

/** Converts KES inputs in correction payloads to stored cents for the given record kind. */
function normaliseChanges(kind: RecordKind, changes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...changes };
  const kesToCents = (k: string, target: string) => {
    if (k in out) {
      const v = out[k];
      if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw badRequest(`${k} must be a non-negative number`);
      out[target] = v === null ? null : Math.round((v as number) * 100);
      delete out[k];
    }
  };
  if (kind === 'BUDGET_FIGURE' && 'value' in out) {
    if (typeof out.value !== 'number' || !Number.isFinite(out.value)) throw badRequest('value must be a number');
    out.value = Math.round((out.value as number) * 100);
  }
  if (kind === 'DISBURSEMENT') kesToCents('amountKes', 'amountCents');
  if (kind === 'PROJECT') {
    kesToCents('approvedBudgetKes', 'approvedBudgetCents');
    kesToCents('revisedBudgetKes', 'revisedBudgetCents');
    kesToCents('amountPaidKes', 'amountPaidCents');
  }
  if (kind === 'AUDIT_FINDING') kesToCents('amountQuestionedKes', 'amountQuestionedCents');
  for (const k of Object.keys(out)) if (k.startsWith('$') || k.includes('.')) throw badRequest('Invalid field name');
  return out;
}
