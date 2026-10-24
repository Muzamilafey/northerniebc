import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, setupDb, teardownDb } from './helpers.js';
import { Donation, DonationReceipt, PaymentCallback, StoredFile } from '../src/models/index.js';
import { clearCache } from '../src/lib/cache.js';
import { resetMpesaToken } from '../src/payments/mpesa.js';

/** Minimal stand-in for the Daraja API so the real adapter code path is exercised. */
const stk = { queryResult: '0' as string, nextId: 0, pushes: [] as Record<string, unknown>[] };
let server: http.Server;
let app: Express;
const TOKEN = 'cb-token-0123456789abcdefghijklmnop';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/oauth')) return res.end(JSON.stringify({ access_token: 'stub-token', expires_in: '3599' }));
      if (req.headers.authorization !== 'Bearer stub-token') return res.writeHead(401).end('{}');
      if (req.url === '/mpesa/stkpush/v1/processrequest') {
        const b = JSON.parse(body);
        stk.pushes.push(b);
        const id = `ws_CO_${++stk.nextId}`;
        return res.end(JSON.stringify({ MerchantRequestID: `m-${id}`, CheckoutRequestID: id, ResponseCode: '0', ResponseDescription: 'Success. Request accepted for processing', CustomerMessage: 'Success' }));
      }
      if (req.url === '/mpesa/stkpushquery/v1/query') return res.end(JSON.stringify({ ResponseCode: '0', ResultCode: stk.queryResult, ResultDesc: 'stub' }));
      res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.MPESA_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  resetMpesaToken();
  app = await setupDb();
});
afterAll(async () => {
  server.close();
  await teardownDb();
});

const callback = (checkoutId: string, code: number, amount?: number, receipt?: string) => ({
  Body: {
    stkCallback: {
      MerchantRequestID: `m-${checkoutId}`,
      CheckoutRequestID: checkoutId,
      ResultCode: code,
      ResultDesc: code === 0 ? 'The service request is processed successfully.' : 'Request cancelled by user',
      ...(code === 0 ? { CallbackMetadata: { Item: [{ Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: receipt }, { Name: 'TransactionDate', Value: 20261024120000 }, { Name: 'PhoneNumber', Value: 254712345678 }] } } : {})
    }
  }
});

async function donate(amount = 500, extra: Record<string, unknown> = {}) {
  const r = await request(app).post('/api/donations').send({ idempotencyKey: crypto.randomUUID(), amount, method: 'MPESA', phone: '0712345678', acceptTerms: true, termsVersion: '2026-10', ...extra });
  return r;
}

describe('donation configuration', () => {
  it('lists only operational methods as available and never claims recurring support', async () => {
    const r = await request(app).get('/api/donations/config');
    expect(r.body.accepting).toBe(true);
    const methods = Object.fromEntries(r.body.methods.map((m: { method: string; operational: boolean }) => [m.method, m.operational]));
    expect(methods).toEqual({ MPESA: true, CARD: false, PAYPAL: false });
    expect(r.body.recurringAvailable).toBe(false);
    expect(r.body.presetsKes).toEqual([100, 250, 500, 1000, 2500, 5000]);
    expect(JSON.stringify(r.body)).not.toMatch(/test-secret|test-passkey|cb-token/);
  });

  it('rejects unavailable methods and invalid amounts', async () => {
    expect((await donate(500, { method: 'CARD', email: 'a@b.org' })).status).toBe(400);
    expect((await donate(5)).status).toBe(400);
    expect((await donate(10.5)).status).toBe(400);
  });
});

