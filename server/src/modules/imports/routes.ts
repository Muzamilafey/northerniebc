import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { withTransaction } from '../../db/mongo.js';
import { recordAudit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { pageParams, parse } from '../../lib/http.js';
import { enqueueOutbox } from '../../lib/outbox.js';
import { can, type Permission } from '../../lib/permissions.js';
import { upload } from '../../lib/upload.js';
import { requireAuth, mfaSatisfied } from '../../middleware/auth.js';
import { DataSource, Election, ImportJob, ImportRow, StoredFile } from '../../models/index.js';
import type { AuthUser } from '../../types/express.js';
import { ALLOWED_MIME, readStoredFile, saveFile } from '../files/storage.js';
import { objectId } from '../users/routes.js';
import { IMPORTERS, loadCounties, matchOfficialResults, type ImportContext } from './importers.js';
import { parseTable } from './parse.js';

const KINDS = Object.keys(IMPORTERS) as [string, ...string[]];

const REVIEW_PERMISSION: Record<string, Permission[]> = {
  BUDGET_FIGURES: ['finance.review'],
  TREASURY_DISBURSEMENTS: ['finance.review'],
  AUDIT_FINDINGS: ['finance.review'],
  PROJECTS: ['finance.review', 'projects.manage'],
  PAYMENT_RECONCILIATION: ['donations.reconcile']
};
const PUBLISH_PERMISSION: Record<string, Permission[]> = {
  BUDGET_FIGURES: ['finance.publish'],
  TREASURY_DISBURSEMENTS: ['finance.publish'],
  AUDIT_FINDINGS: ['finance.publish'],
  PROJECTS: ['finance.publish']
};

function ensure(user: AuthUser, perms: Permission[]) {
  if (!perms.some((p) => can(user, p))) throw forbidden();
  if (!mfaSatisfied(user)) throw forbidden('Multi-factor authentication is required for this account');
}

const actorOf = (u: AuthUser, ip?: string) => ({ id: u.id, role: u.role, label: u.fullName, ip });

/** Column templates so administrators can prepare files in the expected format. */
export function importTemplates() {
  return Object.fromEntries(Object.entries(IMPORTERS).map(([k, v]) => [k, { columns: v.columns, requiresElection: Boolean(v.requiresElection), requiresSource: v.requiresSource }]));
}

export function importsRouter() {
  const r = Router();

  r.get('/templates', requireAuth, (_req, res) => res.json(importTemplates()));

  r.get('/', requireAuth, async (req, res) => {
    const allowedKinds = KINDS.filter((k) => can(req.user!, IMPORTERS[k]!.permission) || (REVIEW_PERMISSION[k] ?? []).some((p) => can(req.user!, p)));
    if (!allowedKinds.length) throw forbidden();
    const { page, limit, skip } = pageParams(req.query);
    const filter = { kind: { $in: allowedKinds } };
    const [items, total] = await Promise.all([
      ImportJob.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('createdBy', 'fullName').populate('reviewedBy', 'fullName').populate('sourceId', 'name documentTitle').lean(),
      ImportJob.countDocuments(filter)
    ]);
    res.json({ items, total, page, limit });
  });

  r.post('/', requireAuth, upload.single('file'), async (req, res) => {
    const body = parse(z.object({ kind: z.enum(KINDS), electionId: objectId.optional(), sourceId: objectId.optional() }), req.body);
    const imp = IMPORTERS[body.kind]!;
    ensure(req.user!, [imp.permission]);
    if (!req.file) throw badRequest('No file uploaded');
    if (imp.requiresElection && !body.electionId) throw badRequest('electionId is required for this import');
    if (body.electionId && !(await Election.exists({ _id: body.electionId }))) throw badRequest('Unknown election');
    if (imp.requiresSource && !body.sourceId) throw badRequest('A source reference is required: register the source document first');
    if (body.sourceId && !(await DataSource.exists({ _id: body.sourceId }))) throw badRequest('Unknown source');
    const file = await saveFile(req.file.buffer, { purpose: 'IMPORT', allowed: ALLOWED_MIME.spreadsheet, originalName: req.file.originalname, uploadedBy: req.user!.id });
    const rows = await parseTable(req.file.buffer, file.mime);
    if (rows.length === 0) throw badRequest('The file contains no data rows');
    const missing = imp.columns.filter((c) => !(c in rows[0]!));
    const job = await withTransaction(async (s) => {
      const [j] = await ImportJob.create([{ kind: body.kind, electionId: body.electionId, sourceId: body.sourceId, fileId: file._id, originalName: file.originalName, rowCount: rows.length, createdBy: req.user!.id }], { session: s });
      await recordAudit(s, { actor: actorOf(req.user!, req.ip), action: 'import.uploaded', entityType: 'ImportJob', entityId: String(j!._id), meta: { kind: body.kind, rows: rows.length, sha256: file.sha256 } });
      return j!;
    });
    res.status(201).json({ job, missingColumns: missing });
  });

  r.get('/:id', requireAuth, async (req, res) => {
    const job = await ImportJob.findById(String(req.params.id)).populate('createdBy', 'fullName').populate('reviewedBy', 'fullName').populate('publishedBy', 'fullName').populate('sourceId').lean();
    if (!job) throw notFound();
    const kind = job.kind;
    if (!can(req.user!, IMPORTERS[kind]!.permission) && !(REVIEW_PERMISSION[kind] ?? []).some((p) => can(req.user!, p))) throw forbidden();
    const counts = await ImportRow.aggregate([{ $match: { jobId: job._id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
    res.json({ job, counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) });
  });

  r.get('/:id/rows', requireAuth, async (req, res) => {
    const job = await ImportJob.findById(String(req.params.id)).lean();
    if (!job) throw notFound();
    if (!can(req.user!, IMPORTERS[job.kind]!.permission) && !(REVIEW_PERMISSION[job.kind] ?? []).some((p) => can(req.user!, p))) throw forbidden();
    const q = parse(z.object({ status: z.enum(['VALID', 'INVALID', 'DUPLICATE', 'CONFLICT', 'SKIPPED']).optional() }).passthrough(), req.query);
    const { page, limit, skip } = pageParams(req.query, 500);
    const filter: Record<string, unknown> = { jobId: job._id };
    if (q.status) filter.status = q.status;
    const [items, total] = await Promise.all([ImportRow.find(filter).sort({ rowNumber: 1 }).skip(skip).limit(limit).lean(), ImportRow.countDocuments(filter)]);
    res.json({ items, total, page, limit });
  });

  /** IMPORTED → VALIDATED: parse every row, validate, detect duplicates and conflicts. Nothing is published. */
  r.post('/:id/validate', requireAuth, async (req, res) => {
    const job = await ImportJob.findById(String(req.params.id));
    if (!job) throw notFound();
    const imp = IMPORTERS[job.kind]!;
    ensure(req.user!, [imp.permission]);
    if (job.status !== 'IMPORTED') throw conflict(`Job is ${job.status}`);
    const file = await StoredFile.findById(job.fileId).lean();
    if (!file) throw notFound('Import file missing');
    const rows = await parseTable(await readStoredFile(file.storageKey), file.mime);
    const ctx: ImportContext = { jobId: job._id, electionId: job.electionId ?? undefined, sourceId: job.sourceId ?? undefined, actorId: new Types.ObjectId(req.user!.id), counties: await loadCounties() };
    await ImportRow.deleteMany({ jobId: job._id });
    const seen = new Set<string>();
    const docs = [];
    const counts = { VALID: 0, INVALID: 0, DUPLICATE: 0, CONFLICT: 0, SKIPPED: 0 };
    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i]!;
      let chk = await imp.check(raw, ctx).catch((e: Error) => ({ status: 'INVALID' as const, messages: [e.message] }));
      if ('naturalKey' in chk && seen.has(chk.naturalKey)) chk = { status: 'INVALID', messages: ['Duplicate of an earlier row in this file'] };
      const status = chk.status === 'INVALID' && chk.messages[0]?.startsWith('Duplicate of an earlier row') ? 'DUPLICATE' : chk.status;
      if ('naturalKey' in chk) seen.add(chk.naturalKey);
      counts[status]++;
      docs.push({
        jobId: job._id,
        rowNumber: i + 2,
        raw,
        normalized: 'normalized' in chk ? chk.normalized : undefined,
        status,
        messages: 'messages' in chk ? chk.messages : [],
        naturalKey: 'naturalKey' in chk ? chk.naturalKey : undefined,
        targetId: 'targetId' in chk ? chk.targetId : undefined
      });
      if (docs.length >= 1000) await ImportRow.insertMany(docs.splice(0));
    }
    if (docs.length) await ImportRow.insertMany(docs);
    await withTransaction(async (s) => {
      job.status = 'VALIDATED';
      job.validatedAt = new Date();
      job.validCount = counts.VALID;
      job.errorCount = counts.INVALID;
      job.duplicateCount = counts.DUPLICATE;
      job.conflictCount = counts.CONFLICT;
      await job.save({ session: s });
      await recordAudit(s, { actor: actorOf(req.user!, req.ip), action: 'import.validated', entityType: 'ImportJob', entityId: String(job._id), meta: counts });
    });
    res.json({ job, counts });
  });

  /** VALIDATED → REVIEWED: a second person confirms the source and the figures. */
  r.post('/:id/review', requireAuth, async (req, res) => {
    const { note } = parse(z.object({ note: z.string().min(5).max(2000) }), req.body);
    const job = await ImportJob.findById(String(req.params.id));
    if (!job) throw notFound();
    ensure(req.user!, REVIEW_PERMISSION[job.kind] ?? [IMPORTERS[job.kind]!.permission]);
    if (job.status !== 'VALIDATED') throw conflict(`Job is ${job.status}`);
    if (env.FOUR_EYES_IMPORTS && String(job.createdBy) === req.user!.id) throw forbidden('A different person must review this import');
    await withTransaction(async (s) => {
      job.status = 'REVIEWED';
      job.reviewedBy = new Types.ObjectId(req.user!.id);
      job.reviewedAt = new Date();
      job.reviewNote = note;
      await job.save({ session: s });
      await recordAudit(s, { actor: actorOf(req.user!, req.ip), action: 'import.reviewed', entityType: 'ImportJob', entityId: String(job._id), meta: { note } });
    });
    res.json({ job });
  });

  /**
   * REVIEWED → PUBLISHED. Valid rows are applied in transactional batches. Conflicting rows are
   * applied only if explicitly requested with a correction reason, and then supersede (never
   * overwrite) the earlier record.
   */
  r.post('/:id/publish', requireAuth, async (req, res) => {
    const body = parse(z.object({ applyConflicts: z.boolean().default(false), correctionReason: z.string().min(10).max(2000).optional() }), req.body);
    const job = await ImportJob.findById(String(req.params.id));
    if (!job) throw notFound();
    const imp = IMPORTERS[job.kind]!;
    ensure(req.user!, PUBLISH_PERMISSION[job.kind] ?? [imp.permission]);
    if (job.status !== 'REVIEWED' && job.status !== 'PUBLISHING') throw conflict(`Job is ${job.status}`);
    if (body.applyConflicts && !body.correctionReason) throw badRequest('A correction reason is required to apply conflicting rows');
    if (body.applyConflicts && job.kind === 'POLLING_STATIONS') throw badRequest('The station register cannot be overwritten by import; fix conflicts individually');
    await ImportJob.updateOne({ _id: job._id }, { $set: { status: 'PUBLISHING' } });
    const ctx: ImportContext = { jobId: job._id, electionId: job.electionId ?? undefined, sourceId: job.sourceId ?? undefined, actorId: new Types.ObjectId(req.user!.id), counties: await loadCounties() };
    const statuses = body.applyConflicts ? ['VALID', 'CONFLICT'] : ['VALID'];
    let applied = 0;
    for (;;) {
      const batch = await ImportRow.find({ jobId: job._id, status: { $in: statuses }, applied: false }).sort({ rowNumber: 1 }).limit(250).lean();
      if (!batch.length) break;
      await withTransaction(async (s) => {
        for (const row of batch) {
          const targetId = await imp.apply({ normalized: row.normalized as Record<string, unknown>, status: row.status, targetId: row.targetId }, ctx, s, body.correctionReason);
          await ImportRow.updateOne({ _id: row._id }, { $set: { applied: true, ...(targetId ? { targetId } : {}) } }, { session: s });
        }
      });
      applied += batch.length;
    }
    let matchSummary: { matched: number; mismatched: number } | undefined;
    await withTransaction(async (s) => {
      if (job.kind === 'OFFICIAL_RESULTS') matchSummary = await matchOfficialResults(job.electionId!, s);
      await ImportJob.updateOne({ _id: job._id }, { $set: { status: 'PUBLISHED', publishedBy: req.user!.id, publishedAt: new Date(), publishSummary: { applied, applyConflicts: body.applyConflicts, correctionReason: body.correctionReason, matchSummary } } }, { session: s });
      await recordAudit(s, { actor: actorOf(req.user!, req.ip), action: 'import.published', entityType: 'ImportJob', entityId: String(job._id), meta: { kind: job.kind, applied, applyConflicts: body.applyConflicts, correctionReason: body.correctionReason } });
      const outboxType = ['BUDGET_FIGURES', 'TREASURY_DISBURSEMENTS'].includes(job.kind) ? 'finance.published' : job.kind === 'PROJECTS' ? 'projects.published' : job.kind === 'AUDIT_FINDINGS' ? 'accountability.published' : job.kind === 'OFFICIAL_RESULTS' ? 'results.station_result_changed' : null;
      if (outboxType) await enqueueOutbox(s, outboxType as never, { jobId: String(job._id), electionId: job.electionId ? String(job.electionId) : undefined });
    });
    res.json({ job: await ImportJob.findById(job._id).lean(), applied, matchSummary });
  });

  r.post('/:id/discard', requireAuth, async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().min(5).max(1000) }), req.body);
    const job = await ImportJob.findById(String(req.params.id));
    if (!job) throw notFound();
    ensure(req.user!, [IMPORTERS[job.kind]!.permission]);
    if (['PUBLISHED', 'PUBLISHING'].includes(job.status)) throw conflict('Published imports cannot be discarded; publish corrections instead');
    await withTransaction(async (s) => {
      job.status = 'DISCARDED';
      await job.save({ session: s });
      await recordAudit(s, { actor: actorOf(req.user!, req.ip), action: 'import.discarded', entityType: 'ImportJob', entityId: String(job._id), meta: { reason } });
    });
    res.json({ job });
  });

  return r;
}
