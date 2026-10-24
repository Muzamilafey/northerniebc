import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { withTransaction } from '../../db/mongo.js';
import { recordAudit, recordAuditStandalone } from '../../lib/audit.js';
import { decryptOptional, encryptOptional, sha256 } from '../../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { datedReference } from '../../lib/ids.js';
import { escapeRegex, pageParams, parse } from '../../lib/http.js';
import { inScope, scopeFilter } from '../../lib/permissions.js';
import { upload } from '../../lib/upload.js';
import { requirePermission } from '../../middleware/auth.js';
import { ipHash, publicFormLimiter, limiter } from '../../middleware/security.js';
import { AuditFinding, CITIZEN_REPORT_TYPES, CitizenReport, DataSource, FINDING_CATEGORIES, isValidFinancialYear, publicFilter, StoredFile, VERIFICATION_STATUSES } from '../../models/index.js';
import { ALLOWED_MIME, saveFile } from '../files/storage.js';
import { objectId } from '../users/routes.js';

const SOURCE_FIELDS = 'name publisher url documentTitle publicationDate kind';

export const CATEGORY_LABELS: Record<(typeof FINDING_CATEGORIES)[number], string> = {
  UNSUPPORTED_EXPENDITURE: 'Unsupported expenditure',
  IRREGULAR_EXPENDITURE: 'Irregular expenditure',
  UNEXPLAINED_DISCREPANCY: 'Unexplained financial discrepancy',
  PENDING_BILLS: 'Pending bills',
  DELAYED_PROJECT: 'Delayed project',
  RECOMMENDED_FOR_RECOVERY: 'Amount recommended for recovery',
  CONFIRMED_LOSS: 'Confirmed financial loss',
  ALLEGATION_UNDER_INVESTIGATION: 'Allegation under investigation',
  OTHER: 'Other audit matter'
};

function presentFinding(f: Record<string, unknown>) {
  return {
    id: String(f._id),
    findingKey: f.findingKey,
    countyId: f.countyId,
    financialYear: f.financialYear,
    entity: f.entity,
    department: f.departmentId ?? null,
    category: f.category,
    categoryLabel: CATEGORY_LABELS[f.category as keyof typeof CATEGORY_LABELS],
    amountQuestionedKes: typeof f.amountQuestionedCents === 'number' ? f.amountQuestionedCents / 100 : null,
    description: f.description,
    reportTitle: f.reportTitle,
    pageNumber: f.pageNumber ?? null,
    reportPublicationDate: f.reportPublicationDate ?? null,
    managementResponse: f.managementResponse ?? null,
    auditorRecommendation: f.auditorRecommendation ?? null,
    recoveryOrInvestigationStatus: f.recoveryOrInvestigationStatus ?? null,
    latestKnownStatus: f.latestKnownStatus,
    latestStatusDate: f.latestStatusDate ?? null,
    sourceUrl: f.sourceUrl ?? null,
    source: f.sourceId ?? null,
    verificationStatus: f.verificationStatus,
    revision: f.revision,
    correctionReason: f.correctionReason ?? null,
    publishedAt: f.publishedAt
  };
}

const WORDING_NOTE =
  'Audit queries, unsupported or irregular expenditure, and allegations are not findings of theft or misconduct. Wording follows the cited report; only a court or competent authority can establish wrongdoing.';

async function verifyTurnstile(token: string | undefined, ip?: string) {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, ...(ip ? { remoteip: ip } : {}) })
  }).catch(() => null);
  if (!r?.ok) return false;
  return Boolean(((await r.json()) as { success?: boolean }).success);
}

