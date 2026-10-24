import request from 'supertest';
import type { Express } from 'express';
import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, createUser, login, PASSWORD, setupDb, teardownDb } from './helpers.js';
import { AuditEvent, Session, User } from '../src/models/index.js';
import { sealAuditChain, verifyAuditChain } from '../src/lib/audit.js';

let app: Express;
beforeAll(async () => {
  app = await setupDb();
});
afterAll(teardownDb);

const cookieHeaders = (cookie: string[]) => ({ Cookie: cookie.map((c) => c.split(';')[0]).join('; '), 'X-Requested-With': 'XMLHttpRequest' });

describe('authentication', () => {
  it('requires MFA for privileged accounts and enforces it on protected endpoints', async () => {
    const u = await createUser('SUPER_ADMIN', { mfa: false });
    const r = await request(app).post('/api/auth/login').send({ identifier: u.user.email, password: PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body.mfaSetupRequired).toBe(true);
    const denied = await request(app).get('/api/admin/users').set({ Authorization: `Bearer ${r.body.accessToken}` });
    expect(denied.status).toBe(403);
    // Enrol MFA.
    const setup = await request(app).post('/api/auth/mfa/setup').set({ Authorization: `Bearer ${r.body.accessToken}` });
    expect(setup.status).toBe(200);
    const enable = await request(app).post('/api/auth/mfa/enable').set({ Authorization: `Bearer ${r.body.accessToken}` }).send({ code: authenticator.generate(setup.body.secret) });
    expect(enable.status).toBe(200);
    expect(enable.body.recoveryCodes).toHaveLength(10);
    const ok = await request(app).get('/api/admin/users').set({ Authorization: `Bearer ${enable.body.accessToken}` });
    expect(ok.status).toBe(200);
  });

  it('rejects bad credentials without revealing whether the account exists, and locks after repeated failures', async () => {
    const u = await createUser('AGENT');
    const a = await request(app).post('/api/auth/login').send({ identifier: 'nobody@example.org', password: 'x' });
    const b = await request(app).post('/api/auth/login').send({ identifier: u.user.agentCode, password: 'wrong-password-123' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/login').send({ identifier: u.user.agentCode, password: 'wrong-password-123' });
    const locked = await request(app).post('/api/auth/login').send({ identifier: u.user.agentCode, password: PASSWORD });
    expect(locked.status).toBe(401);
    expect(locked.body.error.message).toMatch(/locked/i);
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const u = await createUser('AGENT');
    const { cookie } = await login(app, u);
    const r1 = await request(app).post('/api/auth/refresh').set(cookieHeaders(cookie));
    expect(r1.status).toBe(200);
    const r2 = await request(app).post('/api/auth/refresh').set(cookieHeaders(r1.headers['set-cookie'] as unknown as string[]));
    expect(r2.status).toBe(200);
    // Replaying the first (rotated-out) token = theft signal → family revoked.
    const replay = await request(app).post('/api/auth/refresh').set(cookieHeaders(cookie));
    expect(replay.status).toBe(401);
    const after = await request(app).post('/api/auth/refresh').set(cookieHeaders(r2.headers['set-cookie'] as unknown as string[]));
    expect(after.status).toBe(401);
    expect(await AuditEvent.exists({ action: 'auth.refresh_reuse_detected' })).toBeTruthy();
  });

  it('refresh requires the CSRF header', async () => {
    const u = await createUser('AGENT');
    const { cookie } = await login(app, u);
    const r = await request(app).post('/api/auth/refresh').set({ Cookie: cookie.map((c) => c.split(';')[0]).join('; ') });
    expect(r.status).toBe(403);
  });

  it('suspension and session revocation take effect immediately', async () => {
    const admin = await as(app, 'SUPER_ADMIN');
    const agent = await as(app, 'AGENT');
    expect((await request(app).get('/api/auth/me').set(agent.auth)).status).toBe(200);
    const s = await request(app).post(`/api/admin/users/${agent.id}/suspend`).set(admin.auth).send({ reason: 'Lost device' });
    expect(s.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(agent.auth)).status).toBe(401);
    expect(await Session.countDocuments({ userId: agent.id, revokedAt: null })).toBe(0);
  });

  it('never trusts client-supplied roles', async () => {
    const agent = await as(app, 'AGENT');
    const r = await request(app).get('/api/admin/users').set({ ...agent.auth, 'X-Role': 'SUPER_ADMIN' }).query({ role: 'SUPER_ADMIN' });
    expect(r.status).toBe(403);
    const forged = await request(app).get('/api/admin/users').set({ Authorization: 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4Iiwicm9sZSI6IlNVUEVSX0FETUlOIn0.' });
    expect(forged.status).toBe(401);
  });
});

describe('user administration', () => {
  it('county admins can create agents but not super admins, and cannot manage out-of-scope users', async () => {
    const counties = await (await import('../src/models/index.js')).County.find().lean();
    const ca = await as(app, 'COUNTY_ADMIN', { scope: { countyIds: [String(counties[0]!._id)] } });
    const agent = await request(app).post('/api/admin/users').set(ca.auth).send({ fullName: 'New Agent', email: 'new.agent@example.org', role: 'AGENT', phone: '0712345678' });
    expect(agent.status).toBe(201);
    expect(agent.body.user.agentCode).toMatch(/^AGT-/);
    expect(agent.body.temporaryPassword).toBeTruthy();
    expect(JSON.stringify(agent.body)).not.toContain('0712345678');
    const sa = await request(app).post('/api/admin/users').set(ca.auth).send({ fullName: 'Evil', email: 'evil@example.org', role: 'SUPER_ADMIN' });
    expect(sa.status).toBe(403);
    const otherCa = await request(app).post('/api/admin/users').set(ca.auth).send({ fullName: 'Other CA', email: 'oca@example.org', role: 'COUNTY_ADMIN', scope: { countyIds: [String(counties[1]!._id)] } });
    expect(otherCa.status).toBe(403);
    const stored = await User.findById(agent.body.user._id).lean();
    expect(stored!.phoneEnc).toMatch(/^v1\./);
  });
});

describe('input hardening', () => {
  it('rejects NoSQL operator injection', async () => {
    const r = await request(app).post('/api/auth/login').send({ identifier: { $ne: null }, password: { $ne: null } });
    expect(r.status).toBe(400);
    const q = await request(app).get('/api/public/projects').query({ 'countyId[$ne]': 'x' });
    expect([400]).toContain(q.status);
  });

  it('rejects oversized and malformed bodies', async () => {
    const big = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send(`{"identifier":"${'a'.repeat(300_000)}"}`);
    expect(big.status).toBe(413);
    const bad = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{bad json');
    expect(bad.status).toBe(400);
  });

  it('sets security headers', async () => {
    const r = await request(app).get('/healthz');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['x-powered-by']).toBeUndefined();
  });
});

describe('audit chain tamper detection', () => {
  it('detects modification of a past audit event', async () => {
    await sealAuditChain(10_000);
    expect((await verifyAuditChain()).ok).toBe(true);
    const first = await AuditEvent.findOne({ sealed: true }).sort({ seq: 1 });
    await AuditEvent.collection.updateOne({ _id: first!._id }, { $set: { action: 'tampered' } });
    const v = await verifyAuditChain();
    expect(v.ok).toBe(false);
    expect(v.firstBrokenSeq).toBe(first!.seq);
  });
});
