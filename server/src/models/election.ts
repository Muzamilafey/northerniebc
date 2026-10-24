import { Schema, model } from 'mongoose';
import { pointSchema } from './common.js';

/** The five counties covered. Counties are constitutional units and are not election-specific. */
const countySchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    name: { type: String, required: true, unique: true },
    slug: { type: String, required: true, unique: true },
    region: { type: String },
    /** County emblem/logo shown on county pages (public image, uploaded by an administrator). */
    logoFileId: { type: Schema.Types.ObjectId, ref: 'StoredFile' },
    sourceId: { type: Schema.Types.ObjectId, ref: 'DataSource' }
  },
  { timestamps: true }
);
export const County = model('County', countySchema);

/** Political parties used by aspirants, with their logo/symbol. */
const partySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    abbreviation: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
    logoFileId: { type: Schema.Types.ObjectId, ref: 'StoredFile' },
    active: { type: Boolean, default: true },
    sourceReference: { type: String, maxlength: 300 }
  },
  { timestamps: true }
);
partySchema.index({ abbreviation: 1 }, { unique: true });
partySchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
export const Party = model('Party', partySchema);

/**
 * Constituencies, wards and polling stations are election-specific: boundaries and the
 * station register can change between elections, so each record belongs to one election.
 */
const constituencySchema = new Schema(
  {
    electionId: { type: Schema.Types.ObjectId, ref: 'Election', required: true },
    countyId: { type: Schema.Types.ObjectId, ref: 'County', required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    sourceId: { type: Schema.Types.ObjectId, ref: 'DataSource' }
  },
  { timestamps: true }
);
constituencySchema.index({ electionId: 1, code: 1 }, { unique: true });
constituencySchema.index({ electionId: 1, countyId: 1 });
export const Constituency = model('Constituency', constituencySchema);

const wardSchema = new Schema(
  {
    electionId: { type: Schema.Types.ObjectId, ref: 'Election', required: true },
    countyId: { type: Schema.Types.ObjectId, ref: 'County', required: true },
    constituencyId: { type: Schema.Types.ObjectId, ref: 'Constituency', required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    sourceId: { type: Schema.Types.ObjectId, ref: 'DataSource' }
  },
  { timestamps: true }
);
wardSchema.index({ electionId: 1, code: 1 }, { unique: true });
wardSchema.index({ electionId: 1, constituencyId: 1 });
export const Ward = model('Ward', wardSchema);

const pollingStationSchema = new Schema(
  {
    electionId: { type: Schema.Types.ObjectId, ref: 'Election', required: true },
    countyId: { type: Schema.Types.ObjectId, ref: 'County', required: true },
    constituencyId: { type: Schema.Types.ObjectId, ref: 'Constituency', required: true },
    wardId: { type: Schema.Types.ObjectId, ref: 'Ward', required: true },
    /** Official station (stream) code from the election register. */
    code: { type: String, required: true },
    name: { type: String, required: true },
    registeredVoters: { type: Number, min: 0 },
    location: { type: pointSchema },
    active: { type: Boolean, default: true },
    sourceId: { type: Schema.Types.ObjectId, ref: 'DataSource' }
  },
  { timestamps: true }
);
pollingStationSchema.index({ electionId: 1, code: 1 }, { unique: true });
pollingStationSchema.index({ electionId: 1, wardId: 1 });
pollingStationSchema.index({ electionId: 1, constituencyId: 1 });
pollingStationSchema.index({ electionId: 1, countyId: 1 });
pollingStationSchema.index({ name: 'text' });
export const PollingStation = model('PollingStation', pollingStationSchema);

export const POSITIONS = ['PRESIDENT', 'GOVERNOR', 'SENATOR', 'WOMAN_REP', 'MP', 'MCA'] as const;
export type Position = (typeof POSITIONS)[number];
export const POSITION_LABELS: Record<Position, string> = {
  PRESIDENT: 'President',
  GOVERNOR: 'Governor',
  SENATOR: 'Senator',
  WOMAN_REP: 'Woman Representative',
  MP: 'Member of Parliament',
  MCA: 'Member of County Assembly'
};
export type ScopeType = 'NATIONAL' | 'COUNTY' | 'CONSTITUENCY' | 'WARD';
export const POSITION_SCOPE: Record<Position, ScopeType> = {
  PRESIDENT: 'NATIONAL',
  GOVERNOR: 'COUNTY',
  SENATOR: 'COUNTY',
  WOMAN_REP: 'COUNTY',
  MP: 'CONSTITUENCY',
  MCA: 'WARD'
};

/** Fields an agent may be asked to transcribe from a results form. */
export const RECONCILIATION_FIELDS = [
  'registeredVoters',
  'totalVotesCast',
  'rejectedVotes',
  'rejectedObjectedTo',
  'disputedVotes',
  'validVotes'
] as const;
export type ReconciliationField = (typeof RECONCILIATION_FIELDS)[number];

/**
 * Reconciliation rules are configured per election and position by an administrator, based on
 * the official documentation for that election. Nothing is assumed by default except rules
 * that are arithmetic identities of the submitted data itself.
 */
export const RECONCILIATION_RULES = [
  'CANDIDATE_SUM_EQUALS_VALID',
  'VALID_PLUS_REJECTED_EQUALS_CAST',
  'CAST_NOT_EXCEEDING_REGISTERED',
  'REGISTERED_MATCHES_STATION_REGISTER'
] as const;
export type ReconciliationRule = (typeof RECONCILIATION_RULES)[number];

const positionConfigSchema = new Schema(
  {
    position: { type: String, enum: POSITIONS, required: true },
    enabled: { type: Boolean, default: true },
    /** Official results form code for this position at polling-station level, e.g. "34A". */
    formCode: { type: String, maxlength: 10 },
    formReferenceLabel: { type: String, default: 'Official results form reference' },
    requiredFields: [{ type: String, enum: RECONCILIATION_FIELDS }],
    rules: [{ type: String, enum: RECONCILIATION_RULES }],
    requireEvidence: { type: Boolean, default: true },
    rulesSourceId: { type: Schema.Types.ObjectId, ref: 'DataSource' }
  },
  { _id: false }
);

const electionSchema = new Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    type: { type: String, enum: ['GENERAL', 'BY_ELECTION'], required: true },
    electionDate: { type: Date, required: true },
    status: { type: String, enum: ['DRAFT', 'ACTIVE', 'CLOSED', 'ARCHIVED'], default: 'DRAFT', index: true },
    /** For by-elections: limit to these areas. Empty means all covered counties. */
    countyIds: [{ type: Schema.Types.ObjectId, ref: 'County' }],
    positions: { type: [positionConfigSchema], default: [] },
    /** When false, only verified results are shown publicly. */
    publishProvisional: { type: Boolean, default: false },
    /** When agents may send counts and results (see modules/elections/intake.ts). */
    resultsIntake: {
      mode: { type: String, enum: ['OPEN', 'CLOSED', 'SCHEDULED'], default: 'OPEN' },
      opensAt: { type: Date },
      closesAt: { type: Date }
    },
    /** Station count used as national denominator for presidential coverage is NOT assumed; coverage is per covered stations. */
    resultsVisibleFrom: { type: Date },
    sourceId: { type: Schema.Types.ObjectId, ref: 'DataSource' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);
export const Election = model('Election', electionSchema);

const candidateSchema = new Schema(
  {
    electionId: { type: Schema.Types.ObjectId, ref: 'Election', required: true },
    position: { type: String, enum: POSITIONS, required: true },
    fullName: { type: String, required: true, trim: true },
    /** Registered party, if any. `party` / `partyAbbreviation` keep the name as shown on the ballot. */
    partyId: { type: Schema.Types.ObjectId, ref: 'Party' },
    party: { type: String, trim: true },
    partyAbbreviation: { type: String, trim: true },
    independent: { type: Boolean, default: false },
    photoFileId: { type: Schema.Types.ObjectId, ref: 'StoredFile' },
    scopeType: { type: String, enum: ['NATIONAL', 'COUNTY', 'CONSTITUENCY', 'WARD'], required: true },
    /** County / constituency / ward id depending on scopeType. Null for NATIONAL. */
    scopeRefId: { type: Schema.Types.ObjectId },
    ballotOrder: { type: Number },
    active: { type: Boolean, default: true },
    sourceId: { type: Schema.Types.ObjectId, ref: 'DataSource' },
    sourceReference: { type: String }
  },
  { timestamps: true }
);
candidateSchema.index({ electionId: 1, position: 1, scopeRefId: 1, fullName: 1 }, { unique: true });
candidateSchema.index({ fullName: 'text', party: 'text' });
export const Candidate = model('Candidate', candidateSchema);

const agentAssignmentSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    electionId: { type: Schema.Types.ObjectId, ref: 'Election', required: true },
    pollingStationId: { type: Schema.Types.ObjectId, ref: 'PollingStation', required: true },
    countyId: { type: Schema.Types.ObjectId, ref: 'County', required: true },
    constituencyId: { type: Schema.Types.ObjectId, ref: 'Constituency', required: true },
    wardId: { type: Schema.Types.ObjectId, ref: 'Ward', required: true },
    active: { type: Boolean, default: true },
    assignedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    revokedAt: { type: Date },
    revokedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    revokeReason: { type: String }
  },
  { timestamps: true }
);
agentAssignmentSchema.index(
  { userId: 1, electionId: 1, pollingStationId: 1 },
  { unique: true, partialFilterExpression: { active: true } }
);
agentAssignmentSchema.index({ electionId: 1, pollingStationId: 1, active: 1 });
export const AgentAssignment = model('AgentAssignment', agentAssignmentSchema);

