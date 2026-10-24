/**
 * Load test (non-production only). Seeds a synthetic "LOADTEST" election with many stations and
 * agents, then measures:
 *   1. concurrent agent submissions (with deliberate duplicate retries) through the real API;
 *   2. concurrent public viewers reading the live tally.
 * Afterwards it checks that totals equal the sum of accepted results (no duplicates counted).
 *
 *   API_URL=http://localhost:4000 STATIONS=3000 AGENTS=300 VIEWERS=200 npm run load:test -w server
 */
import crypto from 'node:crypto';
import autocannon from 'autocannon';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { AgentAssignment, Candidate, Constituency, County, Election, PollingStation, Session, StationResult, User, Ward } from '../models/index.js';
import { seedReference } from './seedReference.js';

if (env.NODE_ENV === 'production') throw new Error('Refusing to run load test in production');
const API = process.env.API_URL ?? 'http://localhost:4000';
const STATIONS = Number(process.env.STATIONS ?? 3000);
const AGENTS = Math.min(STATIONS, Number(process.env.AGENTS ?? 300));
const VIEWERS = Number(process.env.VIEWERS ?? 200);
const DURATION = Number(process.env.DURATION ?? 20);

await connectMongo();
await seedReference();
const county = (await County.findOne({ code: '007' }))!;
const slug = `loadtest-${Date.now()}`;
const election = await Election.create({
  name: 'LOADTEST synthetic election (not real)',
  slug,
  type: 'BY_ELECTION',
  electionDate: new Date(),
  status: 'ACTIVE',
  publishProvisional: true,
  positions: [{ position: 'GOVERNOR', enabled: true, requiredFields: [], rules: ['CANDIDATE_SUM_EQUALS_VALID'], requireEvidence: false }]
});
const cons = await Constituency.create({ electionId: election._id, countyId: county._id, code: 'LT-C', name: 'LOADTEST constituency' });
const ward = await Ward.create({ electionId: election._id, countyId: county._id, constituencyId: cons._id, code: 'LT-W', name: 'LOADTEST ward' });
console.log(`Seeding ${STATIONS} stations…`);
const stations = await PollingStation.insertMany(
  Array.from({ length: STATIONS }, (_, i) => ({ electionId: election._id, countyId: county._id, constituencyId: cons._id, wardId: ward._id, code: `LT-${i}`, name: `LOADTEST station ${i}`, registeredVoters: 700 }))
);
const cands = await Candidate.insertMany(['A', 'B', 'C', 'D'].map((x, i) => ({ electionId: election._id, position: 'GOVERNOR', fullName: `LOADTEST Candidate ${x}`, scopeType: 'COUNTY', scopeRefId: county._id, ballotOrder: i })));

// Agents get sessions minted directly (argon2 login for hundreds of agents is not what is under test).
const users = await User.insertMany(Array.from({ length: AGENTS }, (_, i) => ({ fullName: `LOADTEST agent ${i}`, email: `lt-${slug}-${i}@example.invalid`, passwordHash: 'x', role: 'AGENT', vetting: { status: 'APPROVED' }, agentCode: `AGT-LT${slug.slice(-6)}${i}` })));
await AgentAssignment.insertMany(users.map((u, i) => ({ userId: u._id, electionId: election._id, pollingStationId: stations[i]!._id, countyId: county._id, constituencyId: cons._id, wardId: ward._id })));
const tokens = await Promise.all(
  users.map(async (u) => {
    const familyId = crypto.randomUUID();
    await Session.create({ userId: u._id, familyId, currentTokenHash: crypto.randomBytes(16).toString('hex'), expiresAt: new Date(Date.now() + 3600_000), stepUpUntil: new Date(Date.now() + 3600_000) });
    return jwt.sign({ sub: String(u._id), sid: familyId, mfa: false, typ: 'access' }, env.JWT_ACCESS_SECRET, { expiresIn: 3600, issuer: 'northern-iebc' });
  })
);

console.log(`Submitting ${AGENTS} results concurrently (each sent twice to test idempotency)…`);
const expected: Record<string, number> = {};
const t0 = Date.now();
const lat: number[] = [];
let ok = 0;
let failed = 0;
await Promise.all(
  users.map(async (_u, i) => {
    const votes = cands.map(() => Math.floor(Math.random() * 200));
    const body = JSON.stringify({ idempotencyKey: crypto.randomUUID(), electionId: String(election._id), pollingStationId: String(stations[i]!._id), position: 'GOVERNOR', candidateVotes: cands.map((c, j) => ({ candidateId: String(c._id), votes: votes[j] })), fields: { validVotes: votes.reduce((a, b) => a + b, 0) }, declarationAccepted: true, baseRevision: null });
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = Date.now();
      const r = await fetch(`${API}/api/agent/submissions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[i]}` }, body });
      lat.push(Date.now() - s);
      if (r.status === 201 || r.status === 200) ok++;
      else failed++;
    }
    cands.forEach((c, j) => (expected[String(c._id)] = (expected[String(c._id)] ?? 0) + votes[j]!));
  })
);
lat.sort((a, b) => a - b);
const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))];
console.log(`  ${ok} accepted, ${failed} failed in ${Date.now() - t0} ms; latency p50=${pct(50)}ms p95=${pct(95)}ms p99=${pct(99)}ms`);

console.log(`Public tally: ${VIEWERS} concurrent viewers for ${DURATION}s…`);
const ac = await autocannon({ url: `${API}/api/public/results/tally?electionId=${election._id}&position=GOVERNOR`, connections: VIEWERS, duration: DURATION });
console.log(`  ${ac.requests.average.toFixed(0)} req/s avg, latency p50=${ac.latency.p50}ms p99=${ac.latency.p99}ms, non-2xx=${ac.non2xx}, errors=${ac.errors}, timeouts=${ac.timeouts}`);

const final = await (await fetch(`${API}/api/public/results/tally?electionId=${election._id}&position=GOVERNOR`)).json() as { candidates: { candidateId: string; votes: number }[]; coverage: { reported: number } };
const srCount = await StationResult.countDocuments({ electionId: election._id });
const mismatches = final.candidates.filter((c) => c.votes !== expected[c.candidateId]);
console.log(`Integrity: ${srCount} station results for ${AGENTS} agents; coverage.reported=${final.coverage.reported}; candidate totals ${mismatches.length === 0 ? 'MATCH' : 'MISMATCH'} expected sums.`);
const pass = srCount === AGENTS && mismatches.length === 0 && failed === 0 && ac.non2xx === 0;
console.log(pass ? 'LOAD TEST PASSED' : 'LOAD TEST FAILED');
await disconnectMongo();
process.exit(pass ? 0 : 1);
