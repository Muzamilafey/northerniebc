import { Schema, Types } from 'mongoose';

export const WORKFLOW_STATUSES = ['IMPORTED', 'VALIDATED', 'REVIEWED', 'PUBLISHED'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

/** How confident the platform is in a figure, independent of its publication state. */
export const VERIFICATION_STATUSES = [
  'UNVERIFIED',
  'OFFICIAL_SOURCE_REPORTED',
  'INDEPENDENTLY_VERIFIED',
  'INDEPENDENTLY_INSPECTED',
  'DISPUTED'
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/**
 * Fields shared by every publishable public-finance / accountability record.
 * Published records are never edited in place: a correction inserts a new record that
 * `supersedes` the old one, and the old one keeps its values with isCurrent=false.
 */
export const publishableFields = {
  workflowStatus: { type: String, enum: WORKFLOW_STATUSES, default: 'IMPORTED', index: true },
  verificationStatus: { type: String, enum: VERIFICATION_STATUSES, default: 'UNVERIFIED' },
  sourceId: { type: Schema.Types.ObjectId, ref: 'DataSource' },
  sourcePage: { type: String },
  importJobId: { type: Schema.Types.ObjectId, ref: 'ImportJob' },
  revision: { type: Number, default: 1 },
  isCurrent: { type: Boolean, default: true, index: true },
  supersedesId: { type: Schema.Types.ObjectId },
  supersededById: { type: Schema.Types.ObjectId },
  correctionReason: { type: String },
  publishedAt: { type: Date },
  publishedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' }
} as const;

export interface PublishableDoc {
  workflowStatus: WorkflowStatus;
  verificationStatus: VerificationStatus;
  sourceId?: Types.ObjectId;
  sourcePage?: string;
  importJobId?: Types.ObjectId;
  revision: number;
  isCurrent: boolean;
  supersedesId?: Types.ObjectId;
  supersededById?: Types.ObjectId;
  correctionReason?: string;
  publishedAt?: Date;
  publishedBy?: Types.ObjectId;
  createdBy?: Types.ObjectId;
}

/** Filter for what the public may see. */
export const publicFilter = { workflowStatus: 'PUBLISHED', isCurrent: true } as const;

export const pointSchema = new Schema(
  {
    lat: { type: Number, min: -90, max: 90 },
    lng: { type: Number, min: -180, max: 180 },
    verified: { type: Boolean, default: false }
  },
  { _id: false }
);

/** Kenyan financial years run July–June, written e.g. "2023/24". */
export const FINANCIAL_YEAR_RE = /^20\d{2}\/\d{2}$/;
export function isValidFinancialYear(fy: string): boolean {
  if (!FINANCIAL_YEAR_RE.test(fy)) return false;
  const start = Number(fy.slice(0, 4));
  const end = Number(fy.slice(5));
  return (start + 1) % 100 === end;
}
