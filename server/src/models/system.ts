import { Schema, model } from 'mongoose';

/**
 * Append-only, hash-chained audit log. Each event is written inside the business transaction
 * with a hash of its content. A single background sealer then assigns the sequence number and
 * chains it (hash = H(contentHash, seq, prevHash)), so deletion, insertion or modification of
 * history breaks the chain without making every transaction contend on one chain head.
 * The application never updates event content or deletes events.
 */
const auditEventSchema = new Schema(
  {
    at: { type: Date, required: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorRole: { type: String },
    actorLabel: { type: String },
    action: { type: String, required: true, index: true },
    entityType: { type: String, required: true, index: true },
    entityId: { type: String, index: true },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    meta: { type: Schema.Types.Mixed },
    ip: { type: String },
    contentHash: { type: String, required: true },
    sealed: { type: Boolean, default: false },
    seq: { type: Number },
    prevHash: { type: String },
    hash: { type: String }
  },
  // minimize:false keeps empty objects so stored content hashes exactly as it was hashed.
  { versionKey: false, minimize: false }
);
auditEventSchema.index({ seq: 1 }, { unique: true, partialFilterExpression: { sealed: true } });
auditEventSchema.index({ sealed: 1, _id: 1 });
auditEventSchema.index({ actorId: 1, at: -1 });
auditEventSchema.index({ at: -1 });
export const AuditEvent = model('AuditEvent', auditEventSchema);

const auditChainHeadSchema = new Schema(
  { _id: { type: String }, seq: { type: Number, required: true }, hash: { type: String, required: true } },
  { versionKey: false }
);
export const AuditChainHead = model('AuditChainHead', auditChainHeadSchema);

/** Transactional outbox: written in the same transaction as the change it describes. */
const outboxSchema = new Schema(
  {
    type: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: { type: String, enum: ['PENDING', 'PROCESSING', 'DONE', 'FAILED'], default: 'PENDING' },
    attempts: { type: Number, default: 0 },
    availableAt: { type: Date, default: Date.now },
    lockedUntil: { type: Date },
    lastError: { type: String },
    processedAt: { type: Date }
  },
  { timestamps: true }
);
outboxSchema.index({ status: 1, availableAt: 1 });
outboxSchema.index({ processedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 14 });
export const OutboxEvent = model('OutboxEvent', outboxSchema);

const notificationJobSchema = new Schema(
  {
    channel: { type: String, enum: ['EMAIL'], required: true },
    toEnc: { type: String, required: true },
    subject: { type: String, required: true },
    text: { type: String, required: true },
    attachments: [{ filename: String, fileId: { type: Schema.Types.ObjectId, ref: 'StoredFile' } }],
    status: { type: String, enum: ['PENDING', 'SENT', 'FAILED', 'SKIPPED'], default: 'PENDING', index: true },
    attempts: { type: Number, default: 0 },
    lastError: { type: String },
    sentAt: { type: Date }
  },
  { timestamps: true }
);
export const NotificationJob = model('NotificationJob', notificationJobSchema);

/** Uploaded files. Stored outside the web root; served only through authorised endpoints. */
const storedFileSchema = new Schema(
  {
    originalName: { type: String, maxlength: 255 },
    storageKey: { type: String, required: true, unique: true },
    mime: { type: String, required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true, index: true },
    purpose: {
      type: String,
      enum: ['RESULT_EVIDENCE', 'CITIZEN_REPORT', 'IMPORT', 'SOURCE_DOCUMENT', 'PROJECT_EVIDENCE', 'CANDIDATE_PHOTO', 'PARTY_LOGO', 'COUNTY_LOGO', 'RECEIPT', 'RECONCILIATION_EVIDENCE'],
      required: true
    },
    visibility: { type: String, enum: ['PRIVATE', 'PUBLIC'], default: 'PRIVATE' },
    scanStatus: { type: String, enum: ['PENDING', 'CLEAN', 'INFECTED', 'ERROR', 'UNSCANNED_DEV'], default: 'PENDING' },
    scanDetail: { type: String },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    uploaderIpHash: { type: String }
  },
  { timestamps: true }
);
export const StoredFile = model('StoredFile', storedFileSchema);

/** Operator-editable configuration that is safe to store in the database (never secrets). */
const systemConfigSchema = new Schema(
  { _id: { type: String }, value: { type: Schema.Types.Mixed }, updatedBy: { type: Schema.Types.ObjectId } },
  { timestamps: true }
);
export const SystemConfig = model('SystemConfig', systemConfigSchema);

/** Monotonic counters (receipt numbers etc). */
const counterSchema = new Schema({ _id: { type: String }, seq: { type: Number, default: 0 } }, { versionKey: false });
export const Counter = model('Counter', counterSchema);

/** Second-reviewer approvals for critical actions (result corrections, manual payment reconciliation, refunds). */
const pendingApprovalSchema = new Schema(
  {
    kind: { type: String, enum: ['RESULT_CORRECTION', 'MANUAL_RECONCILIATION', 'REFUND'], required: true, index: true },
    entityId: { type: String, required: true, index: true },
    payload: { type: Schema.Types.Mixed, required: true },
    reason: { type: String, required: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING', index: true },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    decidedAt: { type: Date },
    decisionNote: { type: String }
  },
  { timestamps: true }
);
export const PendingApproval = model('PendingApproval', pendingApprovalSchema);

/** Source registry: every published figure must point at one of these. */
const dataSourceSchema = new Schema(
  {
    name: { type: String, required: true },
    publisher: { type: String },
    url: { type: String },
    documentTitle: { type: String },
    publicationDate: { type: Date },
    financialYear: { type: String },
    electionId: { type: Schema.Types.ObjectId, ref: 'Election' },
    retrievedAt: { type: Date },
    kind: {
      type: String,
      enum: ['PORTAL', 'BUDGET_DOCUMENT', 'COB_REPORT', 'AUDIT_REPORT', 'TREASURY_RELEASE', 'ELECTION_PUBLICATION', 'GAZETTE', 'INSPECTION', 'OTHER'],
      default: 'OTHER'
    },
    fileId: { type: Schema.Types.ObjectId, ref: 'StoredFile' },
    checksum: { type: String },
    verificationStatus: { type: String, enum: ['UNREVIEWED', 'REVIEWED', 'REJECTED'], default: 'UNREVIEWED' },
    notes: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);
dataSourceSchema.index({ name: 'text', documentTitle: 'text', publisher: 'text' });
export const DataSource = model('DataSource', dataSourceSchema);

const importJobSchema = new Schema(
  {
    kind: {
      type: String,
      enum: [
        'POLLING_STATIONS',
        'CANDIDATES',
        'AGENT_ASSIGNMENTS',
        'BUDGET_FIGURES',
        'TREASURY_DISBURSEMENTS',
        'PROJECTS',
        'AUDIT_FINDINGS',
        'OFFICIAL_RESULTS',
        'PAYMENT_RECONCILIATION'
      ],
      required: true,
      index: true
    },
    status: { type: String, enum: ['IMPORTED', 'VALIDATED', 'REVIEWED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'DISCARDED'], default: 'IMPORTED', index: true },
    electionId: { type: Schema.Types.ObjectId, ref: 'Election' },
    countyId: { type: Schema.Types.ObjectId, ref: 'County' },
    sourceId: { type: Schema.Types.ObjectId, ref: 'DataSource' },
    fileId: { type: Schema.Types.ObjectId, ref: 'StoredFile' },
    originalName: { type: String },
    rowCount: { type: Number, default: 0 },
    validCount: { type: Number, default: 0 },
    errorCount: { type: Number, default: 0 },
    duplicateCount: { type: Number, default: 0 },
    conflictCount: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    validatedAt: { type: Date },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    reviewNote: { type: String },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    publishedAt: { type: Date },
    publishSummary: { type: Schema.Types.Mixed }
  },
  { timestamps: true }
);
export const ImportJob = model('ImportJob', importJobSchema);

const importRowSchema = new Schema(
  {
    jobId: { type: Schema.Types.ObjectId, ref: 'ImportJob', required: true, index: true },
    rowNumber: { type: Number, required: true },
    raw: { type: Schema.Types.Mixed },
    normalized: { type: Schema.Types.Mixed },
    status: { type: String, enum: ['VALID', 'INVALID', 'DUPLICATE', 'CONFLICT', 'SKIPPED'], required: true },
    messages: [{ type: String }],
    naturalKey: { type: String },
    targetId: { type: Schema.Types.ObjectId },
    applied: { type: Boolean, default: false }
  },
  { versionKey: false }
);
importRowSchema.index({ jobId: 1, rowNumber: 1 }, { unique: true });
export const ImportRow = model('ImportRow', importRowSchema);

/** Short public platform announcements and methodology updates. */
const platformUpdateSchema = new Schema(
  {
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, required: true, maxlength: 5000 },
    kind: { type: String, enum: ['UPDATE', 'METHODOLOGY', 'CORRECTION'], default: 'UPDATE' },
    published: { type: Boolean, default: false },
    publishedAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);
export const PlatformUpdate = model('PlatformUpdate', platformUpdateSchema);
