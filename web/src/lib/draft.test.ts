import { describe, expect, it } from 'vitest';
import { increment, newDraft, queue, setVotes, toPayload, total, undo } from './draft';

const base = () => newDraft('e1', 's1', 'GOVERNOR', ['a', 'b']);

describe('draft counting', () => {
  it('increments one vote at a time and undoes', () => {
    let d = base();
    d = increment(d, 'a');
    d = increment(d, 'a');
    d = increment(d, 'b');
    expect(d.candidateVotes).toEqual({ a: 2, b: 1 });
    d = undo(d);
    expect(d.candidateVotes).toEqual({ a: 2, b: 0 });
    expect(total(d)).toBe(2);
  });

  it('manual entry is undoable and rejects invalid values', () => {
    let d = setVotes(base(), 'a', 120);
    expect(d.candidateVotes.a).toBe(120);
    expect(setVotes(d, 'a', -1).candidateVotes.a).toBe(120);
    expect(setVotes(d, 'a', 1.5).candidateVotes.a).toBe(120);
    d = undo(d);
    expect(d.candidateVotes.a).toBe(0);
  });

  it('ignores unknown candidates and does not edit queued drafts', () => {
    expect(increment(base(), 'zzz').candidateVotes).toEqual({ a: 0, b: 0 });
    const q = queue({ ...base(), declarationAccepted: true }, () => 'k1');
    expect(increment(q, 'a').candidateVotes.a).toBe(0);
  });

  it('queueing requires the declaration, and corrections require a reason', () => {
    expect(() => queue(base(), () => 'k')).toThrow(/declaration/);
    expect(() => queue({ ...base(), declarationAccepted: true, baseRevision: 1 }, () => 'k')).toThrow(/reason/);
  });

  it('keeps the same idempotency key across retries', () => {
    const q1 = queue({ ...base(), declarationAccepted: true }, () => 'key-1');
    const q2 = queue({ ...q1, state: 'DRAFT' }, () => 'key-2');
    expect(q2.idempotencyKey).toBe('key-1');
    expect(toPayload(q1, 'dev').idempotencyKey).toBe('key-1');
  });

  it('editing a synced result starts a correction against the server revision', () => {
    const synced = { ...base(), state: 'SYNCED' as const, receipt: { receiptId: 'r', submissionId: 's', revision: 2, serverReceivedAt: '', payloadHash: '', reconciliationIssues: [] } };
    const d = increment(synced, 'a');
    expect(d.state).toBe('DRAFT');
    expect(d.baseRevision).toBe(2);
    expect(d.declarationAccepted).toBe(false);
  });
});
