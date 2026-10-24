import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, setupDb, teardownDb } from './helpers.js';
import { AgentRegistration, AuditEvent, SystemConfig, User } from '../src/models/index.js';
import { setting } from '../src/modules/settings/service.js';

let app: Express;
let kra: http.Server;
const calls: { path: string; auth?: string; body?: unknown }[] = [];

beforeAll(async () => {
  // Local stand-in for the KRA sandbox, following the published request/response shapes.
  kra = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      calls.push({ path: req.url ?? '', auth: req.headers.authorization, body: b ? JSON.parse(b) : undefined });
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/v1/token/generate')) {
        const ok = req.headers.authorization === `Basic ${Buffer.from('kra-key:kra-secret').toString('base64')}`;
        return ok ? res.end(JSON.stringify({ access_token: 'kra-token', expires_in: '3599' })) : res.writeHead(401).end(JSON.stringify({ errorCode: '401', errorMessage: 'Client credentials are invalid' }));
      }
      if (req.url === '/checker/v1/pin' && req.headers.authorization === 'Bearer kra-token') {
        const id = (JSON.parse(b) as { TaxpayerID: string }).TaxpayerID;
        if (id === '41789723') return res.end(JSON.stringify({ TaxpayerPIN: 'A000000000I', TaxpayerName: 'YAMAS12 TEST OMINI01' }));
        return res.end(JSON.stringify({ RequestId: 'x', ErrorCode: '30002', ErrorMessage: 'Invalid ID' }));
      }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((r) => kra.listen(0, '127.0.0.1', r));
  app = await setupDb();
});
afterAll(async () => {
  kra.close();
  await teardownDb();
});

describe('integration settings', () => {
  it('only super admins manage settings; secrets are write-only and audited without values', async () => {
    const regional = await as(app, 'REGIONAL_ADMIN');
    expect((await request(app).get('/api/admin/settings').set(regional.auth)).status).toBe(403);
    const sa = await as(app, 'SUPER_ADMIN');
    const put = await request(app)
      .put('/api/admin/settings/kra')
      .set(sa.auth)
      .send({ values: { KRA_BASE_URL: `http://127.0.0.1:${(kra.address() as AddressInfo).port}`, KRA_CONSUMER_KEY: 'kra-key', KRA_CONSUMER_SECRET: 'kra-secret' } });
    expect(put.status).toBe(200);
    expect(JSON.stringify(put.body)).not.toContain('kra-secret');
    expect(put.body.settings.kra.KRA_CONSUMER_SECRET).toMatchObject({ set: true, secret: true, source: 'settings' });
    expect(put.body.settings.kra.KRA_CONSUMER_SECRET.value).toBeUndefined();
    const stored = await SystemConfig.findById('integrations').lean();
    expect(JSON.stringify(stored)).not.toContain('kra-secret');
    expect(setting('KRA_CONSUMER_SECRET')).toBe('kra-secret');
    const audit = await AuditEvent.findOne({ action: 'settings.updated' }).lean();
    expect(JSON.stringify(audit)).not.toContain('kra-secret');
    const test = await request(app).post('/api/admin/settings/kra/test').set(sa.auth);
    expect(test.body.ok).toBe(true);
    const bad = await request(app).put('/api/admin/settings/mpesa').set(sa.auth).send({ values: { MPESA_ENV: 'live' } });
    expect(bad.status).toBe(400);
    // M-Pesa and SMTP credentials can be set the same way.
    const mp = await request(app).put('/api/admin/settings/mpesa').set(sa.auth).send({ values: { MPESA_SHORTCODE: '600000', MPESA_PASSKEY: 'pk-secret' } });
    expect(mp.body.settings.mpesa.MPESA_SHORTCODE.value).toBe('600000');
    expect(setting('MPESA_PASSKEY')).toBe('pk-secret');
    const smtp = await request(app).put('/api/admin/settings/smtp').set(sa.auth).send({ values: { SMTP_URL: 'smtp://user:pw@127.0.0.1:2525', MAIL_FROM: 'NIE <no-reply@example.org>' } });
    expect(smtp.body.settings.smtp.SMTP_URL.value).toBeUndefined();
    await request(app).put('/api/admin/settings/smtp').set(sa.auth).send({ clear: ['SMTP_URL'] });
    expect(setting('SMTP_URL')).toBeUndefined();
  });
});

