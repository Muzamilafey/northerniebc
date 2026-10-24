import crypto from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, assign, createUser, login, seedElection, setupDb, teardownDb } from './helpers.js';
import { fmtEat, intakeState } from '../src/modules/elections/intake.js';
import { Election } from '../src/models/index.js';

let app: Express;
let fx: Awaited<ReturnType<typeof seedElection>>;
beforeAll(async () => {
  app = await setupDb();
  fx = await seedElection();
});
afterAll(teardownDb);

describe('results intake window', () => {
  it('works out open/closed from the mode and East Africa Time schedule', () => {
    const now = new Date('2026-10-24T15:30:00Z'); // 18:30 EAT
    const active = (resultsIntake: object) => intakeState({ status: 'ACTIVE', resultsIntake }, now);
    expect(fmtEat(new Date('2026-10-24T15:00:00Z'))).toBe('24 Oct 2026, 18:00 EAT');
    expect(active({ mode: 'OPEN' }).open).toBe(true);
    expect(active({ mode: 'CLOSED' })).toMatchObject({ open: false, message: expect.stringContaining('paused') });
    expect(active({ mode: 'SCHEDULED', opensAt: '2026-10-24T16:00:00Z' })).toMatchObject({ open: false, message: 'Results open at 24 Oct 2026, 19:00 EAT.' });
    expect(active({ mode: 'SCHEDULED', opensAt: '2026-10-24T15:00:00Z', closesAt: '2026-10-25T06:00:00Z' })).toMatchObject({ open: true, message: 'Receiving results until 25 Oct 2026, 09:00 EAT.' });
    expect(active({ mode: 'SCHEDULED', closesAt: '2026-10-24T15:00:00Z' })).toMatchObject({ open: false, message: 'Results closed at 24 Oct 2026, 18:00 EAT.' });
    expect(intakeState({ status: 'CLOSED', resultsIntake: { mode: 'OPEN' } }, now).open).toBe(false);
  });

  it('refuses counts outside the window and validates the schedule', async () => {
    const sa = await as(app, 'SUPER_ADMIN');
    const agent = await as(app, 'AGENT', { vetting: 'APPROVED' });
    await assign(agent.id, fx.election._id, fx.stations[0]!);
    const eid = String(fx.election._id);
    const tap = () => request(app).post('/api/agent/tally-events').set(agent.auth).send({ clientSessionId: crypto.randomUUID(), electionId: eid, pollingStationId: String(fx.stations[0]!._id), position: 'GOVERNOR', events: [{ seq: 1, kind: 'INCREMENT', candidateId: String(fx.govs[0]!._id) }] });

    expect((await request(app).patch(`/api/admin/elections/${eid}`).set(sa.auth).send({ resultsIntake: { mode: 'SCHEDULED' } })).status).toBe(400);
    expect((await request(app).patch(`/api/admin/elections/${eid}`).set(sa.auth).send({ resultsIntake: { mode: 'SCHEDULED', opensAt: '2026-10-25T10:00:00Z', closesAt: '2026-10-25T09:00:00Z' } })).status).toBe(400);

    const future = new Date(Date.now() + 3 * 3600_000);
    expect((await request(app).patch(`/api/admin/elections/${eid}`).set(sa.auth).send({ resultsIntake: { mode: 'SCHEDULED', opensAt: future.toISOString() } })).status).toBe(200);
    const early = await tap();
    expect(early.status).toBe(422);
    expect(early.body.error.message).toMatch(/^Results open at .* EAT\.$/);
    const assignments = await request(app).get('/api/agent/assignments').set(agent.auth);
    const mine = assignments.body.assignments.find((a: { election: { id: string } }) => a.election.id === eid);
    expect(mine.election).toMatchObject({ acceptingSubmissions: false, intake: { mode: 'SCHEDULED', open: false } });

    await request(app).patch(`/api/admin/elections/${eid}`).set(sa.auth).send({ resultsIntake: { mode: 'CLOSED' } });
    expect((await tap()).body.error.message).toMatch(/paused/);
    const list = await request(app).get('/api/admin/elections').set(sa.auth);
    expect(list.body.items.find((e: { _id: string }) => e._id === eid).intake.open).toBe(false);

    await request(app).patch(`/api/admin/elections/${eid}`).set(sa.auth).send({ resultsIntake: { mode: 'OPEN' } });
    expect((await tap()).status).toBe(200);
    expect((await Election.findById(eid).lean())!.resultsIntake?.mode).toBe('OPEN');
  });
});

describe('agent sign-in switch', () => {
  it('closing agent sign-in refuses agent logins and agent API calls, but not staff', async () => {
    const sa = await as(app, 'SUPER_ADMIN');
    const agent = await createUser('AGENT', { vetting: 'APPROVED' });
    const signedIn = await as(app, 'AGENT', { vetting: 'APPROVED' });
    const close = await request(app).put('/api/admin/settings/registration').set(sa.auth).send({ values: { AGENT_LOGIN: 'false' } });
    expect(close.status).toBe(200);

    await expect(login(app, agent)).rejects.toThrow(/403.*sign-in is closed/);
    expect((await request(app).get('/api/agent/assignments').set(signedIn.auth)).status).toBe(403);
    expect((await request(app).get('/api/agent-registration/config')).body).toMatchObject({ agentLogin: false, open: false });
    await expect(as(app, 'VERIFICATION_OFFICER')).resolves.toBeTruthy();

    await request(app).put('/api/admin/settings/registration').set(sa.auth).send({ values: { AGENT_LOGIN: 'true' } });
    await expect(login(app, agent)).resolves.toBeTruthy();
    expect((await request(app).get('/api/agent/assignments').set(signedIn.auth)).status).toBe(200);
  });
});
