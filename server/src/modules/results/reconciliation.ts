import type { ReconciliationField, ReconciliationRule } from '../../models/election.js';

export type ResultFields = Partial<Record<ReconciliationField, number>>;

export interface ReconciliationIssue {
  rule: ReconciliationRule | 'REQUIRED_FIELD_MISSING';
  message: string;
}

/**
 * Applies the rules configured for this election/position. Issues are flags for reviewers;
 * submitted figures are never adjusted to make totals reconcile.
 */
export function reconcile(input: {
  candidateVotes: { votes: number }[];
  fields: ResultFields;
  rules: readonly ReconciliationRule[];
  requiredFields: readonly ReconciliationField[];
  stationRegisteredVoters?: number | null;
}): ReconciliationIssue[] {
  const issues: ReconciliationIssue[] = [];
  const f = input.fields;
  const candidateSum = input.candidateVotes.reduce((a, c) => a + c.votes, 0);

  for (const rf of input.requiredFields) {
    if (f[rf] == null) issues.push({ rule: 'REQUIRED_FIELD_MISSING', message: `Required field "${rf}" was not provided` });
  }
  for (const rule of input.rules) {
    switch (rule) {
      case 'CANDIDATE_SUM_EQUALS_VALID':
        if (f.validVotes != null && f.validVotes !== candidateSum) {
          issues.push({ rule, message: `Candidate votes total ${candidateSum} but valid votes recorded as ${f.validVotes}` });
        }
        break;
      case 'VALID_PLUS_REJECTED_EQUALS_CAST':
        if (f.validVotes != null && f.rejectedVotes != null && f.totalVotesCast != null && f.validVotes + f.rejectedVotes !== f.totalVotesCast) {
          issues.push({ rule, message: `Valid (${f.validVotes}) + rejected (${f.rejectedVotes}) does not equal total cast (${f.totalVotesCast})` });
        }
        break;
      case 'CAST_NOT_EXCEEDING_REGISTERED': {
        const registered = f.registeredVoters ?? input.stationRegisteredVoters ?? null;
        const cast = f.totalVotesCast ?? (f.validVotes != null ? f.validVotes + (f.rejectedVotes ?? 0) : candidateSum);
        if (registered != null && cast > registered) {
          issues.push({ rule, message: `Votes cast (${cast}) exceed registered voters (${registered})` });
        }
        break;
      }
      case 'REGISTERED_MATCHES_STATION_REGISTER':
        if (f.registeredVoters != null && input.stationRegisteredVoters != null && f.registeredVoters !== input.stationRegisteredVoters) {
          issues.push({ rule, message: `Registered voters on form (${f.registeredVoters}) differ from the station register (${input.stationRegisteredVoters})` });
        }
        break;
    }
  }
  return issues;
}

/** True when two result sets record identical candidate votes and fields. */
export function sameFigures(
  a: { candidateVotes: { candidateId: unknown; votes: number }[]; fields?: ResultFields | null },
  b: { candidateVotes: { candidateId: unknown; votes: number }[]; fields?: ResultFields | null }
): boolean {
  if (a.candidateVotes.length !== b.candidateVotes.length) return false;
  const m = new Map(a.candidateVotes.map((c) => [String(c.candidateId), c.votes]));
  for (const c of b.candidateVotes) if (m.get(String(c.candidateId)) !== c.votes) return false;
  const fa = a.fields ?? {};
  const fb = b.fields ?? {};
  for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)]) as Set<keyof ResultFields>) {
    if ((fa[k] ?? null) !== (fb[k] ?? null)) return false;
  }
  return true;
}

export function candidateDifferences(
  a: { candidateId: unknown; votes: number }[],
  b: { candidateId: unknown; votes: number }[]
): { candidateId: string; a: number | null; b: number | null }[] {
  const ma = new Map(a.map((c) => [String(c.candidateId), c.votes]));
  const mb = new Map(b.map((c) => [String(c.candidateId), c.votes]));
  const out = [];
  for (const id of new Set([...ma.keys(), ...mb.keys()])) {
    const va = ma.get(id) ?? null;
    const vb = mb.get(id) ?? null;
    if (va !== vb) out.push({ candidateId: id, a: va, b: vb });
  }
  return out;
}