export function accountabilityPublicRouter() {
  const r = Router();

  r.get('/audit-findings', async (req, res) => {
    const q = parse(
      z.object({ countyId: objectId.optional(), financialYear: z.string().max(10).optional(), category: z.enum(FINDING_CATEGORIES).optional(), departmentId: objectId.optional(), q: z.string().max(100).optional() }).passthrough(),
      req.query
    );
    const { page, limit, skip } = pageParams(req.query);
    const filter: Record<string, unknown> = { ...publicFilter };
    if (q.countyId) filter.countyId = q.countyId;
    if (q.financialYear) filter.financialYear = q.financialYear;
    if (q.category) filter.category = q.category;
    if (q.departmentId) filter.departmentId = q.departmentId;
    if (q.q) filter.$or = [{ description: new RegExp(escapeRegex(q.q), 'i') }, { entity: new RegExp(escapeRegex(q.q), 'i') }];
    const [items, total] = await Promise.all([
      AuditFinding.find(filter).sort({ financialYear: -1, amountQuestionedCents: -1 }).skip(skip).limit(limit).populate('sourceId', SOURCE_FIELDS).populate('departmentId', 'name').lean(),
      AuditFinding.countDocuments(filter)
    ]);
    res.json({ items: items.map((f) => presentFinding(f as never)), total, page, limit, categoryLabels: CATEGORY_LABELS, wordingNote: WORDING_NOTE });
  });

  r.get('/audit-findings/:key', async (req, res) => {
    const key = String(req.params.key);
    const f = await AuditFinding.findOne({ findingKey: key, ...publicFilter }).populate('sourceId', SOURCE_FIELDS).populate('departmentId', 'name').lean();
    if (!f) throw notFound();
    const history = await AuditFinding.find({ findingKey: key, workflowStatus: 'PUBLISHED' }).sort({ revision: -1 }).select('revision latestKnownStatus latestStatusDate recoveryOrInvestigationStatus correctionReason publishedAt isCurrent').lean();
    res.json({ finding: presentFinding(f as never), history, wordingNote: WORDING_NOTE });
  });

  r.get('/sources', async (req, res) => {
    const q = parse(z.object({ q: z.string().max(100).optional(), kind: z.string().max(40).optional() }).passthrough(), req.query);
    const { page, limit, skip } = pageParams(req.query);
    const filter: Record<string, unknown> = { verificationStatus: 'REVIEWED' };
    if (q.kind) filter.kind = q.kind;
    if (q.q) filter.$or = [{ name: new RegExp(escapeRegex(q.q), 'i') }, { documentTitle: new RegExp(escapeRegex(q.q), 'i') }];
    const [items, total] = await Promise.all([
      DataSource.find(filter).sort({ publicationDate: -1, name: 1 }).skip(skip).limit(limit).select('-createdBy -notes').lean(),
      DataSource.countDocuments(filter)
    ]);
    res.json({ items, total, page, limit });
  });

  // ---- Citizen reporting ----
  r.get('/citizen-reports', async (req, res) => {
    const q = parse(z.object({ countyId: objectId.optional(), type: z.enum(CITIZEN_REPORT_TYPES).optional() }).passthrough(), req.query);
    const { page, limit, skip } = pageParams(req.query);
    const filter: Record<string, unknown> = { status: { $in: ['PUBLISHED', 'RESOLVED'] } };
    if (q.countyId) filter.countyId = q.countyId;
    if (q.type) filter.type = q.type;
    const [items, total] = await Promise.all([
      CitizenReport.find(filter).sort({ reviewedAt: -1 }).skip(skip).limit(limit).select('reference type title publicSummary countyId locationText projectId status reviewedAt createdAt').lean(),
      CitizenReport.countDocuments(filter)
    ]);
    res.json({
      items: items.map((x) => ({ ...x, label: 'Citizen-reported. Reviewed for publication by moderators; not an established fact.' })),
      total,
      page,
      limit
    });
  });

  r.post('/citizen-reports', publicFormLimiter(), upload.array('files', 3), async (req, res) => {
    const body = parse(
      z.object({
        type: z.enum(CITIZEN_REPORT_TYPES),
        title: z.string().min(5).max(200),
        description: z.string().min(20).max(5000),
        countyId: objectId.optional(),
        locationText: z.string().max(300).optional(),
        lat: z.coerce.number().min(-5).max(6).optional(),
        lng: z.coerce.number().min(33).max(43).optional(),
        projectId: objectId.optional(),
        relatedUrl: z.string().url().max(500).optional(),
        reporterName: z.string().max(200).optional(),
        reporterContact: z.string().max(200).optional(),
        consentPrivacy: z.enum(['true']),
        website: z.string().max(0).optional(), // honeypot: must be empty
        turnstileToken: z.string().max(4000).optional()
      }),
      req.body
    );
    if (!(await verifyTurnstile(body.turnstileToken, req.ip))) throw forbidden('Verification challenge failed');
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const ih = ipHash(req);
    const contentHash = sha256(`${body.type}|${body.countyId ?? ''}|${body.description.toLowerCase().replace(/\s+/g, ' ').trim()}`);
    const dup = await CitizenReport.findOne({ contentHash, createdAt: { $gt: new Date(Date.now() - 30 * 86400_000) } }).lean();
    const saved = [];
    for (const f of files) {
      saved.push(await saveFile(f.buffer, { purpose: 'CITIZEN_REPORT', allowed: [...ALLOWED_MIME.image, ...ALLOWED_MIME.document], originalName: f.originalname, uploaderIpHash: ih }));
    }
    const report = await CitizenReport.create({
      reference: datedReference('CR'),
      type: body.type,
      title: body.title,
      description: body.description,
      countyId: body.countyId,
      locationText: body.locationText,
      location: body.lat != null && body.lng != null ? { lat: body.lat, lng: body.lng, verified: false } : undefined,
      projectId: body.projectId,
      relatedUrl: body.relatedUrl,
      fileIds: saved.map((f) => f._id),
      reporterNameEnc: encryptOptional(body.reporterName),
      reporterContactEnc: encryptOptional(body.reporterContact),
      contentHash,
      ipHash: ih,
      duplicateOfId: dup?._id,
      moderationNotes: dup ? [{ note: `Possible duplicate of ${dup.reference}`, at: new Date() }] : []
    });
    res.status(201).json({
      reference: report.reference,
      status: 'RECEIVED',
      message: 'Thank you. Your report has been received and will be reviewed. It remains unverified until reviewed, and personal details are never published.'
    });
  });

  r.post('/citizen-reports/:reference/abuse', limiter('abuse', { windowMs: 60 * 60_000, limit: 10 }), async (req, res) => {
    const body = parse(z.object({ reason: z.string().min(5).max(500) }), req.body);
    const r2 = await CitizenReport.findOneAndUpdate(
      { reference: String(req.params.reference), status: { $in: ['PUBLISHED', 'RESOLVED'] } },
      { $push: { abuseReports: { reason: body.reason, at: new Date(), ipHash: ipHash(req) } } }
    );
    if (!r2) throw notFound();
    res.status(202).json({ message: 'Thank you. Moderators will review this report.' });
  });

  return r;
}

