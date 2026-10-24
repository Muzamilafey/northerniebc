import { Schema, model } from 'mongoose';
import { POSITIONS } from './election.js';

const candidateVoteSchema = new Schema(
  {
    candidateId: { type: Schema.Types.ObjectId, ref: 'Candidate', required: true },
    votes: { type: Number, required: true, min: 0 }
  },
  { _id: false }
);

const fieldsSchema = new Schema(
  {
    registeredVoters: { type: Number, min: 0 },
    totalVotesCast: { type: Number, min: 0 },
    rejectedVotes: { type: Number, min: 0 },
    rejectedObjectedTo: { type: Number, min: 0 },
    disputedVotes: { type: Number, min: 0 },
    validVotes: { type: Number, min: 0 }
  },
  { _id: false }
);

export const SUBMISSION_STATUSES = ['SUBMITTED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED'] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

/**
 * A submission is one agent's result for one station and one position. Its numbers live in
 * immutable SubmissionRevision documents; `currentRevision` points at the latest one.
 * Drafts stay on the device (IndexedDB) and never reach the server as submissions.
 */
const resultSubmissionSchema = new Schema(
  {
    submissionId: { type: String, required: true, unique: true },
    electionId: { type: Schema.Types.ObjectId, ref: 'Election', required: true },
    pollingStationId: { type: Schema.Types.ObjectId, ref: 'PollingStation', required: true },
    countyId: { type: Schema.Types.ObjectId, ref: 'County', required: true },
    constituencyId: { type: Schema.Types.ObjectId, ref: 'Constituency', required: true },
    wardId: { type: Schema.Types.ObjectId, ref: 'Ward', required: true },
    position: { type: String, enum: POSITIONS, required: true },
    agentId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: SUBMISSION_STATUSES, default: 'SUBMITTED', index: true },
    currentRevision: { type: Number, required: true },
    flags: [{ type: String }],
    hasConflict: { type: Boolean, default: false, index: true },
    lastServerReceivedAt: { type: Date, required: true }
  },
  { timestamps: true, optimisticConcurrency: true }
);
resultSubmissionSchema.index({ electionId: 1, pollingStationId: 1, position: 1, agentId: 1 }, { unique: true });
resultSubmissionSchema.index({ electionId: 1, status: 1, countyId: 1 });
export const ResultSubmission = model('ResultSubmission', resultSubmissionSchema);

const submissionRevisionSchema = new Schema(
  {
    submissionId: { type: String, required: true },
    revision: { type: Number, required: true },
    idempotencyKey: { type: String, required: true, unique: true },
    /** Hash of the client request, so a replayed idempotency key with a different body is refused. */
    requestFingerprint: { type: String, required: true },
    candidateVotes: { type: [candidateVoteSchema], required: true },
    fields: { type: fieldsSchema, default: {} },
    formReference: { type: String, maxlength: 120 },
    evidenceFileIds: [{ type: Schema.Types.ObjectId, ref: 'StoredFile' }],
    declarationAccepted: { type: Boolean, required: true },
    declarationText: { type: String, required: true },
    correctionReason: { type: String },
    clientCreatedAt: { type: Date },
    clientDeviceId: { type: String, maxlength: 100 },
    serverReceivedAt: { type: Date, required: true },
    agentId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reconciliationIssues: [{ rule: String, message: String }],
    countSessionId: { type: String },
    /** sha256 over the canonical payload, chained to the previous revision of this submission. */
    payloadHash: { type: String, required: true },
    prevRevisionHash: { type: String },
    receiptId: { type: String, required: true, unique: true },
    ipHash: { type: String }
  },
  { versionKey: false }
);
submissionRevisionSchema.index({ submissionId: 1, revision: 1 }, { unique: true });
export const SubmissionRevision = model('SubmissionRevision', submissionRevisionSchema);

const verificationDecisionSchema = new Schema(
  {
    submissionId: { type: String, required: true, index: true },
    revision: { type: Number, required: true },
    decision: { type: String, enum: ['START_REVIEW', 'VERIFY', 'REJECT', 'ACCEPT_AS_STATION_RESULT'], required: true },
    reviewerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    secondReviewerId: { type: Schema.Types.ObjectId, ref: 'User' },
    note: { type: String, required: true, maxlength: 2000 },
    at: { type: Date, required: true }
  },
  { versionKey: false }
);
export const VerificationDecision = model('VerificationDecision', verificationDecisionSchema);

export const PUBLIC_RESULT_STATUSES = [
  'AWAITING_VERIFICATION',
  'PROVISIONAL',
  'VERIFIED',
  'MATCHED_OFFICIAL',
  'OFFICIAL'
] as const;
export type PublicResultStatus = (typeof PUBLIC_RESULT_STATUSES)[number];

/**
 * The single accepted result per (election, station, position) — the only collection that
 * aggregates read from. The unique index guarantees duplicates and revisions are never summed.
 */
