import { Schema, model } from 'mongoose';
import { pointSchema, publishableFields } from './common.js';

const departmentSchema = new Schema(
  {
    countyId: { type: Schema.Types.ObjectId, ref: 'County', required: true },
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true },
    active: { type: Boolean, default: true }
  },
  { timestamps: true }
);
departmentSchema.index({ countyId: 1, slug: 1 }, { unique: true });
departmentSchema.index({ name: 'text' });
export const Department = model('Department', departmentSchema);

/**
 * Each budget metric is stored as its own row so that a missing metric is simply absent
 * (and shown as "not available") rather than recorded as zero.
 */
export const BUDGET_METRICS = [
  'APPROVED_BUDGET',
  'REVISED_BUDGET',
  'DEVELOPMENT_BUDGET',
  'RECURRENT_BUDGET',
  'EQUITABLE_SHARE',
  'CONDITIONAL_GRANTS',
  'OWN_SOURCE_REVENUE',
  'FUNDS_RECEIVED',
  'ACTUAL_EXPENDITURE',
  'DEVELOPMENT_EXPENDITURE',
  'RECURRENT_EXPENDITURE',
  'PENDING_BILLS',
  'OUTSTANDING_COMMITMENTS',
  'UNSPENT_BALANCE',
  'DEVELOPMENT_IMPLEMENTATION_RATE'
] as const;
export type BudgetMetric = (typeof BUDGET_METRICS)[number];
/** Metrics expressed as a percentage (basis points) rather than money. */
export const PERCENT_METRICS: BudgetMetric[] = ['DEVELOPMENT_IMPLEMENTATION_RATE'];

const budgetFigureSchema = new Schema(
  {
    countyId: { type: Schema.Types.ObjectId, ref: 'County', required: true },
    financialYear: { type: String, required: true },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department' },
    constituencyName: { type: String },
    wardName: { type: String },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
    fundingSource: { type: String },
    metric: { type: String, enum: BUDGET_METRICS, required: true },
    /** Integer KES cents for money metrics; basis points (1/100 %) for percentage metrics. */
    value: { type: Number, required: true },
    unit: { type: String, enum: ['KES_CENTS', 'BASIS_POINTS'], required: true },
    periodLabel: { type: String, required: true },
    periodStart: { type: Date },
    periodEnd: { type: Date, required: true },
    publicationDate: { type: Date },
    notes: { type: String },
    ...publishableFields
  },
  { timestamps: true }
);
budgetFigureSchema.index({ countyId: 1, financialYear: 1, metric: 1, workflowStatus: 1, isCurrent: 1 });
budgetFigureSchema.index({ departmentId: 1, financialYear: 1 });
export const BudgetFigure = model('BudgetFigure', budgetFigureSchema);

/** Stages are kept distinct: an approved allocation is never evidence of a release or receipt. */
export const DISBURSEMENT_STAGES = ['ALLOCATION', 'SCHEDULED', 'DISBURSED', 'RECEIVED'] as const;
export type DisbursementStage = (typeof DISBURSEMENT_STAGES)[number];

const treasuryDisbursementSchema = new Schema(
  {
    countyId: { type: Schema.Types.ObjectId, ref: 'County', required: true },
    financialYear: { type: String, required: true },
    stage: { type: String, enum: DISBURSEMENT_STAGES, required: true },
    fundingStream: { type: String, default: 'EQUITABLE_SHARE' },
    amountCents: { type: Number, required: true, min: 0 },
    /** Cumulative position as at this date. */
    asOfDate: { type: Date, required: true },
    /** For SCHEDULED rows: the month/tranche the schedule refers to. */
    scheduleLabel: { type: String },
    officialExplanation: { type: String },
    publicationDate: { type: Date },
    ...publishableFields
  },
  { timestamps: true }
);
treasuryDisbursementSchema.index({ countyId: 1, financialYear: 1, stage: 1, asOfDate: -1 });
export const TreasuryDisbursement = model('TreasuryDisbursement', treasuryDisbursementSchema);

const contractorSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    registrationNumber: { type: String },
    notes: { type: String }
  },
  { timestamps: true }
);
contractorSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
export const Contractor = model('Contractor', contractorSchema);

export const PROJECT_STATUSES = ['PLANNED', 'ONGOING', 'COMPLETED', 'DELAYED', 'SUSPENDED', 'UNVERIFIED'] as const;
export const PROJECT_SECTORS = ['ROADS', 'HEALTH', 'WATER', 'BOREHOLE', 'MARKETS', 'SANITATION', 'ELECTRICITY', 'EDUCATION', 'AGRICULTURE', 'OTHER'] as const;
export const PHYSICAL_PROGRESS_BASIS = ['INSPECTION', 'OFFICIAL_REPORT', 'OBSERVATION'] as const;

const physicalProgressSchema = new Schema(
  {
    percent: { type: Number, min: 0, max: 100, required: true },
    basis: { type: String, enum: PHYSICAL_PROGRESS_BASIS, required: true },
    assessedAt: { type: Date, required: true },
    assessedBy: { type: String },
    sourceId: { type: Schema.Types.ObjectId, ref: 'DataSource' },
    evidenceFileIds: [{ type: Schema.Types.ObjectId, ref: 'StoredFile' }],
    notes: { type: String }
  },
  { _id: false }
);

