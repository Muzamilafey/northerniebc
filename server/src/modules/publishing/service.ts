import type { Model } from 'mongoose';
import { env } from '../../config/env.js';
import { withTransaction } from '../../db/mongo.js';
import { recordAudit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { enqueueOutbox, type OutboxType } from '../../lib/outbox.js';
import { can, inScope } from '../../lib/permissions.js';
import { AuditFinding, BudgetFigure, DataSource, Project, ProjectUpdate, TreasuryDisbursement, type WorkflowStatus } from '../../models/index.js';
import type { AuthUser } from '../../types/express.js';

export const RECORD_KINDS = ['BUDGET_FIGURE', 'DISBURSEMENT', 'PROJECT', 'AUDIT_FINDING'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REGISTRY: Record<RecordKind, { model: Model<any>; outbox: OutboxType; label: string }> = {
  BUDGET_FIGURE: { model: BudgetFigure, outbox: 'finance.published', label: 'BudgetFigure' },
  DISBURSEMENT: { model: TreasuryDisbursement, outbox: 'finance.published', label: 'TreasuryDisbursement' },
  PROJECT: { model: Project, outbox: 'projects.published', label: 'Project' },
  AUDIT_FINDING: { model: AuditFinding, outbox: 'accountability.published', label: 'AuditFinding' }
};

export const modelFor = (kind: RecordKind) => REGISTRY[kind].model;

const NEXT: Record<WorkflowStatus, WorkflowStatus | null> = { IMPORTED: 'VALIDATED', VALIDATED: 'REVIEWED', REVIEWED: 'PUBLISHED', PUBLISHED: null };

/**
 * Moves a record one step through IMPORTED → VALIDATED → REVIEWED → PUBLISHED.
 *  - VALIDATED requires a source reference;
 *  - REVIEWED requires review permission and (with FOUR_EYES_IMPORTS) a different person from the creator;
 *  - PUBLISHED requires publish permission; publishing a correction retires the record it supersedes.
 */
export async function advanceRecord(kind: RecordKind, id: string, to: WorkflowStatus, actor: AuthUser, note: string | undefined, ip?: string) {
  const { model, outbox, label } = REGISTRY[kind];
  const doc = await model.findById(id);
  if (!doc) throw notFound();
  if (!inScope(actor, { countyId: doc.countyId })) throw forbidden('Record is outside your scope');
  if (NEXT[doc.workflowStatus as WorkflowStatus] !== to) throw conflict(`Cannot move from ${doc.workflowStatus} to ${to}`);

  if (to === 'VALIDATED') {
    if (!can(actor, 'finance.import') && !can(actor, 'projects.manage')) throw forbidden();
    if (!doc.sourceId) throw badRequest('A source reference is required before validation');
    if (!(await DataSource.exists({ _id: doc.sourceId }))) throw badRequest('Source not found');
  }
  if (to === 'REVIEWED') {
    if (!can(actor, 'finance.review')) throw forbidden();
    if (env.FOUR_EYES_IMPORTS && String(doc.createdBy) === actor.id) throw forbidden('A different person must review this record');
  }
  if (to === 'PUBLISHED' && !can(actor, 'finance.publish')) throw forbidden();

  await withTransaction(async (s) => {
    const before = { workflowStatus: doc.workflowStatus };
    doc.workflowStatus = to;
    if (to === 'PUBLISHED') {
      doc.publishedAt = new Date();
      doc.publishedBy = actor.id;
      doc.isCurrent = true;
      if (doc.supersedesId) {
        const old = await model.findById(doc.supersedesId).session(s);
        if (!old || !old.isCurrent) throw conflict('The record being corrected is no longer current');
        old.isCurrent = false;
        old.supersededById = doc._id;
        await old.save({ session: s });
      }
      await enqueueOutbox(s, outbox, { kind, id: String(doc._id) });
      if (kind === 'PROJECT') {
        await ProjectUpdate.create(
          [{ projectReference: doc.reference, projectId: doc._id, kind: doc.supersedesId ? 'CORRECTION' : 'PUBLISHED', summary: doc.correctionReason ?? 'Project record published', after: { status: doc.status, amountPaidCents: doc.amountPaidCents, physicalProgress: doc.physicalProgress }, sourceId: doc.sourceId, actorId: actor.id }],
          { session: s }
        );
      }
    }
    await doc.save({ session: s });
    await recordAudit(s, {
      actor: { id: actor.id, role: actor.role, label: actor.fullName, ip },
      action: `${label}.${to.toLowerCase()}`,
      entityType: label,
      entityId: String(doc._id),
      before,
      after: { workflowStatus: to },
      meta: { note, supersedesId: doc.supersedesId ? String(doc.supersedesId) : undefined }
    });
  });
  return doc;
}

const IMMUTABLE_KEYS = new Set(['_id', 'workflowStatus', 'isCurrent', 'supersedesId', 'supersededById', 'publishedAt', 'publishedBy', 'createdBy', 'revision', 'createdAt', 'updatedAt', '__v', 'importJobId']);

/**
 * Creates a correction of a published record. The published original remains visible and
 * unchanged until the correction itself passes review and publication.
 */
export async function correctRecord(kind: RecordKind, id: string, changes: Record<string, unknown>, reason: string, actor: AuthUser, ip?: string) {
  const { model, label } = REGISTRY[kind];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orig = (await model.findById(id).lean()) as Record<string, any> | null;
  if (!orig) throw notFound();
  if (!inScope(actor, { countyId: (orig as { countyId?: unknown }).countyId })) throw forbidden();
  if ((orig as { workflowStatus: string }).workflowStatus !== 'PUBLISHED' || !(orig as { isCurrent: boolean }).isCurrent) {
    throw conflict('Only the current published record can be corrected; edit unpublished records directly');
  }
  for (const k of Object.keys(changes)) if (IMMUTABLE_KEYS.has(k)) throw badRequest(`Field ${k} cannot be changed`);
  const pending = await model.exists({ supersedesId: (orig as { _id: unknown })._id, workflowStatus: { $ne: 'PUBLISHED' } });
  if (pending) throw conflict('A correction for this record is already in progress');
  const { _id, createdAt: _c, updatedAt: _u, __v: _v, ...rest } = orig as Record<string, unknown>;
  return withTransaction(async (s) => {
    const [doc] = await model.create(
      [
        {
          ...rest,
          ...changes,
          workflowStatus: 'IMPORTED',
          isCurrent: false,
          revision: ((orig as { revision?: number }).revision ?? 1) + 1,
          supersedesId: _id,
          supersededById: undefined,
          correctionReason: reason,
          publishedAt: undefined,
          publishedBy: undefined,
          createdBy: actor.id
        }
      ],
      { session: s }
    );
    await recordAudit(s, {
      actor: { id: actor.id, role: actor.role, label: actor.fullName, ip },
      action: `${label}.correction_drafted`,
      entityType: label,
      entityId: String(doc._id),
      before: orig,
      after: changes,
      meta: { reason, supersedesId: String(_id) }
    });
    return doc;
  });
}

/** Edits a record that has not been published yet (resets it to IMPORTED for re-validation). */
export async function editUnpublished(kind: RecordKind, id: string, changes: Record<string, unknown>, actor: AuthUser, ip?: string) {
  const { model, label } = REGISTRY[kind];
  const doc = await model.findById(id);
  if (!doc) throw notFound();
  if (!inScope(actor, { countyId: doc.countyId })) throw forbidden();
  if (doc.workflowStatus === 'PUBLISHED') throw conflict('Published records cannot be edited; submit a correction instead');
  for (const k of Object.keys(changes)) if (IMMUTABLE_KEYS.has(k)) throw badRequest(`Field ${k} cannot be changed`);
  const before = doc.toObject();
  await withTransaction(async (s) => {
    doc.set({ ...changes, workflowStatus: 'IMPORTED' });
    await doc.save({ session: s });
    await recordAudit(s, { actor: { id: actor.id, role: actor.role, label: actor.fullName, ip }, action: `${label}.edited`, entityType: label, entityId: String(doc._id), before, after: changes });
  });
  return doc;
}