const stationResultSchema = new Schema(
  {
    electionId: { type: Schema.Types.ObjectId, ref: 'Election', required: true },
    pollingStationId: { type: Schema.Types.ObjectId, ref: 'PollingStation', required: true },
    countyId: { type: Schema.Types.ObjectId, ref: 'County', required: true },
    constituencyId: { type: Schema.Types.ObjectId, ref: 'Constituency', required: true },
    wardId: { type: Schema.Types.ObjectId, ref: 'Ward', required: true },
    position: { type: String, enum: POSITIONS, required: true },
    submissionId: { type: String, required: true },
    revision: { type: Number, required: true },
    candidateVotes: { type: [candidateVoteSchema], required: true },
    fields: { type: fieldsSchema, default: {} },
    status: { type: String, enum: PUBLIC_RESULT_STATUSES, required: true },
    hasConflict: { type: Boolean, default: false },
    submissionCount: { type: Number, default: 1 },
    verifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    verifiedAt: { type: Date },
    officialMatch: {
      checkedAt: Date,
      matches: Boolean,
      sourceId: { type: Schema.Types.ObjectId, ref: 'DataSource' },
      differences: [{ candidateId: Schema.Types.ObjectId, monitored: Number, official: Number }]
    }
  },
  { timestamps: true }
);
stationResultSchema.index({ electionId: 1, pollingStationId: 1, position: 1 }, { unique: true });
stationResultSchema.index({ electionId: 1, position: 1, countyId: 1, status: 1 });
stationResultSchema.index({ electionId: 1, position: 1, constituencyId: 1 });
stationResultSchema.index({ electionId: 1, position: 1, wardId: 1 });
export const StationResult = model('StationResult', stationResultSchema);

/** Official results transcribed from an official publication, used for matching only. */
const officialStationResultSchema = new Schema(
  {
    electionId: { type: Schema.Types.ObjectId, ref: 'Election', required: true },
    pollingStationId: { type: Schema.Types.ObjectId, ref: 'PollingStation', required: true },
    position: { type: String, enum: POSITIONS, required: true },
    candidateVotes: { type: [candidateVoteSchema], required: true },
    fields: { type: fieldsSchema, default: {} },
    isFinalDeclared: { type: Boolean, default: false },
    sourceId: { type: Schema.Types.ObjectId, ref: 'DataSource', required: true },
    importJobId: { type: Schema.Types.ObjectId, ref: 'ImportJob' }
  },
  { timestamps: true }
);
officialStationResultSchema.index({ electionId: 1, pollingStationId: 1, position: 1 }, { unique: true });
export const OfficialStationResult = model('OfficialStationResult', officialStationResultSchema);

/**
 * A live counting session: one per agent per station/position per counting pass. Every tap on
 * "+" is recorded immediately as a TallyEvent, giving reviewers a timestamped trail of how the
 * count was built. The session total is a running tally, not a submission.
 */
const countSessionSchema = new Schema(
  {
    clientSessionId: { type: String, required: true, unique: true },
    electionId: { type: Schema.Types.ObjectId, ref: 'Election', required: true },
    pollingStationId: { type: Schema.Types.ObjectId, ref: 'PollingStation', required: true },
    countyId: { type: Schema.Types.ObjectId, ref: 'County', required: true },
    position: { type: String, enum: POSITIONS, required: true },
    agentId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['OPEN', 'SUBMITTED', 'ABANDONED'], default: 'OPEN' },
    /** candidateId -> running count */
    tallies: { type: Map, of: Number, default: {} },
    lastSeq: { type: Number, default: 0 },
    lastHash: { type: String, default: '0'.repeat(64) },
    increments: { type: Number, default: 0 },
    undos: { type: Number, default: 0 },
    manualSets: { type: Number, default: 0 },
    flags: [{ type: String }],
    startedAt: { type: Date, default: Date.now },
    lastEventAt: { type: Date },
    submittedAs: { submissionId: String, revision: Number }
  },
  { timestamps: true }
);
countSessionSchema.index({ agentId: 1, electionId: 1, pollingStationId: 1, position: 1, status: 1 });
export const CountSession = model('CountSession', countSessionSchema);

export const UNDO_REASONS = ['ACCIDENTAL_TAP', 'WRONG_CANDIDATE', 'DOUBLE_COUNTED', 'OTHER'] as const;

const tallyEventSchema = new Schema(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'CountSession', required: true },
    seq: { type: Number, required: true },
    kind: { type: String, enum: ['INCREMENT', 'UNDO', 'SET'], required: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'Candidate', required: true },
    /** For UNDO: the INCREMENT being reversed. */
    undoOfSeq: { type: Number },
    /** For SET: the value entered manually. */
    value: { type: Number, min: 0 },
    reasonCode: { type: String, enum: UNDO_REASONS },
    reason: { type: String, maxlength: 300 },
    clientAt: { type: Date },
    serverAt: { type: Date, required: true },
    flags: [{ type: String }],
    undone: { type: Boolean, default: false },
    prevHash: { type: String, required: true },
    hash: { type: String, required: true }
  },
  { versionKey: false }
);
tallyEventSchema.index({ sessionId: 1, seq: 1 }, { unique: true });
export const TallyEvent = model('TallyEvent', tallyEventSchema);

/** An AI reading of an uploaded results form. Advisory only: a person always confirms. */
const formExtractionSchema = new Schema(
  {
    fileId: { type: Schema.Types.ObjectId, ref: 'StoredFile', required: true, index: true },
    electionId: { type: Schema.Types.ObjectId, ref: 'Election', required: true },
    pollingStationId: { type: Schema.Types.ObjectId, ref: 'PollingStation', required: true },
    position: { type: String, enum: POSITIONS, required: true },
    formCode: { type: String },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    model: { type: String, required: true },
    status: { type: String, enum: ['COMPLETED', 'UNREADABLE', 'REFUSED', 'FAILED'], required: true },
    candidateVotes: [{ candidateId: { type: Schema.Types.ObjectId, ref: 'Candidate' }, votes: Number, confidence: String, _id: false }],
    fields: { type: Schema.Types.Mixed },
    stationCodeSeen: { type: String },
    formCodeSeen: { type: String },
    stampOrSignaturesVisible: { type: Boolean },
    warnings: [{ type: String }],
    usage: { inputTokens: Number, outputTokens: Number }
  },
  { timestamps: true }
);
export const FormExtraction = model('FormExtraction', formExtractionSchema);
