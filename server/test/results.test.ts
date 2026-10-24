import crypto from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, assign, seedElection, setupDb, teardownDb } from './helpers.js';
import { ResultSubmission, StationResult, SubmissionRevision } from '../src/models/index.js';
import { sealAuditChain, verifyAuditChain } from '../src/lib/audit.js';
import { processOutboxBatch } from '../src/jobs/outboxWorker.js';
import { clearCache } from '../src/lib/cache.js';

let app: Express;
let fx: Awaited<ReturnType<typeof seedElection>>;

beforeAll(async () => {
  app = await setupDb();
  fx = await seedElection();
});
afterAll(teardownDb);

const key = () => crypto.randomUUID();

function govPayload(stationId: string, votes: [number, number], extra: Record<string, unknown> = {}) {
  return {
    idempotencyKey: key(),
    electionId: String(fx.election._id),
    pollingStationId: stationId,
    position: 'GOVERNOR',
    candidateVotes: [
      { candidateId: String(fx.govs[0]!._id), votes: votes[0] },
      { candidateId: String(fx.govs[1]!._id), votes: votes[1] }
    ],
    fields: { validVotes: votes[0] + votes[1] },
    declarationAccepted: true,
    baseRevision: null,
    ...extra
  };
}

describe('agent access', () => {
  it('agents only see their assigned stations and eligible candidates', async () => {
    const agent = await as(app, 'AGENT');
    await assign(agent.id, fx.election._id, fx.stations[0]!);
    const r = await request(app).get('/api/agent/assignments').set(agent.auth);
    expect(r.status).toBe(200);
    expect(r.body.assignments).toHaveLength(1);
    expect(r.body.assignments[0].station.code).toBe('PS1');
    const gov = r.body.assignments[0].ballots.find((b: { position: string }) => b.position === 'GOVERNOR');
    // Candidate from another county must not appear.
    expect(gov.candidates.map((c: { fullName: string }) => c.fullName).sort()).toEqual(['Gov A', 'Gov B']);
  });

  it('rejects submissions for unassigned stations (server-side)', async () => {
    const agent = await as(app, 'AGENT');
    await assign(agent.id, fx.election._id, fx.stations[0]!);
    const r = await request(app).post('/api/agent/submissions').set(agent.auth).send(govPayload(String(fx.stations[1]!._id), [10, 5]));
    expect(r.status).toBe(403);
  });

  it('rejects candidates not on the ballot for the station', async () => {
    const agent = await as(app, 'AGENT');
    await assign(agent.id, fx.election._id, fx.stations[0]!);
    const p = govPayload(String(fx.stations[0]!._id), [10, 5]);
    p.candidateVotes[1] = { candidateId: String(fx.govs[2]!._id), votes: 5 };
    const r = await request(app).post('/api/agent/submissions').set(agent.auth).send(p);
    expect(r.status).toBe(400);
  });

  it('non-agents cannot submit results', async () => {
    const admin = await as(app, 'SUPER_ADMIN');
    const r = await request(app).post('/api/agent/submissions').set(admin.auth).send(govPayload(String(fx.stations[0]!._id), [1, 1]));
    expect(r.status).toBe(403);
  });
});