describe('M-Pesa flow', () => {
  it('initiation creates a PENDING donation; acceptance of the STK push is not success', async () => {
    const r = await donate(500);
    expect(r.status).toBe(201);
    expect(r.body.donation.status).toBe('PENDING');
    expect(r.body.next.type).toBe('STK_PUSH');
    const push = stk.pushes.at(-1)!;
    expect(push.Amount).toBe(500);
    expect(push.CallBackURL).toContain(`/api/payments/mpesa/callback/${TOKEN}`);
    const d = await Donation.findOne({ reference: r.body.donation.reference });
    expect(d!.status).toBe('PENDING');
    expect(d!.receiptId).toBeFalsy();
    const status = await request(app).get(`/api/donations/${d!.reference}/status`).query({ t: r.body.statusToken });
    expect(status.body.receipt).toBeNull();
    const noReceipt = await request(app).get(`/api/donations/${d!.reference}/receipt.pdf`).query({ t: r.body.statusToken });
    expect(noReceipt.status).toBe(404);
  });

  it('confirms only after a validated callback plus provider status query; duplicates do not double count', async () => {
    const r = await donate(1000, { email: 'donor@example.org', name: 'Amina Donor', acknowledgement: 'NAMED' });
    const d = await Donation.findOne({ reference: r.body.donation.reference });
    const cb = callback(d!.providerReference!, 0, 1000, 'SJK1234567');
    const [c1, c2, c3] = await Promise.all([
      request(app).post(`/api/payments/mpesa/callback/${TOKEN}`).send(cb),
      request(app).post(`/api/payments/mpesa/callback/${TOKEN}`).send(cb),
      request(app).post(`/api/payments/mpesa/callback/${TOKEN}`).send(cb)
    ]);
    for (const c of [c1, c2, c3]) expect(c.body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    const after = await Donation.findById(d!._id);
    expect(after!.status).toBe('SUCCESSFUL');
    expect(after!.providerReceipt).toBe('SJK1234567');
    expect(await DonationReceipt.countDocuments({ donationId: d!._id })).toBe(1);
    expect(await PaymentCallback.countDocuments({ 'body.CheckoutRequestID': d!.providerReference })).toBe(1);
    // Receipt has correct amount/reference and is downloadable with the donor token.
    const receipt = await DonationReceipt.findOne({ donationId: d!._id }).lean();
    expect(receipt!.snapshot).toMatchObject({ amount: 1000, currency: 'KES', donationReference: d!.reference });
    expect(receipt!.receiptNumber).toMatch(/^NIE-R-\d{4}-\d{6}$/);
    const pdf = await request(app).get(`/api/donations/${d!.reference}/receipt.pdf`).query({ t: r.body.statusToken });
    expect(pdf.status).toBe(200);
    expect(pdf.body.slice(0, 4).toString()).toBe('%PDF');
    expect((await request(app).get(`/api/donations/${d!.reference}/receipt.pdf`).query({ t: 'x'.repeat(30) })).status).toBe(404);
    expect(await StoredFile.countDocuments({ purpose: 'RECEIPT' })).toBe(1);
  });

  it('wrong callback token is rejected and nothing is recorded', async () => {
    const r = await donate(250);
    const d = await Donation.findOne({ reference: r.body.donation.reference });
    const c = await request(app).post(`/api/payments/mpesa/callback/wrong-token-wrong-token-wrong`).send(callback(d!.providerReference!, 0, 250, 'FAKE000001'));
    expect(c.status).toBe(404);
    expect((await Donation.findById(d!._id))!.status).toBe('PENDING');
  });

  it('amount mismatches are not confirmed and are flagged for reconciliation', async () => {
    const r = await donate(2500);
    const d = await Donation.findOne({ reference: r.body.donation.reference });
    await request(app).post(`/api/payments/mpesa/callback/${TOKEN}`).send(callback(d!.providerReference!, 0, 1, 'SMALL00001'));
    const after = await Donation.findById(d!._id);
    expect(after!.status).toBe('PENDING');
    expect(after!.needsReconciliation).toBe(true);
  });

  it('a success callback that the provider query does not confirm stays pending', async () => {
    stk.queryResult = '1037';
    const r = await donate(100);
    const d = await Donation.findOne({ reference: r.body.donation.reference });
    await request(app).post(`/api/payments/mpesa/callback/${TOKEN}`).send(callback(d!.providerReference!, 0, 100, 'SPOOF00001'));
    expect((await Donation.findById(d!._id))!.status).toBe('PENDING');
    stk.queryResult = '0';
  });

  it('failed/cancelled payments are recorded and never appear in totals', async () => {
    const r = await donate(5000);
    const d = await Donation.findOne({ reference: r.body.donation.reference });
    await request(app).post(`/api/payments/mpesa/callback/${TOKEN}`).send(callback(d!.providerReference!, 1032));
    expect((await Donation.findById(d!._id))!.status).toBe('CANCELLED');
    clearCache();
    const s = await request(app).get('/api/donations/public/summary');
    const kes = s.body.totals.find((t: { currency: string }) => t.currency === 'KES');
    expect(kes.count).toBe(1);
    expect(kes.gross).toBe(1000);
    expect(JSON.stringify(s.body)).not.toMatch(/2547|donor@example|SJK1234567/);
  });
});

describe('administration, reconciliation and refunds', () => {
  it('manual reconciliation needs evidence and a second approver', async () => {
    const f1 = await as(app, 'FINANCE_OFFICER');
    const f2 = await as(app, 'FINANCE_OFFICER');
    const r = await donate(250);
    const d = await Donation.findOne({ reference: r.body.donation.reference });
    const noEvidence = await request(app).post(`/api/admin/donations/${String(d!._id)}/reconcile`).set(f1.auth).send({ outcome: 'SUCCESSFUL', providerReceipt: 'MANUAL0001', evidenceFileId: '0'.repeat(24), note: 'Seen on the M-Pesa statement for that day' });
    expect(noEvidence.status).toBe(400);
    const pdf = Buffer.from('%PDF-1.4\n% statement\n');
    const up = await request(app).post('/api/files').set(f1.auth).field('purpose', 'RECONCILIATION_EVIDENCE').attach('file', pdf, { filename: 'statement.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    const req1 = await request(app).post(`/api/admin/donations/${String(d!._id)}/reconcile`).set(f1.auth).send({ outcome: 'SUCCESSFUL', providerReceipt: 'MANUAL0001', evidenceFileId: up.body.fileId, note: 'Seen on the M-Pesa statement for that day' });
    expect(req1.status).toBe(202);
    expect((await Donation.findById(d!._id))!.status).toBe('PENDING');
    expect((await request(app).post(`/api/approvals/${req1.body.approvalId}/approve`).set(f1.auth).send({ note: 'self approval attempt' })).status).toBe(403);
    const ap = await request(app).post(`/api/approvals/${req1.body.approvalId}/approve`).set(f2.auth).send({ note: 'Checked statement line' });
    expect(ap.status).toBe(200);
    const after = await Donation.findById(d!._id);
    expect(after!.status).toBe('SUCCESSFUL');
    expect(after!.confirmationSource).toBe('MANUAL_RECONCILIATION');
  });

  it('refunds go through the provider workflow, not a status change', async () => {
    const f1 = await as(app, 'FINANCE_OFFICER');
    const d = await Donation.findOne({ status: 'SUCCESSFUL', providerReceipt: 'SJK1234567' });
    const r = await request(app).post(`/api/admin/donations/${String(d!._id)}/refunds`).set(f1.auth).send({ amount: 2000, reason: 'Donor requested a refund by email' });
    expect(r.status).toBe(400); // exceeds amount
    const r2 = await request(app).post(`/api/admin/donations/${String(d!._id)}/refunds`).set(f1.auth).send({ amount: 1000, reason: 'Donor requested a refund by email' });
    expect(r2.status).toBe(202);
    expect((await Donation.findById(d!._id))!.status).toBe('SUCCESSFUL');
    const f2 = await as(app, 'FINANCE_OFFICER');
    // Reversal credentials are not configured in tests, so the provider call is refused and nothing changes.
    const ap = await request(app).post(`/api/approvals/${r2.body.approvalId}/approve`).set(f2.auth).send({ note: 'Approved per policy' });
    expect(ap.status).toBe(200);
    expect(ap.body.message).toMatch(/No money has been returned/);
    expect((await Donation.findById(d!._id))!.status).toBe('SUCCESSFUL');
  });

  it('admin views need authorisation; agents and anonymous users are refused', async () => {
    expect((await request(app).get('/api/admin/donations/summary')).status).toBe(401);
    const agent = await as(app, 'AGENT');
    expect((await request(app).get('/api/admin/donations/summary').set(agent.auth)).status).toBe(403);
    const fin = await as(app, 'FINANCE_OFFICER');
    const s = await request(app).get('/api/admin/donations/summary').set(fin.auth);
    expect(s.status).toBe(200);
    const list = await request(app).get('/api/admin/donations').set(fin.auth);
    expect(JSON.stringify(list.body)).not.toMatch(/phoneEnc|emailEnc|statusTokenHash/);
  });
});