const findingBody = z.object({
  findingKey: z.string().min(3).max(120),
  countyId: objectId,
  financialYear: z.string().refine(isValidFinancialYear, 'Financial year must look like 2023/24'),
  entity: z.string().min(2).max(300),
  departmentId: objectId.optional(),
  category: z.enum(FINDING_CATEGORIES),
  amountQuestionedKes: z.number().min(0).optional(),
  description: z.string().min(10).max(10000),
  reportTitle: z.string().min(5).max(500),
  pageNumber: z.string().max(20).optional(),
  reportPublicationDate: z.coerce.date().optional(),
  managementResponse: z.string().max(10000).optional(),
  auditorRecommendation: z.string().max(10000).optional(),
  recoveryOrInvestigationStatus: z.string().max(2000).optional(),
  latestKnownStatus: z.string().max(500).default('As reported'),
  latestStatusDate: z.coerce.date().optional(),
  sourceUrl: z.string().url().max(1000).optional(),
  sourceId: objectId,
  sourcePage: z.string().max(50).optional(),
  verificationStatus: z.enum(VERIFICATION_STATUSES).default('OFFICIAL_SOURCE_REPORTED')
});
export { findingBody };
export function toFindingDoc(b: z.infer<typeof findingBody>) {
  if ((b.category === 'CONFIRMED_LOSS' || b.category === 'ALLEGATION_UNDER_INVESTIGATION') && !b.recoveryOrInvestigationStatus) {
    throw badRequest('This category requires the documented determination or investigation status, as worded by the competent authority');
  }
  const { amountQuestionedKes, ...rest } = b;
  return { ...rest, amountQuestionedCents: amountQuestionedKes == null ? undefined : Math.round(amountQuestionedKes * 100) };
}