const projectSchema = new Schema(
  {
    reference: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String },
    sector: { type: String, enum: PROJECT_SECTORS, default: 'OTHER' },
    countyId: { type: Schema.Types.ObjectId, ref: 'County', required: true },
    constituencyName: { type: String },
    wardName: { type: String },
    location: { type: pointSchema },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department' },
    fundingSource: { type: String },
    financialYear: { type: String },
    approvedBudgetCents: { type: Number, min: 0 },
    revisedBudgetCents: { type: Number, min: 0 },
    amountPaidCents: { type: Number, min: 0 },
    amountPaidAsOf: { type: Date },
    contractorId: { type: Schema.Types.ObjectId, ref: 'Contractor' },
    procurementReference: { type: String },
    startDate: { type: Date },
    plannedCompletionDate: { type: Date },
    status: { type: String, enum: PROJECT_STATUSES, default: 'UNVERIFIED' },
    statusSourceId: { type: Schema.Types.ObjectId, ref: 'DataSource' },
    physicalProgress: { type: physicalProgressSchema },
    lastInspectionDate: { type: Date },
    discrepancyFlag: {
      flagged: { type: Boolean, default: false },
      reason: { type: String },
      flaggedAt: { type: Date },
      flaggedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      evidenceSourceIds: [{ type: Schema.Types.ObjectId, ref: 'DataSource' }]
    },
    sourceIds: [{ type: Schema.Types.ObjectId, ref: 'DataSource' }],
    ...publishableFields
  },
  { timestamps: true }
);
projectSchema.index({ reference: 1, isCurrent: 1 });
projectSchema.index({ countyId: 1, status: 1, workflowStatus: 1, isCurrent: 1 });
projectSchema.index({ name: 'text', description: 'text', reference: 'text' });
export const Project = model('Project', projectSchema);

/** Append-only update history for projects (status, payments, inspections). */
const projectUpdateSchema = new Schema(
  {
    projectReference: { type: String, required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    kind: { type: String, enum: ['CREATED', 'STATUS', 'PAYMENT', 'INSPECTION', 'CORRECTION', 'FLAG', 'PUBLISHED'], required: true },
    summary: { type: String, required: true },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    sourceId: { type: Schema.Types.ObjectId, ref: 'DataSource' },
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now }
  },
  { versionKey: false }
);
export const ProjectUpdate = model('ProjectUpdate', projectUpdateSchema);

/** Categories mirror the wording used in audit reports; none of them means "stolen". */
export const FINDING_CATEGORIES = [
  'UNSUPPORTED_EXPENDITURE',
  'IRREGULAR_EXPENDITURE',
  'UNEXPLAINED_DISCREPANCY',
  'PENDING_BILLS',
  'DELAYED_PROJECT',
  'RECOMMENDED_FOR_RECOVERY',
  'CONFIRMED_LOSS',
  'ALLEGATION_UNDER_INVESTIGATION',
  'OTHER'
] as const;

const auditFindingSchema = new Schema(
  {
    findingKey: { type: String, required: true },
    countyId: { type: Schema.Types.ObjectId, ref: 'County', required: true },
    financialYear: { type: String, required: true },
    entity: { type: String, required: true },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department' },
    category: { type: String, enum: FINDING_CATEGORIES, required: true },
    amountQuestionedCents: { type: Number, min: 0 },
    /** Description as worded in the source report. */
    description: { type: String, required: true },
    reportTitle: { type: String, required: true },
    pageNumber: { type: String },
    reportPublicationDate: { type: Date },
    managementResponse: { type: String },
    auditorRecommendation: { type: String },
    recoveryOrInvestigationStatus: { type: String },
    latestKnownStatus: { type: String, default: 'As reported' },
    latestStatusDate: { type: Date },
    sourceUrl: { type: String },
    ...publishableFields
  },
  { timestamps: true }
);
auditFindingSchema.index({ findingKey: 1, isCurrent: 1 });
auditFindingSchema.index({ countyId: 1, financialYear: 1, category: 1 });
auditFindingSchema.index({ description: 'text', entity: 'text', reportTitle: 'text' });
export const AuditFinding = model('AuditFinding', auditFindingSchema);

export const CITIZEN_REPORT_TYPES = [
  'STALLED_PROJECT',
  'INCOMPLETE_INFRASTRUCTURE',
  'SPENDING_DELIVERY_DISCREPANCY',
  'MISSING_PUBLIC_INFORMATION',
  'DUPLICATE_OR_ABANDONED_PROJECT',
  'DATA_CORRECTION_REQUEST'
] as const;

const citizenReportSchema = new Schema(
  {
    reference: { type: String, required: true, unique: true },
    type: { type: String, enum: CITIZEN_REPORT_TYPES, required: true },
    title: { type: String, required: true, maxlength: 200 },
    description: { type: String, required: true, maxlength: 5000 },
    countyId: { type: Schema.Types.ObjectId, ref: 'County' },
    locationText: { type: String, maxlength: 300 },
    location: { type: pointSchema },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
    relatedUrl: { type: String, maxlength: 500 },
    fileIds: [{ type: Schema.Types.ObjectId, ref: 'StoredFile' }],
    /** Private, encrypted. Never returned by public APIs. */
    reporterNameEnc: { type: String },
    reporterContactEnc: { type: String },
    contentHash: { type: String, index: true },
    ipHash: { type: String },
    status: {
      type: String,
      enum: ['RECEIVED', 'UNDER_REVIEW', 'PUBLISHED', 'REJECTED', 'DUPLICATE', 'RESOLVED'],
      default: 'RECEIVED',
      index: true
    },
    /** Moderator-written summary that is safe to publish (no personal data, no unproven accusations). */
    publicSummary: { type: String, maxlength: 2000 },
    duplicateOfId: { type: Schema.Types.ObjectId, ref: 'CitizenReport' },
    moderationNotes: [{ note: String, by: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date }],
    abuseReports: [{ reason: String, at: Date, ipHash: String }],
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date }
  },
  { timestamps: true }
);
citizenReportSchema.index({ status: 1, createdAt: -1 });
export const CitizenReport = model('CitizenReport', citizenReportSchema);

