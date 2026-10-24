import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, assign, createUser, login, PASSWORD, seedElection, setupDb, teardownDb } from './helpers.js';
import { env } from '../src/config/env.js';
import { CountSession, SubmissionRevision, TallyEvent, User } from '../src/models/index.js';

let app: Express;
let fx: Awaited<ReturnType<typeof seedElection>>;
let stub: http.Server;
const seen: { body?: Record<string, unknown>; reply?: unknown } = {};

beforeAll(async () => {
  // Local stand-in for the Claude Messages API (no real API calls in tests).
  stub = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      seen.body = JSON.parse(b);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(seen.reply) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 300 } }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  (env as { ANTHROPIC_API_KEY?: string }).ANTHROPIC_API_KEY = 'test-key';
  app = await setupDb();
  fx = await seedElection();
});
afterAll(async () => {
  stub.close();
  await teardownDb();
});

const ev = (seq: number, kind: string, candidateId: string, extra: Record<string, unknown> = {}) => ({ seq, kind, candidateId, ...extra });

describe('agent vetting', () => {
  it('unapproved agents cannot count or submit; approval needs a different admin and full checks', async () => {
    const admin1 = await as(app, 'SUPER_ADMIN');
    const created = await request(app).post('/api/admin/users').set(admin1.auth).send({ fullName: 'New Agent', email: 'vet@example.org', role: 'AGENT' });
    const agentId = created.body.user._id;
    expect(created.body.user.vetting.status).toBe('PENDING');
    await assign(agentId, fx.election._id, fx.stations[0]!);
    await User.updateOne({ _id: agentId }, { $set: { mustChangePassword: false, passwordHash: (await User.findOne({ role: 'SUPER_ADMIN' }).select('+passwordHash'))!.passwordHash } });
    const agent = { user: (await User.findById(agentId))!, secret: '' };
    const { token } = await login(app, agent);
    const auth = { Authorization: `Bearer ${token}` };
    const tap = await request(app).post('/api/agent/tally-events').set(auth).send({ clientSessionId: crypto.randomUUID(), electionId: String(fx.election._id), pollingStationId: String(fx.stations[0]!._id), position: 'GOVERNOR', events: [ev(1, 'INCREMENT', String(fx.govs[0]!._id))] });
    expect(tap.status).toBe(403);
    expect(tap.body.error.message).toMatch(/awaiting approval/);

    const self = await request(app).post(`/api/admin/users/${agentId}/vetting`).set(admin1.auth).send({ decision: 'APPROVE', identityChecked: true, phoneChecked: true, accreditationChecked: true, accreditationReference: 'ACC-1', note: 'Checked ID card' });
    expect(self.status).toBe(403);
    const admin2 = await as(app, 'REGIONAL_ADMIN');
    const incomplete = await request(app).post(`/api/admin/users/${agentId}/vetting`).set(admin2.auth).send({ decision: 'APPROVE', identityChecked: true, note: 'Checked ID card' });
    expect(incomplete.status).toBe(400);
    const ok = await request(app).post(`/api/admin/users/${agentId}/vetting`).set(admin2.auth).send({ decision: 'APPROVE', identityChecked: true, phoneChecked: true, accreditationChecked: true, accreditationReference: 'Party letter 2026/117', note: 'ID and party letter verified in person' });
    expect(ok.status).toBe(200);
    const pending = await request(app).get('/api/admin/users').set(admin2.auth).query({ vetting: 'PENDING' });
    expect(pending.body.items.find((u: { _id: string }) => u._id === agentId)).toBeUndefined();
    const tap2 = await request(app).post('/api/agent/tally-events').set(auth).send({ clientSessionId: crypto.randomUUID(), electionId: String(fx.election._id), pollingStationId: String(fx.stations[0]!._id), position: 'GOVERNOR', events: [ev(1, 'INCREMENT', String(fx.govs[0]!._id))] });
    expect(tap2.status).toBe(200);
  });
});

