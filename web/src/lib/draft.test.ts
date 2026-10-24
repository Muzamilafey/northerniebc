import { describe, expect, it } from 'vitest';
import { increment, newDraft, queue, setVotes, toPayload, total, undoLast, type Draft } from './draft';

let n = 0;
const base = () => newDraft('e1', 's1', 'GOVERNOR', ['a', 'b'], null, () => `session-${++n}`);

describe('live counting draft', () => {
  it('"+" adds exactly one vote and produces a sequenced tap event; it never queues a submission', () => {
    let d = base();
    const r1 = increment(d, 'a');
    const r2 = increment(r1.draft, 'a');
    const r3 = increment(r2.draft, 'b');
    d = r3.draft;
    expect(d.candidateVotes).toEqual({ a: 2, b: 1 });
    expect([r1.event!.seq, r2.event!.seq, r3.event!.seq]).toEqual([1, 2, 3]);
    expect(r1.event!.kind).toBe('INCREMENT');
    expect(d.state).toBe('DRAFT');
    expect(total(d)).toBe(3);
  });

  it('undo reverses only the previous addition and requires a reason for "other"', () => {
    let d = increment(increment(base(), 'a').draft, 'b').draft;
    expect(() => undoLast(d, 'OTHER')).toThrow(/Explain/);
    const u = undoLast(d, 'WRONG_CANDIDATE');
    expect(u.draft.candidateVotes).toEqual({ a: 1, b: 0 });
    expect(u.event).toMatchObject({ kind: 'UNDO', candidateId: 'b', undoOfSeq: 2, reasonCode: 'WRONG_CANDIDATE', seq: 3 });
    d = undoLast(u.draft, 'ACCIDENTAL_TAP').draft;
    expect(d.candidateVotes).toEqual({ a: 0, b: 0 });
    expect(undoLast(d, 'ACCIDENTAL_TAP').event).toBeUndefined();
  });

  it('manual entry is recorded with a reason and rejects invalid values', () => {
    const r = setVotes(base(), 'a', 120, 'Transcribed from Form 37A');
    expect(r.draft.candidateVotes.a).toBe(120);
    expect(r.event).toMatchObject({ kind: 'SET', value: 120, reason: 'Transcribed from Form 37A' });
    expect(setVotes(r.draft, 'a', -1).draft.candidateVotes.a).toBe(120);
    expect(setVotes(r.draft, 'a', 1.5).draft.candidateVotes.a).toBe(120);
  });

  it('ignores unknown candidates and does not edit queued drafts', () => {
    expect(increment(base(), 'zzz').draft.candidateVotes).toEqual({ a: 0, b: 0 });
    const q = queue({ ...base(), declarationAccepted: true }, () => 'k1');
    expect(increment(q, 'a').draft.candidateVotes.a).toBe(0);
  });

  it('queueing requires the declaration; corrections require a reason; keys are stable across retries', () => {
    expect(() => queue(base(), () => 'k')).toThrow(/declaration/);
    expect(() => queue({ ...base(), declarationAccepted: true, baseRevision: 1 }, () => 'k')).toThrow(/reason/);
    const q1 = queue({ ...base(), declarationAccepted: true }, () => 'key-1');
    const q2 = queue({ ...q1, state: 'DRAFT' }, () => 'key-2');
    expect(q2.idempotencyKey).toBe('key-1');
    expect(toPayload(q1, 'dev')).toMatchObject({ idempotencyKey: 'key-1', countSessionId: q1.countSessionId });
  });

  it('editing a synced result starts a correction without a live session', () => {
    const synced: Draft = { ...base(), state: 'SYNCED', receipt: { receiptId: 'r', submissionId: 's', revision: 2, serverReceivedAt: '', payloadHash: '', reconciliationIssues: [] } };
    const r = increment(synced, 'a');
    expect(r.draft.state).toBe('DRAFT');
    expect(r.draft.baseRevision).toBe(2);
    expect(r.draft.countSessionId).toBeUndefined();
    expect(r.event).toBeUndefined();
  });
});