export function accountabilityAdminRouter() {
  const r = Router();

  r.post('/audit-findings', requirePermission('finance.import'), async (req, res) => {
    const body = parse(findingBody, req.body);
    if (!inScope(req.user!, body)) throw forbidden();
    if (!(await DataSource.exists({ _id: body.sourceId }))) throw badRequest('Unknown source');
    if (await AuditFinding.exists({ findingKey: body.findingKey, isCurrent: true })) throw conflict('Finding key already exists; submit a correction or status update instead');
    const doc = await withTransaction(async (s) => {
      const [d] = await AuditFinding.create([{ ...toFindingDoc(body), createdBy: req.user!.id }], { session: s });
      await recordAudit(s, { actor: { id: req.user!.id, role: req.user!.role, ip: req.ip }, action: 'AuditFinding.created', entityType: 'AuditFinding', entityId: String(d!._id), after: body });
      return d!;
    });
    res.status(201).json({ record: doc });
  });

  // ---- Sources ----
  const sourceBody = z.object({
    name: z.string().min(2).max(300),
    publisher: z.string().max(300).optional(),
    url: z.string().url().max(1000).optional(),
    documentTitle: z.string().max(500).optional(),
    publicationDate: z.coerce.date().optional(),
    financialYear: z.string().max(10).optional(),
    electionId: objectId.optional(),
    retrievedAt: z.coerce.date().optional(),
    kind: z.enum(['PORTAL', 'BUDGET_DOCUMENT', 'COB_REPORT', 'AUDIT_REPORT', 'TREASURY_RELEASE', 'ELECTION_PUBLICATION', 'GAZETTE', 'INSPECTION', 'OTHER']).default('OTHER'),
    notes: z.string().max(2000).optional()
  });

  r.get('/sources', requirePermission('sources.manage', 'finance.import', 'projects.manage'), async (req, res) => {
    const { page, limit, skip } = pageParams(req.query, 200);
    const [items, total] = await Promise.all([DataSource.find().sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), DataSource.countDocuments()]);
    res.json({ items, total, page, limit });
  });

  r.post('/sources', requirePermission('sources.manage', 'finance.import', 'projects.manage'), async (req, res) => {
    const body = parse(sourceBody, req.body);
    const doc = await withTransaction(async (s) => {
      const [d] = await DataSource.create([{ ...body, retrievedAt: body.retrievedAt ?? new Date(), createdBy: req.user!.id }], { session: s });
      await recordAudit(s, { actor: { id: req.user!.id, role: req.user!.role, ip: req.ip }, action: 'DataSource.created', entityType: 'DataSource', entityId: String(d!._id), after: body });
      return d!;
    });
    res.status(201).json({ source: doc });
  });

  r.post('/sources/:id/document', requirePermission('sources.manage', 'finance.import'), upload.single('file'), async (req, res) => {
    const src = await DataSource.findById(String(req.params.id));
    if (!src) throw notFound();
    if (!req.file) throw badRequest('No file uploaded');
    const f = await saveFile(req.file.buffer, { purpose: 'SOURCE_DOCUMENT', allowed: [...ALLOWED_MIME.document, ...ALLOWED_MIME.spreadsheet, ...ALLOWED_MIME.image], originalName: req.file.originalname, uploadedBy: req.user!.id, visibility: 'PUBLIC' });
    await withTransaction(async (s) => {
      src.fileId = f._id;
      src.checksum = f.sha256;
      await src.save({ session: s });
      await recordAudit(s, { actor: { id: req.user!.id, role: req.user!.role, ip: req.ip }, action: 'DataSource.document_attached', entityType: 'DataSource', entityId: String(src._id), after: { fileId: String(f._id), sha256: f.sha256 } });
    });
    res.json({ source: src });
  });

  r.post('/sources/:id/review', requirePermission('sources.manage'), async (req, res) => {
    const body = parse(z.object({ decision: z.enum(['REVIEWED', 'REJECTED']), note: z.string().min(3).max(2000) }), req.body);
    const src = await DataSource.findById(String(req.params.id));
    if (!src) throw notFound();
    if (env.FOUR_EYES_IMPORTS && String(src.createdBy) === req.user!.id) throw forbidden('A different person must review this source');
    await withTransaction(async (s) => {
      const before = src.verificationStatus;
      src.verificationStatus = body.decision;
      await src.save({ session: s });
      await recordAudit(s, { actor: { id: req.user!.id, role: req.user!.role, ip: req.ip }, action: 'DataSource.reviewed', entityType: 'DataSource', entityId: String(src._id), before: { verificationStatus: before }, after: { verificationStatus: body.decision }, meta: { note: body.note } });
    });
    res.json({ source: src });
  });

  // ---- Citizen report moderation ----
  const moderate = requirePermission('citizen.moderate');

  r.get('/citizen-reports', moderate, async (req, res) => {
    const q = parse(z.object({ status: z.enum(['RECEIVED', 'UNDER_REVIEW', 'PUBLISHED', 'REJECTED', 'DUPLICATE', 'RESOLVED']).optional(), abuse: z.enum(['true']).optional() }).passthrough(), req.query);
    const { page, limit, skip } = pageParams(req.query);
    const sf = scopeFilter(req.user!);
    const filter: Record<string, unknown> = { ...(Object.keys(sf).length ? { $or: [sf, { countyId: null }] } : {}) };
    if (q.status) filter.status = q.status;
    if (q.abuse) filter['abuseReports.0'] = { $exists: true };
    const [items, total] = await Promise.all([
      CitizenReport.find(filter).select('-reporterNameEnc -reporterContactEnc -ipHash').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      CitizenReport.countDocuments(filter)
    ]);
    res.json({ items, total, page, limit });
  });

  r.get('/citizen-reports/:id', moderate, async (req, res) => {
    const rep = await CitizenReport.findById(String(req.params.id)).populate('fileIds', 'originalName mime size scanStatus').populate('duplicateOfId', 'reference title status').lean();
    if (!rep) throw notFound();
    if (rep.countyId && !inScope(req.user!, rep)) throw forbidden();
    const { reporterNameEnc, reporterContactEnc, ipHash: _ip, ...rest } = rep;
    const similar = await CitizenReport.find({ _id: { $ne: rep._id }, $or: [{ contentHash: rep.contentHash }, ...(rep.projectId ? [{ projectId: rep.projectId }] : [])] }).select('reference title status createdAt').limit(10).lean();
    res.json({ report: { ...rest, hasReporterContact: Boolean(reporterContactEnc || reporterNameEnc) }, similar });
  });

  /** Reporter identity is revealed only on explicit request, and the access is audited. */
  r.post('/citizen-reports/:id/reveal-contact', moderate, async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().min(10).max(500) }), req.body);
    const rep = await CitizenReport.findById(String(req.params.id)).lean();
    if (!rep) throw notFound();
    if (rep.countyId && !inScope(req.user!, rep)) throw forbidden();
    await recordAuditStandalone({ actor: { id: req.user!.id, role: req.user!.role, ip: req.ip }, action: 'CitizenReport.contact_revealed', entityType: 'CitizenReport', entityId: String(rep._id), meta: { reason } });
    res.json({ reporterName: decryptOptional(rep.reporterNameEnc), reporterContact: decryptOptional(rep.reporterContactEnc) });
  });

  r.post('/citizen-reports/:id/moderate', moderate, async (req, res) => {
    const body = parse(
      z.object({
        status: z.enum(['UNDER_REVIEW', 'PUBLISHED', 'REJECTED', 'DUPLICATE', 'RESOLVED']),
        note: z.string().min(3).max(2000),
        publicSummary: z.string().min(10).max(2000).optional(),
        duplicateOfId: objectId.optional(),
        publishFileIds: z.array(objectId).max(3).default([])
      }),
      req.body
    );
    const rep = await CitizenReport.findById(String(req.params.id));
    if (!rep) throw notFound();
    if (rep.countyId && !inScope(req.user!, rep)) throw forbidden();
    if (body.status === 'PUBLISHED' && !body.publicSummary && !rep.publicSummary) throw badRequest('A moderator-written public summary (without personal data or unproven accusations) is required to publish');
    if (body.status === 'DUPLICATE' && !body.duplicateOfId) throw badRequest('Specify the original report');
    const before = { status: rep.status, publicSummary: rep.publicSummary };
    await withTransaction(async (s) => {
      rep.status = body.status;
      if (body.publicSummary) rep.publicSummary = body.publicSummary;
      if (body.duplicateOfId) rep.set('duplicateOfId', body.duplicateOfId);
      rep.moderationNotes.push({ note: body.note, by: req.user!.id, at: new Date() } as never);
      rep.set('reviewedBy', req.user!.id);
      rep.reviewedAt = new Date();
      await rep.save({ session: s });
      if (body.publishFileIds.length) {
        const allowed = body.publishFileIds.filter((id) => rep.fileIds.map(String).includes(id));
        await StoredFile.updateMany({ _id: { $in: allowed }, scanStatus: 'CLEAN' }, { $set: { visibility: 'PUBLIC' } }, { session: s });
      }
      await recordAudit(s, { actor: { id: req.user!.id, role: req.user!.role, ip: req.ip }, action: 'CitizenReport.moderated', entityType: 'CitizenReport', entityId: String(rep._id), before, after: { status: body.status, publicSummary: body.publicSummary }, meta: { note: body.note } });
    });
    res.json({ report: { id: String(rep._id), status: rep.status } });
  });

  return r;
}