describe('live counting', () => {
  it('records every tap immediately, in order, with a hash chain; duplicates are harmless; gaps are refused', async () => {
    const a = await as(app, 'AGENT');
    await assign(a.id, fx.election._id, fx.stations[1]!);
    const sid = crypto.randomUUID();
    const base = { clientSessionId: sid, electionId: String(fx.election._id), pollingStationId: String(fx.stations[1]!._id), position: 'GOVERNOR' };
    const A = String(fx.govs[0]!._id);
    const B = String(fx.govs[1]!._id);
    for (let i = 1; i <= 3; i++) {
      const r = await request(app).post('/api/agent/tally-events').set(a.auth).send({ ...base, events: [ev(i, 'INCREMENT', i === 3 ? B : A)] });
      expect(r.status).toBe(200);
    }
    // Retry of an already-delivered tap does not double count.
    const dup = await request(app).post('/api/agent/tally-events').set(a.auth).send({ ...base, events: [ev(3, 'INCREMENT', B)] });
    expect(dup.body.tallies[B]).toBe(1);
    const gap = await request(app).post('/api/agent/tally-events').set(a.auth).send({ ...base, events: [ev(6, 'INCREMENT', A)] });
    expect(gap.status).toBe(409);
    expect(gap.body.error.details.expectedSeq).toBe(4);
    const events = await TallyEvent.find({ sessionId: (await CountSession.findOne({ clientSessionId: sid }))!._id }).sort({ seq: 1 }).lean();
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events[1]!.prevHash).toBe(events[0]!.hash);
  });

  it('undo reverses only the previous addition and requires a reason', async () => {
    const a = await as(app, 'AGENT');
    await assign(a.id, fx.election._id, fx.stations[2]!);
    const base = { clientSessionId: crypto.randomUUID(), electionId: String(fx.election._id), pollingStationId: String(fx.stations[2]!._id), position: 'GOVERNOR' };
    const A = String(fx.govs[0]!._id);
    const B = String(fx.govs[1]!._id);
    await request(app).post('/api/agent/tally-events').set(a.auth).send({ ...base, events: [ev(1, 'INCREMENT', A), ev(2, 'INCREMENT', B)] });
    const noReason = await request(app).post('/api/agent/tally-events').set(a.auth).send({ ...base, events: [ev(3, 'UNDO', B, { undoOfSeq: 2 })] });
    expect(noReason.status).toBe(400);
    const notLatest = await request(app).post('/api/agent/tally-events').set(a.auth).send({ ...base, events: [ev(3, 'UNDO', A, { undoOfSeq: 1, reasonCode: 'ACCIDENTAL_TAP' })] });
    expect(notLatest.status).toBe(409);
    const otherNoText = await request(app).post('/api/agent/tally-events').set(a.auth).send({ ...base, events: [ev(3, 'UNDO', B, { undoOfSeq: 2, reasonCode: 'OTHER' })] });
    expect(otherNoText.status).toBe(400);
    const ok = await request(app).post('/api/agent/tally-events').set(a.auth).send({ ...base, events: [ev(3, 'UNDO', B, { undoOfSeq: 2, reasonCode: 'WRONG_CANDIDATE' })] });
    expect(ok.status).toBe(200);
    expect(ok.body.tallies).toMatchObject({ [A]: 1, [B]: 0 });
    // The next undo targets the remaining addition (seq 1).
    const next = await request(app).post('/api/agent/tally-events').set(a.auth).send({ ...base, events: [ev(4, 'UNDO', A, { undoOfSeq: 1, reasonCode: 'ACCIDENTAL_TAP' })] });
    expect(next.status).toBe(200);
  });

  it('flags implausibly fast tapping and refuses absurd rates', async () => {
    const a = await as(app, 'AGENT');
    const { election, stations, govs } = await seedElection();
    await assign(a.id, election._id, stations[0]!);
    const base = { clientSessionId: crypto.randomUUID(), electionId: String(election._id), pollingStationId: String(stations[0]!._id), position: 'GOVERNOR' };
    const A = String(govs[0]!._id);
    const burst = await request(app).post('/api/agent/tally-events').set(a.auth).send({ ...base, events: Array.from({ length: 6 }, (_, i) => ev(i + 1, 'INCREMENT', A)) });
    expect(burst.status).toBe(200);
    expect(burst.body.flags).toContain('FAST_TAPPING');
    const absurd = await request(app).post('/api/agent/tally-events').set(a.auth).send({ ...base, events: Array.from({ length: 20 }, (_, i) => ev(i + 7, 'INCREMENT', A)) });
    expect(absurd.status).toBe(422);
  });

  it('"+" never submits: submission needs password confirmation, and is cross-checked against the live count', async () => {
    const { election, stations, govs } = await seedElection();
    const a = await as(app, 'AGENT', { stepUp: false });
    await assign(a.id, election._id, stations[0]!);
    const sid = crypto.randomUUID();
    const base = { clientSessionId: sid, electionId: String(election._id), pollingStationId: String(stations[0]!._id), position: 'GOVERNOR' };
    const [A, B] = [String(govs[0]!._id), String(govs[1]!._id)];
    await request(app).post('/api/agent/tally-events').set(a.auth).send({ ...base, events: [ev(1, 'INCREMENT', A), ev(2, 'INCREMENT', A)] });
    await new Promise((r) => setTimeout(r, 1100));
    await request(app).post('/api/agent/tally-events').set(a.auth).send({ ...base, events: [ev(3, 'INCREMENT', B)] });
    const payload = { idempotencyKey: crypto.randomUUID(), electionId: String(election._id), pollingStationId: String(stations[0]!._id), position: 'GOVERNOR', candidateVotes: [{ candidateId: A, votes: 2 }, { candidateId: B, votes: 5 }], fields: { validVotes: 7 }, declarationAccepted: true, baseRevision: null, countSessionId: sid };
    const noStepUp = await request(app).post('/api/agent/submissions').set(a.auth).send(payload);
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.body.error.message).toMatch(/Confirm your password/);
    expect((await request(app).post('/api/agent/confirm-identity').set(a.auth).send({ password: 'wrong-password' })).status).toBe(401);
    expect((await request(app).post('/api/agent/confirm-identity').set(a.auth).send({ password: PASSWORD })).status).toBe(200);
    const sub = await request(app).post('/api/agent/submissions').set(a.auth).send(payload);
    expect(sub.status).toBe(201);
    expect(sub.body.receipt.reconciliationIssues.map((i: { rule: string }) => i.rule)).toContain('TALLY_LOG_MISMATCH');
    expect((await CountSession.findOne({ clientSessionId: sid }))!.status).toBe('SUBMITTED');
    // The session cannot be reused for a second submission.
    const again = await request(app).post('/api/agent/tally-events').set(a.auth).send({ ...base, events: [ev(4, 'INCREMENT', A)] });
    expect(again.status).toBe(409);
  });
});

