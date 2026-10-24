import { Schema, model } from 'mongoose';

export const PAYMENT_METHODS = ['MPESA', 'CARD', 'PAYPAL'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const DONATION_STATUSES = [
  'PENDING',
  'SUCCESSFUL',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
  'REFUND_PENDING',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'DISPUTED'
] as const;
export type DonationStatus = (typeof DONATION_STATUSES)[number];
/** Statuses in which money was confirmed received (refunds are netted separately). */
export const CONFIRMED_STATUSES: DonationStatus[] = ['SUCCESSFUL', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED'];

const donationSchema = new Schema(
  {
    reference: { type: String, required: true, unique: true },
    idempotencyKey: { type: String, required: true, unique: true },
    amountCents: { type: Number, required: true, min: 1 },
    currency: { type: String, enum: ['KES', 'USD'], default: 'KES' },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    provider: { type: String, required: true },
    providerMode: { type: String, enum: ['sandbox', 'production'], required: true },
    status: { type: String, enum: DONATION_STATUSES, default: 'PENDING', index: true },
    statusHistory: [{ status: String, at: Date, reason: String, _id: false }],
    donor: {
      nameEnc: { type: String },
      emailEnc: { type: String },
      phoneEnc: { type: String },
      phoneIndex: { type: String, index: true },
      message: { type: String, maxlength: 500 },
      /** NONE: no public mention. ANONYMOUS: listed as "Anonymous". NAMED: name may be shown. */
      acknowledgement: { type: String, enum: ['NONE', 'ANONYMOUS', 'NAMED'], default: 'NONE' },
      consentAt: { type: Date }
    },
    goalId: { type: Schema.Types.ObjectId, ref: 'FundraisingGoal' },
    restricted: { type: Boolean, default: false },
    providerReference: { type: String, index: true, sparse: true },
    providerReceipt: { type: String, index: true, sparse: true },
    feeCents: { type: Number, min: 0 },
    refundedCents: { type: Number, default: 0, min: 0 },
    confirmedAt: { type: Date, index: true },
    confirmationSource: { type: String, enum: ['PROVIDER_CALLBACK', 'PROVIDER_QUERY', 'MANUAL_RECONCILIATION'] },
    needsReconciliation: { type: Boolean, default: false, index: true },
    lastStatusQueryAt: { type: Date },
    statusQueryAttempts: { type: Number, default: 0 },
    receiptId: { type: Schema.Types.ObjectId, ref: 'DonationReceipt' },
    termsVersion: { type: String, required: true },
    /** Hash of the token given to the donor for checking status and downloading the receipt. */
    statusTokenHash: { type: String, required: true },
    ipHash: { type: String }
  },
  { timestamps: true, optimisticConcurrency: true }
);
donationSchema.index({ status: 1, createdAt: 1 });
donationSchema.index({ confirmedAt: 1, status: 1 });
export const Donation = model('Donation', donationSchema);

/** One row per provider request (STK push, checkout session, order, status query, reversal). */
const paymentTransactionSchema = new Schema(
  {
    donationId: { type: Schema.Types.ObjectId, ref: 'Donation', required: true, index: true },
    provider: { type: String, required: true },
    kind: { type: String, enum: ['INITIATE', 'STATUS_QUERY', 'REFUND'], required: true },
    providerRequestId: { type: String, index: true },
    providerSecondaryId: { type: String },
    status: { type: String, enum: ['REQUESTED', 'ACCEPTED', 'REJECTED', 'ERROR', 'COMPLETED', 'FAILED'], required: true },
    responseCode: { type: String },
    responseDescription: { type: String },
    /** Redacted response — never contains credentials or full phone numbers. */
    responseSummary: { type: Schema.Types.Mixed }
  },
  { timestamps: true }
);
export const PaymentTransaction = model('PaymentTransaction', paymentTransactionSchema);

/** Every provider callback/webhook, verbatim (redacted), deduplicated by dedupeKey. */
const paymentCallbackSchema = new Schema(
  {
    provider: { type: String, required: true },
    dedupeKey: { type: String, required: true, unique: true },
    receivedAt: { type: Date, required: true },
    sourceIp: { type: String },
    authenticityCheck: { type: String, enum: ['PASSED', 'FAILED', 'NOT_AVAILABLE'], required: true },
    body: { type: Schema.Types.Mixed },
    donationId: { type: Schema.Types.ObjectId, ref: 'Donation', index: true },
    outcome: { type: String },
    processed: { type: Boolean, default: false },
    error: { type: String }
  },
  { versionKey: false }
);
export const PaymentCallback = model('PaymentCallback', paymentCallbackSchema);

const refundSchema = new Schema(
  {
    donationId: { type: Schema.Types.ObjectId, ref: 'Donation', required: true, index: true },
    amountCents: { type: Number, required: true, min: 1 },
    reason: { type: String, required: true },
    status: { type: String, enum: ['AWAITING_APPROVAL', 'SUBMITTED', 'COMPLETED', 'FAILED', 'REJECTED'], default: 'AWAITING_APPROVAL' },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    providerRefundId: { type: String, index: true, sparse: true },
    providerResponse: { type: Schema.Types.Mixed },
    completedAt: { type: Date }
  },
  { timestamps: true }
);
export const Refund = model('Refund', refundSchema);

const donationReceiptSchema = new Schema(
  {
    receiptNumber: { type: String, required: true, unique: true },
    donationId: { type: Schema.Types.ObjectId, ref: 'Donation', required: true, unique: true },
    /** Frozen copy of everything printed on the receipt. */
    snapshot: { type: Schema.Types.Mixed, required: true },
    /** Unguessable token for the donor's receipt link. */
    accessTokenHash: { type: String, required: true },
    issuedAt: { type: Date, required: true },
    emailedAt: { type: Date }
  },
  { versionKey: false }
);
export const DonationReceipt = model('DonationReceipt', donationReceiptSchema);

const fundraisingGoalSchema = new Schema(
  {
    title: { type: String, required: true },
    category: {
      type: String,
      enum: ['HOSTING', 'ELECTION_DATA', 'BUDGET_RESEARCH', 'PUBLIC_REPORTING', 'SECURITY_MAINTENANCE', 'ACCESSIBILITY_OUTREACH', 'GENERAL'],
      required: true
    },
    description: { type: String },
    targetCents: { type: Number, required: true, min: 1 },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    /** Only true where a legally separate restricted fund actually exists. */
    restricted: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);
export const FundraisingGoal = model('FundraisingGoal', fundraisingGoalSchema);

/** Platform operating expenditure, published only when backed by documentation. */
const operatingExpenditureSchema = new Schema(
  {
    category: {
      type: String,
      enum: ['HOSTING', 'ELECTION_DATA', 'BUDGET_RESEARCH', 'PUBLIC_REPORTING', 'SECURITY_MAINTENANCE', 'ACCESSIBILITY_OUTREACH', 'PAYMENT_FEES', 'ADMINISTRATION', 'OTHER'],
      required: true
    },
    description: { type: String, required: true },
    amountCents: { type: Number, required: true, min: 1 },
    spentOn: { type: Date, required: true },
    goalId: { type: Schema.Types.ObjectId, ref: 'FundraisingGoal' },
    documentFileId: { type: Schema.Types.ObjectId, ref: 'StoredFile' },
    documentReference: { type: String, required: true },
    published: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);
export const OperatingExpenditure = model('OperatingExpenditure', operatingExpenditureSchema);

/** Periodic published donation & expenditure reports. Frozen once published. */
const donationReportSchema = new Schema(
  {
    title: { type: String, required: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    totals: { type: Schema.Types.Mixed, required: true },
    narrative: { type: String },
    publishedAt: { type: Date, required: true },
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true }
  },
  { timestamps: true }
);
export const DonationReport = model('DonationReport', donationReportSchema);
