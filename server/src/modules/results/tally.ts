import { percent } from '../../lib/money.js';

export interface CandidateTotal {
  candidateId: string;
  votes: number;
  verifiedVotes: number;
}

export interface TallyRow extends CandidateTotal {
  share: number | null;
  rank: number;
}

/**
 * Vote share = candidate votes / total valid candidate votes for the same position and scope × 100.
 * Ranks are dense on equal votes. Returns null shares when there are no votes (no division by zero).
 */
export function computeShares(totals: CandidateTotal[]): { rows: TallyRow[]; totalVotes: number; verifiedVotes: number } {
  const totalVotes = totals.reduce((a, t) => a + t.votes, 0);
  const verifiedVotes = totals.reduce((a, t) => a + t.verifiedVotes, 0);
  const sorted = [...totals].sort((a, b) => b.votes - a.votes || a.candidateId.localeCompare(b.candidateId));
  let rank = 0;
  let prev: number | null = null;
  const rows = sorted.map((t, i) => {
    if (t.votes !== prev) rank = i + 1;
    prev = t.votes;
    return { ...t, share: percent(t.votes, totalVotes), rank };
  });
  return { rows, totalVotes, verifiedVotes };
}

export function coverage(reported: number, registered: number) {
  return { reported, registered, outstanding: Math.max(0, registered - reported), percent: percent(reported, registered) };
}