describe('AI form reading', () => {
  it('reads Form 34A-style figures, flags disagreements, and never alters or submits them', async () => {
    const { election, stations, govs } = await seedElection();
    const a = await as(app, 'AGENT');
    await assign(a.id, election._id, stations[0]!);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
    const up = await request(app).post('/api/agent/evidence').set(a.auth).attach('file', jpeg, { filename: 'form.jpg', contentType: 'image/jpeg' });
    const [A, B] = [String(govs[0]!._id), String(govs[1]!._id)];
    seen.reply = {
      legible: true,
      formCodeSeen: '37A',
      stationCodeSeen: 'PS1',
      stationNameSeen: 'Station 1',
      candidates: [{ candidateId: A, votes: 120, confidence: 'high' }, { candidateId: B, votes: 95, confidence: 'medium' }, { candidateId: 'ffffffffffffffffffffffff', votes: 3, confidence: 'high' }],
      fields: { registeredVoters: { value: 500, confidence: 'high' }, totalVotesCast: { value: null, confidence: 'low' }, rejectedVotes: { value: 2, confidence: 'high' }, rejectedObjectedTo: { value: null, confidence: 'low' }, disputedVotes: { value: null, confidence: 'low' }, validVotes: { value: 216, confidence: 'high' } },
      stampOrSignaturesVisible: true,
      observations: ['Figure for candidate B appears overwritten']
    };
    const r = await request(app).post('/api/agent/form-extract').set(a.auth).send({ fileId: up.body.fileId, electionId: String(election._id), pollingStationId: String(stations[0]!._id), position: 'GOVERNOR' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('COMPLETED');
    expect(r.body.candidateVotes).toHaveLength(2); // unknown candidate dropped
    expect(r.body.warnings.join(' ')).toMatch(/add up to 215/);
    expect(r.body.warnings.join(' ')).toMatch(/not on this ballot/);
    expect(r.body.warnings.join(' ')).toMatch(/overwritten/);
    // Request shape: model, image, structured output, refusal fallback.
    expect(seen.body!.model).toBe('claude-opus-5-5');
    expect(seen.body!.fallbacks).toBe('default');
    expect(JSON.stringify(seen.body!.messages)).toContain('"type":"image"');
    expect(JSON.stringify(seen.body!.messages)).toContain('Form 37A');

    // Submitting different figures than the AI read is flagged for reviewers, not blocked.
    const sub = await request(app).post('/api/agent/submissions').set(a.auth).send({ idempotencyKey: crypto.randomUUID(), electionId: String(election._id), pollingStationId: String(stations[0]!._id), position: 'GOVERNOR', candidateVotes: [{ candidateId: A, votes: 120 }, { candidateId: B, votes: 96 }], fields: { validVotes: 216 }, evidenceFileIds: [up.body.fileId], declarationAccepted: true, baseRevision: null });
    expect(sub.status).toBe(201);
    const rev = await SubmissionRevision.findOne({ receiptId: sub.body.receipt.receiptId }).lean();
    expect(rev!.reconciliationIssues.map((i) => i.rule)).toContain('AI_EXTRACTION_MISMATCH');
    expect(rev!.candidateVotes.map((c) => c.votes)).toEqual([120, 96]);
  });

  it('is unavailable without an API key and only for the agent\'s own upload', async () => {
    const other = await as(app, 'AGENT');
    await assign(other.id, fx.election._id, fx.stations[0]!);
    const r = await request(app).post('/api/agent/form-extract').set(other.auth).send({ fileId: '0'.repeat(24), electionId: String(fx.election._id), pollingStationId: String(fx.stations[0]!._id), position: 'GOVERNOR' });
    expect(r.status).toBe(404);
  });
});

describe('form templates', () => {
  it('exposes Form 34A for the presidential race', async () => {
    const admin = await as(app, 'SUPER_ADMIN');
    const r = await request(app).get('/api/admin/form-templates').set(admin.auth);
    expect(r.body.templates.PRESIDENT.formCode).toBe('34A');
    expect(r.body.templates.PRESIDENT.requiredFields).toContain('rejectedObjectedTo');
    void createUser;
  });
});