describe('submission, idempotency and revisions', () => {
  it('issues a receipt only after the server stores the submission, and replays are idempotent', async () => {
    const agent = await as(app, 'AGENT');
    const st = fx.stations[1]!;
    await assign(agent.id, fx.election._id, st);
    const p = govPayload(String(st._id), [120, 95]);
    const r1 = await request(app).post('/api/agent/submissions').set(agent.auth).send(p);
    expect(r1.status).toBe(201);
    expect(r1.body.receipt.receiptId).toMatch(/^RCPT-/);
    expect(r1.body.receipt.revision).toBe(1);
    const stored = await SubmissionRevision.findOne({ receiptId: r1.body.receipt.receiptId });
    expect(stored).not.toBeNull();

    // Same idempotency key retried (e.g. network retry): no duplicate.
    const [r2, r3] = await Promise.all([
      request(app).post('/api/agent/submissions').set(agent.auth).send(p),
      request(app).post('/api/agent/submissions').set(agent.auth).send(p)
    ]);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    expect(r2.body.receipt.receiptId).toBe(r1.body.receipt.receiptId);
    expect(await SubmissionRevision.countDocuments({ submissionId: r1.body.receipt.submissionId })).toBe(1);

    // Same key, different payload: refused.
    const tampered = { ...p, candidateVotes: [{ ...p.candidateVotes[0]!, votes: 999 }, p.candidateVotes[1]] };
    const r4 = await request(app).post('/api/agent/submissions').set(agent.auth).send(tampered);
    expect(r4.status).toBe(409);
  });

  it('prevents silent overwrite: a new submission without baseRevision conflicts; corrections create revisions', async () => {
    const agent = await as(app, 'AGENT');
    const st = fx.stations[2]!;
    await assign(agent.id, fx.election._id, st);
    const r1 = await request(app).post('/api/agent/submissions').set(agent.auth).send(govPayload(String(st._id), [50, 40]));
    expect(r1.status).toBe(201);
    const r2 = await request(app).post('/api/agent/submissions').set(agent.auth).send(govPayload(String(st._id), [51, 40]));
    expect(r2.status).toBe(409);
    expect(r2.body.error.details.serverRevision).toBe(1);
    const r3 = await request(app).post('/api/agent/submissions').set(agent.auth).send(govPayload(String(st._id), [51, 40], { baseRevision: 1 }));
    expect(r3.status).toBe(400); // correction reason required
    const r4 = await request(app).post('/api/agent/submissions').set(agent.auth).send(govPayload(String(st._id), [51, 40], { baseRevision: 1, correctionReason: 'Misread tally for Gov A' }));
    expect(r4.status).toBe(201);
    expect(r4.body.receipt.revision).toBe(2);
    const revs = await SubmissionRevision.find({ submissionId: r1.body.receipt.submissionId }).sort({ revision: 1 }).lean();
    expect(revs.map((r) => r.candidateVotes[0]!.votes)).toEqual([50, 51]);
    expect(revs[1]!.prevRevisionHash).toBe(revs[0]!.payloadHash);
    // Station result tracks the latest revision, and is never double-counted.
    const sr = await StationResult.find({ pollingStationId: st._id, position: 'GOVERNOR' }).lean();
    expect(sr).toHaveLength(1);
    expect(sr[0]!.candidateVotes[0]!.votes).toBe(51);
  });

  it('flags reconciliation issues without adjusting figures', async () => {
    const agent = await as(app, 'AGENT');
    const { stations } = await seedElection();
    const st = stations[0]!;
    const fx2 = await (await import('../src/models/index.js')).Election.findById(st.electionId);
    await assign(agent.id, fx2!._id, st);
    const govs = await (await import('../src/models/index.js')).Candidate.find({ electionId: st.electionId, position: 'GOVERNOR', scopeRefId: st.countyId }).sort({ ballotOrder: 1 });
    const r = await request(app)
      .post('/api/agent/submissions')
      .set(agent.auth)
      .send({ idempotencyKey: key(), electionId: String(st.electionId), pollingStationId: String(st._id), position: 'GOVERNOR', candidateVotes: govs.map((g, i) => ({ candidateId: String(g._id), votes: i === 0 ? 400 : 200 })), fields: { validVotes: 590 }, declarationAccepted: true, baseRevision: null });
    expect(r.status).toBe(201);
    const rules = r.body.receipt.reconciliationIssues.map((i: { rule: string }) => i.rule);
    expect(rules).toContain('CANDIDATE_SUM_EQUALS_VALID');
    expect(rules).toContain('CAST_NOT_EXCEEDING_REGISTERED');
    const rev = await SubmissionRevision.findOne({ receiptId: r.body.receipt.receiptId });
    expect(rev!.candidateVotes.map((c) => c.votes)).toEqual([400, 200]);
    expect(rev!.fields!.validVotes).toBe(590);
    const sr = await StationResult.findOne({ pollingStationId: st._id });
    expect(sr!.status).toBe('AWAITING_VERIFICATION');
  });
});

