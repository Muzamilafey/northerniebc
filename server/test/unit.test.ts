import { describe, expect, it } from 'vitest';
import { reconcile, sameFigures } from '../src/modules/results/reconciliation.js';
import { computeShares, coverage } from '../src/modules/results/tally.js';
import { sniffMime } from '../src/modules/files/storage.js';
import { percent } from '../src/lib/money.js';
import { contentHashOf, chainHashOf } from '../src/lib/audit.js';
import { classifyStkResult, darajaTimestamp } from '../src/payments/mpesa.js';
import { isValidFinancialYear } from '../src/models/common.js';
import { progressOf } from '../src/modules/projects/routes.js';
import { decrypt, encrypt, maskPhone } from '../src/lib/crypto.js';

describe('vote calculations', () => {
  it('computes shares over valid candidate votes with dense ranks', () => {
    const r = computeShares([
      { candidateId: 'a', votes: 120, verifiedVotes: 100 },
      { candidateId: 'b', votes: 95, verifiedVotes: 95 },
      { candidateId: 'c', votes: 95, verifiedVotes: 0 }
    ]);
    expect(r.totalVotes).toBe(310);
    expect(r.verifiedVotes).toBe(195);
    expect(r.rows.map((x) => x.rank)).toEqual([1, 2, 2]);
    expect(r.rows[0]!.share).toBeCloseTo(38.71, 2);
  });
  it('never divides by zero', () => {
    expect(computeShares([{ candidateId: 'a', votes: 0, verifiedVotes: 0 }]).rows[0]!.share).toBeNull();
    expect(coverage(0, 0).percent).toBeNull();
    expect(percent(5, 0)).toBeNull();
    expect(coverage(3, 4)).toEqual({ reported: 3, registered: 4, outstanding: 1, percent: 75 });
  });
});

describe('reconciliation', () => {
  const cv = [{ votes: 100 }, { votes: 50 }];
  it('applies only configured rules and reports, never adjusts', () => {
    expect(reconcile({ candidateVotes: cv, fields: { validVotes: 140 }, rules: [], requiredFields: [] })).toEqual([]);
    const issues = reconcile({ candidateVotes: cv, fields: { validVotes: 140, rejectedVotes: 5, totalVotesCast: 150 }, rules: ['CANDIDATE_SUM_EQUALS_VALID', 'VALID_PLUS_REJECTED_EQUALS_CAST'], requiredFields: ['registeredVoters'] });
    expect(issues.map((i) => i.rule).sort()).toEqual(['CANDIDATE_SUM_EQUALS_VALID', 'REQUIRED_FIELD_MISSING', 'VALID_PLUS_REJECTED_EQUALS_CAST']);
    expect(reconcile({ candidateVotes: cv, fields: {}, rules: ['CAST_NOT_EXCEEDING_REGISTERED'], requiredFields: [], stationRegisteredVoters: 120 })).toHaveLength(1);
  });
  it('compares figures exactly', () => {
    const a = { candidateVotes: [{ candidateId: 'x', votes: 1 }], fields: { validVotes: 1 } };
    expect(sameFigures(a, { ...a })).toBe(true);
    expect(sameFigures(a, { candidateVotes: [{ candidateId: 'x', votes: 2 }], fields: { validVotes: 1 } })).toBe(false);
  });
});

describe('uploads', () => {
  it('detects real file types from content, not names', () => {
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from('a,b\n1,2\n'))).toBe('text/csv');
    expect(sniffMime(Buffer.from([0x4d, 0x5a, 0x90, 0x00]))).toBeNull(); // Windows executable
    expect(sniffMime(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBeNull(); // arbitrary zip
  });
});

describe('misc', () => {
  it('audit hashes are deterministic and order-sensitive', () => {
    const c = { at: new Date('2026-01-01T00:00:00Z'), action: 'x', entityType: 'Y', after: { b: 1, a: 2 } };
    expect(contentHashOf(c)).toBe(contentHashOf({ ...c, after: { a: 2, b: 1 } }));
    expect(chainHashOf('h', 1, 'p')).not.toBe(chainHashOf('h', 2, 'p'));
  });
  it('M-Pesa helpers', () => {
    expect(classifyStkResult(0)).toBe('SUCCESS');
    expect(classifyStkResult('1032')).toBe('CANCELLED');
    expect(classifyStkResult('4999')).toBe('UNKNOWN');
    expect(darajaTimestamp(new Date('2026-10-24T21:30:00Z'))).toBe('20261025003000');
  });
  it('financial years', () => {
    expect(isValidFinancialYear('2023/24')).toBe(true);
    expect(isValidFinancialYear('2023/25')).toBe(false);
    expect(isValidFinancialYear('2099/00')).toBe(true);
  });
  it('project progress keeps financial and physical separate', () => {
    const p = progressOf({ approvedBudgetCents: 1000, amountPaidCents: 1000, physicalProgress: null });
    expect(p.financial.percent).toBe(100);
    expect(p.physical).toBeNull();
    expect(p.exceedsThreshold).toBe(false);
  });
  it('field encryption round-trips and masks', () => {
    const c = encrypt('254712345678');
    expect(c).not.toContain('2547');
    expect(decrypt(c)).toBe('254712345678');
    expect(maskPhone('254712345678')).toBe('2547******78');
  });
});
