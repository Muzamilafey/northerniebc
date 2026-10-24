/** Pure draft-editing logic (unit-tested). Drafts never leave the device until submitted. */
export type DraftState = 'DRAFT' | 'QUEUED' | 'AWAITING_CONFIRMATION' | 'SYNCING' | 'SYNCED' | 'FAILED' | 'CONFLICT';

export interface DraftEvidence {
  localId: string;
  name: string;
  type: string;
  blob?: Blob;
  fileId?: string;
}

export type UndoReason = 'ACCIDENTAL_TAP' | 'WRONG_CANDIDATE' | 'DOUBLE_COUNTED' | 'OTHER';

/** A counting event sent to the server immediately after each tap (the live tally log). */
export interface TallyEvent {
  seq: number;
  kind: 'INCREMENT' | 'UNDO' | 'SET';
  candidateId: string;
  undoOfSeq?: number;
  value?: number;
  reasonCode?: UndoReason;
  reason?: string;
  clientAt: string;
}

export interface Draft {
  key: string;
  electionId: string;
  stationId: string;
  position: string;
  candidateVotes: Record<string, number>;
  fields: Record<string, number | undefined>;
  formReference?: string;
  evidence: DraftEvidence[];
  /** Live counting session id; undefined for corrections entered from the form. */
  countSessionId?: string;
  nextSeq: number;
  /** Additions that can still be undone, most recent last. */
  undoable: { seq: number; candidateId: string }[];
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

export function newDraft(electionId: string, stationId: string, position: string, candidateIds: string[], baseRevision: number | null = null, makeId: () => string = () => crypto.randomUUID()): Draft {
  return {
    key: draftKey(electionId, stationId, position),
    electionId,
    stationId,
    position,
    candidateVotes: Object.fromEntries(candidateIds.map((id) => [id, 0])),
    fields: {},
    evidence: [],
    // A first count is recorded tap by tap; corrections are entered from the form.
    countSessionId: baseRevision == null ? makeId() : undefined,
    nextSeq: 1,
    undoable: [],
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
  return { ...d, state: 'DRAFT', baseRevision: d.receipt?.revision ?? d.baseRevision, idempotencyKey: undefined, correctionReason: undefined, declarationAccepted: false, countSessionId: undefined, nextSeq: 1, undoable: [] };
}

export interface Change {
  draft: Draft;
  event?: TallyEvent;
}

const stamp = () => new Date().toISOString();

/** "+" adds exactly one vote to the draft. It never submits anything. */
export function increment(d: Draft, candidateId: string): Change {
  if (!editable(d) || !(candidateId in d.candidateVotes)) return { draft: d };
  const x = startEditing(d);
  const live = Boolean(x.countSessionId);
  const seq = x.nextSeq;
  return {
    draft: {
      ...x,
      candidateVotes: { ...x.candidateVotes, [candidateId]: x.candidateVotes[candidateId]! + 1 },
      nextSeq: live ? seq + 1 : seq,
      undoable: [...x.undoable, { seq, candidateId }],
      updatedAt: Date.now()
    },
    event: live ? { seq, kind: 'INCREMENT', candidateId, clientAt: stamp() } : undefined
  };
}

/** Undoes the previous addition only. A reason is always required. */
export function undoLast(d: Draft, reasonCode: UndoReason, reason?: string): Change {
  if (!editable(d) || d.undoable.length === 0) return { draft: d };
  if (reasonCode === 'OTHER' && (!reason || reason.trim().length < 3)) throw new Error('Explain why you are undoing this addition');
  const last = d.undoable[d.undoable.length - 1]!;
  const live = Boolean(d.countSessionId);
  return {
    draft: {
      ...d,
      candidateVotes: { ...d.candidateVotes, [last.candidateId]: Math.max(0, d.candidateVotes[last.candidateId]! - 1) },
      undoable: d.undoable.slice(0, -1),
      nextSeq: live ? d.nextSeq + 1 : d.nextSeq,
      updatedAt: Date.now()
    },
    event: live ? { seq: d.nextSeq, kind: 'UNDO', candidateId: last.candidateId, undoOfSeq: last.seq, reasonCode, reason: reason?.trim() || undefined, clientAt: stamp() } : undefined
  };
}

/** Manual entry (e.g. transcribing the form). Recorded with a reason; clears the undo stack for that candidate. */
export function setVotes(d: Draft, candidateId: string, value: number, reason = 'Entered manually'): Change {
  if (!editable(d) || !(candidateId in d.candidateVotes) || !Number.isInteger(value) || value < 0) return { draft: d };
  const x = startEditing(d);
  const live = Boolean(x.countSessionId);
  return {
    draft: { ...x, candidateVotes: { ...x.candidateVotes, [candidateId]: value }, undoable: x.undoable.filter((u) => u.candidateId !== candidateId), nextSeq: live ? x.nextSeq + 1 : x.nextSeq, updatedAt: Date.now() },
    event: live ? { seq: x.nextSeq, kind: 'SET', candidateId, value, reason, clientAt: stamp() } : undefined
  };
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
    correctionReason: d.baseRevision != null ? d.correctionReason : undefined,
    countSessionId: d.countSessionId
  };
}