describe('conflicts, verification and second review', () => {
  it('conflicting submissions trigger review; verification resolves; critical corrections need a second reviewer', async () => {
    const { election, stations, govs } = await seedElection();
    const st = stations[0]!;
    const a1 = await as(app, 'AGENT');
    const a2 = await as(app, 'AGENT');
    await assign(a1.id, election._id, st);
    await assign(a2.id, election._id, st);
    const mk = (v: [number, number]) => ({ idempotencyKey: key(), electionId: String(election._id), pollingStationId: String(st._id), position: 'GOVERNOR', candidateVotes: [{ candidateId: String(govs[0]!._id), votes: v[0] }, { candidateId: String(govs[1]!._id), votes: v[1] }], fields: { validVotes: v[0] + v[1] }, declarationAccepted: true, baseRevision: null });
    const s1 = await request(app).post('/api/agent/submissions').set(a1.auth).send(mk([100, 80]));
    const s2 = await request(app).post('/api/agent/submissions').set(a2.auth).send(mk([100, 90]));
    expect(s1.status).toBe(201);
    expect(s2.status).toBe(201);
    let sr = await StationResult.findOne({ pollingStationId: st._id, position: 'GOVERNOR' });
    expect(sr!.hasConflict).toBe(true);
    expect(sr!.status).toBe('AWAITING_VERIFICATION');

    const v1 = await as(app, 'VERIFICATION_OFFICER');
    const detail = await request(app).get(`/api/verification/submissions/${s1.body.receipt.submissionId}`).set(v1.auth);
    expect(detail.status).toBe(200);
    expect(detail.body.comparisons[0].differences).toHaveLength(1);

    const d1 = await request(app).post(`/api/verification/submissions/${s2.body.receipt.submissionId}/decision`).set(v1.auth).send({ revision: 1, decision: 'VERIFY', note: 'Matches photographed form' });
    expect(d1.status).toBe(200);
    sr = await StationResult.findOne({ pollingStationId: st._id, position: 'GOVERNOR' });
    expect(sr!.status).toBe('VERIFIED');
    expect(sr!.candidateVotes[1]!.votes).toBe(90);

    // Verifying the other, different submission would replace a verified result → second reviewer required.
    const d2 = await request(app).post(`/api/verification/submissions/${s1.body.receipt.submissionId}/decision`).set(v1.auth).send({ revision: 1, decision: 'VERIFY', note: 'Second look suggests 80' });
    expect(d2.status).toBe(202);
    sr = await StationResult.findOne({ pollingStationId: st._id, position: 'GOVERNOR' });
    expect(sr!.candidateVotes[1]!.votes).toBe(90);

    const self = await request(app).post(`/api/approvals/${d2.body.approvalId}/approve`).set(v1.auth).send({ note: 'self approve attempt' });
    expect(self.status).toBe(403);
    const v2 = await as(app, 'VERIFICATION_OFFICER');
    const ap = await request(app).post(`/api/approvals/${d2.body.approvalId}/approve`).set(v2.auth).send({ note: 'Confirmed against original form' });
    expect(ap.status).toBe(200);
    sr = await StationResult.findOne({ pollingStationId: st._id, position: 'GOVERNOR' });
    expect(sr!.candidateVotes[1]!.votes).toBe(80);
    expect(sr!.status).toBe('VERIFIED');
  });

  it('verification officers scoped to another county cannot review', async () => {
    const { election, stations, govs } = await seedElection();
    const a = await as(app, 'AGENT');
    await assign(a.id, election._id, stations[0]!);
    const s = await request(app).post('/api/agent/submissions').set(a.auth).send({ idempotencyKey: key(), electionId: String(election._id), pollingStationId: String(stations[0]!._id), position: 'GOVERNOR', candidateVotes: govs.slice(0, 2).map((g) => ({ candidateId: String(g._id), votes: 1 })), fields: { validVotes: 2 }, declarationAccepted: true, baseRevision: null });
    const v = await as(app, 'VERIFICATION_OFFICER', { scope: { countyIds: [String(fx.other._id)] } });
    const r = await request(app).post(`/api/verification/submissions/${s.body.receipt.submissionId}/decision`).set(v.auth).send({ revision: 1, decision: 'VERIFY', note: 'out of scope' });
    expect(r.status).toBe(403);
  });
});