/**
 * Default polling-station results forms by position (Kenyan general elections). These are
 * starting templates only: confirm each against the forms gazetted for the specific election
 * before relying on them, and adjust fields and rules in Election setup.
 */
export const FORM_TEMPLATES: Record<Position, { formCode: string; title: string; requiredFields: ReconciliationField[]; rules: ReconciliationRule[] }> = {
  PRESIDENT: {
    formCode: '34A',
    title: 'Form 34A — Presidential election results at the polling station',
    requiredFields: ['registeredVoters', 'rejectedVotes', 'rejectedObjectedTo', 'disputedVotes', 'validVotes'],
    rules: ['CANDIDATE_SUM_EQUALS_VALID', 'CAST_NOT_EXCEEDING_REGISTERED', 'REGISTERED_MATCHES_STATION_REGISTER']
  },
  MP: { formCode: '35A', title: 'Form 35A — National Assembly election results at the polling station', requiredFields: ['registeredVoters', 'rejectedVotes', 'validVotes'], rules: ['CANDIDATE_SUM_EQUALS_VALID', 'CAST_NOT_EXCEEDING_REGISTERED'] },
  MCA: { formCode: '36A', title: 'Form 36A — County Assembly election results at the polling station', requiredFields: ['registeredVoters', 'rejectedVotes', 'validVotes'], rules: ['CANDIDATE_SUM_EQUALS_VALID', 'CAST_NOT_EXCEEDING_REGISTERED'] },
  GOVERNOR: { formCode: '37A', title: 'Form 37A — Governor election results at the polling station', requiredFields: ['registeredVoters', 'rejectedVotes', 'validVotes'], rules: ['CANDIDATE_SUM_EQUALS_VALID', 'CAST_NOT_EXCEEDING_REGISTERED'] },
  SENATOR: { formCode: '38A', title: 'Form 38A — Senator election results at the polling station', requiredFields: ['registeredVoters', 'rejectedVotes', 'validVotes'], rules: ['CANDIDATE_SUM_EQUALS_VALID', 'CAST_NOT_EXCEEDING_REGISTERED'] },
  WOMAN_REP: { formCode: '39A', title: 'Form 39A — County Woman Member of the National Assembly results at the polling station', requiredFields: ['registeredVoters', 'rejectedVotes', 'validVotes'], rules: ['CANDIDATE_SUM_EQUALS_VALID', 'CAST_NOT_EXCEEDING_REGISTERED'] }
};
