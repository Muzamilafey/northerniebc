/** Pure draft-editing logic (unit-tested). Drafts never leave the device until submitted. */
export type DraftState = 'DRAFT' | 'QUEUED' | 'SYNCING' | 'SYNCED' | 'FAILED' | 'CONFLICT';

export interface DraftEvidence {
  localId: string;
  name: string;
  type: string;
  blob?: Blob;
  fileId?: string;
}

export type DraftOp = { kind: 'inc'; candidateId: string } | { kind: 'set'; candidateId: string; prev: number };

export interface Draft {
  key: string;
  electionId: string;
  stationId: string;
  position: string;
  candidateVotes: Record<string, number>;
  fields: Record<string, number | undefined>;
  formReference?: string;
  evidence: DraftEvidence[];
  history: DraftOp[];
  declarationAccepted: boolean;
  /** Server revision this draft amends; null for a first submission. */
  baseRevision: number | null;
  correctionReason?: string;
  state: DraftState;
  /** Generated when queued and reused on every retry, so retries can never duplicate. */
  idempotencyKey?: string;
  queuedAt?: number;
  attempts?: number;
  lastError?: string;
  conflictServerRevision?: number | null;
  receipt?: { receiptId: string; submissionId: string; revision: number; serverReceivedAt: string; payloadHash: string; reconciliationIssues: { rule: string; message: string }[] };
  updatedAt: number;
}

export const draftKey = (electionId: string, stationId: string, position: string) => `${electionId}:${stationId}:${position}`;

export function newDraft(electionId: string, stationId: string, position: string, candidateIds: string[], baseRevision: number | null = null): Draft {
  return {
    key: draftKey(electionId, stationId, position),
    electionId,
    stationId,
    position,
    candidateVotes: Object.fromEntries(candidateIds.map((id) => [id, 0])),
    fields: {},
    evidence: [],
    history: [],
    declarationAccepted: false,
    baseRevision,
    state: 'DRAFT',
    updatedAt: Date.now()
  };
}

const editable = (d: Draft) => d.state === 'DRAFT' || d.state === 'FAILED' || d.state === 'CONFLICT' || d.state === 'SYNCED';

/** After a synced submission, further edits start a correction against the server revision. */
function startEditing(d: Draft): Draft {
  if (d.state !== 'SYNCED') return d;
  return { ...d, state: 'DRAFT', baseRevision: d.receipt?.revision ?? d.baseRevision, idempotencyKey: undefined, correctionReason: undefined, declarationAccepted: false };
}

export function increment(d: Draft, candidateId: string): Draft {
  if (!editable(d) || !(candidateId in d.candidateVotes)) return d;
  const x = startEditing(d);
  return { ...x, candidateVotes: { ...x.candidateVotes, [candidateId]: x.candidateVotes[candidateId]! + 1 }, history: [...x.history, { kind: 'inc', candidateId }], updatedAt: Date.now() };
}

export function setVotes(d: Draft, candidateId: string, value: number): Draft {
  if (!editable(d) || !(candidateId in d.candidateVotes) || !Number.isInteger(value) || value < 0) return d;
  const x = startEditing(d);
  return { ...x, candidateVotes: { ...x.candidateVotes, [candidateId]: value }, history: [...x.history, { kind: 'set', candidateId, prev: x.candidateVotes[candidateId]! }], updatedAt: Date.now() };
}

export function undo(d: Draft): Draft {
  if (!editable(d) || d.history.length === 0) return d;
  const op = d.history[d.history.length - 1]!;
  const votes = { ...d.candidateVotes };
  if (op.kind === 'inc') votes[op.candidateId] = Math.max(0, votes[op.candidateId]! - 1);
  else votes[op.candidateId] = op.prev;
  return { ...d, candidateVotes: votes, history: d.history.slice(0, -1), updatedAt: Date.now() };
}

export function total(d: Draft) {
  return Object.values(d.candidateVotes).reduce((a, b) => a + b, 0);
}

export function queue(d: Draft, makeKey: () => string): Draft {
  if (!d.declarationAccepted) throw new Error('Accept the declaration before submitting');
  if (d.baseRevision != null && (!d.correctionReason || d.correctionReason.trim().length < 5)) throw new Error('Give a reason for the correction');
  return { ...d, state: 'QUEUED', idempotencyKey: d.idempotencyKey ?? makeKey(), queuedAt: d.queuedAt ?? Date.now(), attempts: 0, lastError: undefined, updatedAt: Date.now() };
}

export function toPayload(d: Draft, deviceId: string) {
  return {
    idempotencyKey: d.idempotencyKey!,
    electionId: d.electionId,
    pollingStationId: d.stationId,
    position: d.position,
    candidateVotes: Object.entries(d.candidateVotes).map(([candidateId, votes]) => ({ candidateId, votes })),
    fields: Object.fromEntries(Object.entries(d.fields).filter(([, v]) => v !== undefined && v !== null && !Number.isNaN(v))),
    formReference: d.formReference || undefined,
    evidenceFileIds: d.evidence.map((e) => e.fileId!).filter(Boolean),
    declarationAccepted: d.declarationAccepted,
    clientCreatedAt: new Date(d.updatedAt).toISOString(),
    clientDeviceId: deviceId,
    baseRevision: d.baseRevision,
    correctionReason: d.baseRevision != null ? d.correctionReason : undefined
  };
}