describe('tallies and public portal', () => {
  it('computes totals, shares and coverage from accepted results only', async () => {
    const { election, stations, govs, county } = await seedElection({ stations: 4 });
    const agents = await Promise.all(stations.slice(0, 3).map(() => as(app, 'AGENT')));
    const votes: [number, number][] = [[100, 50], [60, 40], [0, 0]];
    for (let i = 0; i < 3; i++) {
      await assign(agents[i]!.id, election._id, stations[i]!);
      const r = await request(app).post('/api/agent/submissions').set(agents[i]!.auth).send({ idempotencyKey: key(), electionId: String(election._id), pollingStationId: String(stations[i]!._id), position: 'GOVERNOR', candidateVotes: govs.slice(0, 2).map((g, j) => ({ candidateId: String(g._id), votes: votes[i]![j] })), fields: { validVotes: votes[i]![0] + votes[i]![1] }, declarationAccepted: true, baseRevision: null });
      expect(r.status).toBe(201);
    }
    // A correction must not inflate totals.
    const subs = await ResultSubmission.find({ electionId: election._id, pollingStationId: stations[0]!._id });
    const corr = await request(app).post('/api/agent/submissions').set(agents[0]!.auth).send({ idempotencyKey: key(), electionId: String(election._id), pollingStationId: String(stations[0]!._id), position: 'GOVERNOR', candidateVotes: govs.slice(0, 2).map((g, j) => ({ candidateId: String(g._id), votes: [110, 50][j] })), fields: { validVotes: 160 }, declarationAccepted: true, baseRevision: subs[0]!.currentRevision, correctionReason: 'Corrected transcription' });
    expect(corr.status).toBe(201);
    clearCache();
    const t = await request(app).get('/api/public/results/tally').query({ electionId: String(election._id), position: 'GOVERNOR', countyId: String(county._id) });
    expect(t.status).toBe(200);
    const byName = Object.fromEntries(t.body.candidates.map((c: { fullName: string; votes: number; share: number }) => [c.fullName, c]));
    expect(byName['Gov A'].votes).toBe(170);
    expect(byName['Gov B'].votes).toBe(90);
    expect(byName['Gov A'].share).toBeCloseTo((170 / 260) * 100, 2);
    expect(t.body.coverage).toMatchObject({ reported: 3, registered: 4, outstanding: 1, percent: 75 });
    expect(t.body.winnerDeclared).toBe(false);
    expect(t.body.candidates.find((c: { fullName: string }) => c.fullName === 'Gov Other County')).toBeUndefined();
  });

  it('zero votes yields null shares (no division by zero)', async () => {
    const { election, county } = await seedElection();
    const t = await request(app).get('/api/public/results/tally').query({ electionId: String(election._id), position: 'GOVERNOR', countyId: String(county._id) });
    expect(t.status).toBe(200);
    expect(t.body.overallStatus).toBe('NO_RESULTS');
    expect(t.body.candidates.every((c: { share: number | null }) => c.share === null)).toBe(true);
    expect(t.body.coverage.percent).toBe(0);
  });

  it('publication controls: provisional results hidden when publishProvisional=false; private data not exposed', async () => {
    const { election, stations, govs, county } = await seedElection({ publishProvisional: false });
    const a = await as(app, 'AGENT');
    await assign(a.id, election._id, stations[0]!);
    await request(app).post('/api/agent/submissions').set(a.auth).send({ idempotencyKey: key(), electionId: String(election._id), pollingStationId: String(stations[0]!._id), position: 'GOVERNOR', candidateVotes: govs.slice(0, 2).map((g) => ({ candidateId: String(g._id), votes: 10 })), fields: { validVotes: 20 }, declarationAccepted: true, baseRevision: null });
    clearCache();
    const t = await request(app).get('/api/public/results/tally').query({ electionId: String(election._id), position: 'GOVERNOR', countyId: String(county._id) });
    expect(t.body.totals.totalRecordedVotes).toBe(0);
    expect(t.body.awaitingVerificationStations).toBe(1);
    const st = await request(app).get(`/api/public/results/stations/${String(stations[0]!._id)}`);
    expect(st.status).toBe(200);
    const json = JSON.stringify(st.body);
    expect(st.body.results.find((r: { position: string }) => r.position === 'GOVERNOR').status).toBe('AWAITING_VERIFICATION');
    expect(json).not.toContain('agentId');
    expect(json).not.toContain(a.id);
    // Public users cannot reach monitoring APIs.
    expect((await request(app).get('/api/verification/submissions').query({ electionId: String(election._id) })).status).toBe(401);
  });

  it('admin dashboard counts and outbox delivery', async () => {
    const admin = await as(app, 'SUPER_ADMIN');
    const r = await request(app).get('/api/verification/dashboard').set(admin.auth).query({ electionId: String(fx.election._id) });
    expect(r.status).toBe(200);
    expect(r.body.registeredStations).toBe(4);
    expect(r.body.stationsReported).toBeGreaterThanOrEqual(2);
    expect(r.body.coverage.registered).toBe(4);
    const processed = await processOutboxBatch(500);
    expect(processed).toBeGreaterThan(0);
  });

  it('county admin dashboards are limited to their scope', async () => {
    const ca = await as(app, 'COUNTY_ADMIN', { scope: { countyIds: [String(fx.other._id)] } });
    const r = await request(app).get('/api/verification/dashboard').set(ca.auth).query({ electionId: String(fx.election._id) });
    expect(r.status).toBe(200);
    expect(r.body.registeredStations).toBe(1);
    expect(r.body.stationsReported).toBe(0);
  });
});

describe('audit trail', () => {
  it('records a valid hash chain', async () => {
    await sealAuditChain(10_000);
    const v = await verifyAuditChain();
    expect(v).toMatchObject({ ok: true, unsealed: 0 });
    expect(v.checked).toBeGreaterThan(5);
  });
});