describe('agent self-registration via KRA PIN Checker', () => {
  it('is closed until enabled', async () => {
    const r = await request(app).post('/api/agent-registration/start').send({ idNumber: '41789723', email: 'a@example.org', consent: true });
    expect(r.status).toBe(503);
  });

  it('registers with ID + email only; name and KRA PIN come from KRA, are locked, and never returned publicly', async () => {
    const sa = await as(app, 'SUPER_ADMIN');
    await request(app).put('/api/admin/settings/registration').set(sa.auth).send({ values: { AGENT_SELF_REGISTRATION: 'true' } });
    expect((await request(app).get('/api/agent-registration/config')).body.open).toBe(true);

    const invalid = await request(app).post('/api/agent-registration/start').send({ idNumber: '12345678', email: 'x@example.org', consent: true });
    expect(invalid.status).toBe(422);

    const start = await request(app).post('/api/agent-registration/start').send({ idNumber: '41789723', email: 'agent.self@example.org', consent: true });
    expect(start.status).toBe(202);
    const text = JSON.stringify(start.body);
    expect(text).not.toContain('YAMAS12');
    expect(text).not.toContain('A000000000I');
    expect(calls.filter((c) => c.path === '/checker/v1/pin').at(-1)!.body).toEqual({ TaxpayerType: 'KE', TaxpayerID: '41789723' });
    const token = new URL(start.body.devConfirmUrl).searchParams.get('token')!;

    const confirm = await request(app).get('/api/agent-registration/confirm').query({ token });
    expect(confirm.body.maskedName).toBe('Y****** T*** O******');
    const done = await request(app).post('/api/agent-registration/complete').send({ token, password: 'a-strong-passphrase-2026' });
    expect(done.status).toBe(201);
    expect(done.body.agentCode).toMatch(/^AGT-/);
    const u = await User.findOne({ email: 'agent.self@example.org' }).select('+identity.kraPinEnc +identity.nationalIdEnc').lean();
    expect(u!.fullName).toBe('YAMAS12 TEST OMINI01');
    expect(u!.identity!.locked).toBe(true);
    expect(u!.identity!.kraPinEnc).toMatch(/^v1\./);
    expect(u!.vetting!.status).toBe('PENDING');
    expect((await request(app).post('/api/agent-registration/complete').send({ token, password: 'a-strong-passphrase-2026' })).status).toBe(404);

    // Name is unchangeable, even by administrators; admins can view the KRA details for vetting (audited).
    const rename = await request(app).patch(`/api/admin/users/${String(u!._id)}`).set(sa.auth).send({ fullName: 'Someone Else' });
    expect(rename.status).toBe(403);
    const ident = await request(app).get(`/api/admin/users/${String(u!._id)}/identity`).set(sa.auth);
    expect(ident.body).toMatchObject({ kraPin: 'A000000000I', nationalId: '41789723', source: 'KRA_PIN_CHECKER', locked: true });
    expect(await AuditEvent.exists({ action: 'user.identity_viewed' })).toBeTruthy();
    const list = await request(app).get('/api/admin/users').set(sa.auth).query({ vetting: 'PENDING' });
    expect(JSON.stringify(list.body)).not.toMatch(/A000000000I|41789723|nationalIdIndex/);

    // The same ID cannot register again, and the response does not reveal that.
    const again = await request(app).post('/api/agent-registration/start').send({ idNumber: '41789723', email: 'other@example.org', consent: true });
    expect(again.status).toBe(202);
    expect(again.body.devConfirmUrl).toBeUndefined();
    expect(await AgentRegistration.countDocuments()).toBe(1);
  });
});
