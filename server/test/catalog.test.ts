import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, seedElection, setupDb, teardownDb } from './helpers.js';
import { Candidate, Ward } from '../src/models/index.js';
import { env } from '../src/config/env.js';

let app: Express;
let fx: Awaited<ReturnType<typeof seedElection>>;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

beforeAll(async () => {
  app = await setupDb();
  fx = await seedElection();
});
afterAll(teardownDb);

async function uploadImage(auth: Record<string, string>, purpose: string, buf = png, name = 'logo.png') {
  return request(app).post('/api/files').set(auth).field('purpose', purpose).attach('file', buf, { filename: name, contentType: 'image/png' });
}

describe('counties', () => {
  it('super admins create counties and upload a logo; others cannot', async () => {
    const sa = await as(app, 'SUPER_ADMIN');
    const logo = await uploadImage(sa.auth, 'COUNTY_LOGO');
    expect(logo.status).toBe(201);
    expect(logo.body.visibility).toBe('PUBLIC');
    const c = await request(app).post('/api/admin/counties').set(sa.auth).send({ code: '012', name: 'Meru', region: 'Eastern', logoFileId: logo.body.fileId });
    expect(c.status).toBe(201);
    expect(c.body.county.slug).toBe('meru');
    const dup = await request(app).post('/api/admin/counties').set(sa.auth).send({ code: '012', name: 'Meru Again' });
    expect(dup.status).toBe(409);
    const badCode = await request(app).post('/api/admin/counties').set(sa.auth).send({ code: '12', name: 'X' });
    expect(badCode.status).toBe(400);
    const pub = await request(app).get('/api/public/counties');
    expect(pub.body.items.find((x: { name: string }) => x.name === 'Meru').logoFileId).toBe(logo.body.fileId);
    expect((await request(app).get(`/api/files/${logo.body.fileId}`)).status).toBe(200);

    const regional = await as(app, 'REGIONAL_ADMIN');
    expect((await request(app).post('/api/admin/counties').set(regional.auth).send({ code: '013', name: 'Embu' })).status).toBe(403);
    expect((await uploadImage(regional.auth, 'COUNTY_LOGO')).status).toBe(403);
    // Logo can be added later to an existing county.
    const garissa = pub.body.items.find((x: { name: string }) => x.name === 'Garissa');
    const logo2 = await uploadImage(sa.auth, 'COUNTY_LOGO');
    expect((await request(app).patch(`/api/admin/counties/${garissa._id}`).set(sa.auth).send({ logoFileId: logo2.body.fileId })).status).toBe(200);
  });

  it('rejects SVG and non-image logos', async () => {
    const sa = await as(app, 'SUPER_ADMIN');
    expect((await uploadImage(sa.auth, 'COUNTY_LOGO', svg, 'logo.svg')).status).toBe(400);
    expect((await uploadImage(sa.auth, 'PARTY_LOGO', Buffer.from('%PDF-1.4\n'), 'logo.pdf')).status).toBe(400);
  });
});

describe('parties and aspirants', () => {
  it('creates parties with logos and adds aspirants per position with photo and party', async () => {
    const admin = await as(app, 'REGIONAL_ADMIN');
    const logo = await uploadImage(admin.auth, 'PARTY_LOGO');
    const party = await request(app).post('/api/admin/parties').set(admin.auth).send({ name: 'Demo Unity Party', abbreviation: 'dup', logoFileId: logo.body.fileId });
    expect(party.status).toBe(201);
    expect(party.body.party.abbreviation).toBe('DUP');
    expect((await request(app).post('/api/admin/parties').set(admin.auth).send({ name: 'demo unity party', abbreviation: 'XX' })).status).toBe(409);

    const photo = await uploadImage(admin.auth, 'CANDIDATE_PHOTO');
    const gov = await request(app).post('/api/admin/candidates').set(admin.auth).send({ electionId: String(fx.election._id), position: 'GOVERNOR', fullName: 'Asha Demo Aspirant', partyId: party.body.party._id, scopeRefId: String(fx.county._id), ballotOrder: 3, photoFileId: photo.body.fileId });
    expect(gov.status).toBe(201);
    expect(gov.body.candidate).toMatchObject({ party: 'Demo Unity Party', partyAbbreviation: 'DUP', scopeType: 'COUNTY' });

    // Scope must match the position: an MCA needs a ward; a president has none.
    const mcaNoWard = await request(app).post('/api/admin/candidates').set(admin.auth).send({ electionId: String(fx.election._id), position: 'MCA', fullName: 'Ward Hopeful', scopeRefId: String(fx.county._id) });
    expect(mcaNoWard.status).toBe(400);
    const mca = await request(app).post('/api/admin/candidates').set(admin.auth).send({ electionId: String(fx.election._id), position: 'MCA', fullName: 'Ward Hopeful', independent: true, scopeRefId: String(fx.ward._id) });
    expect(mca.status).toBe(201);
    expect(mca.body.candidate.party).toBe('Independent');
    const pres = await request(app).post('/api/admin/candidates').set(admin.auth).send({ electionId: String(fx.election._id), position: 'PRESIDENT', fullName: 'National Hopeful', scopeRefId: String(fx.county._id) });
    expect(pres.status).toBe(400);

    const list = await request(app).get('/api/admin/candidates').set(admin.auth).query({ electionId: String(fx.election._id), position: 'GOVERNOR' });
    expect(list.body.items.find((c: { fullName: string }) => c.fullName === 'Asha Demo Aspirant').partyId.logoFileId).toBe(logo.body.fileId);

    // Party logo reaches the public results.
    const t = await request(app).get('/api/public/results/tally').query({ electionId: String(fx.election._id), position: 'GOVERNOR', countyId: String(fx.county._id) });
    const row = t.body.candidates.find((c: { fullName: string }) => c.fullName === 'Asha Demo Aspirant');
    expect(row.partyLogoFileId).toBe(logo.body.fileId);
    expect(row.photoFileId).toBe(photo.body.fileId);

    // Renaming the party updates its aspirants' ballot name; deactivating an aspirant needs a reason.
    await request(app).patch(`/api/admin/parties/${party.body.party._id}`).set(admin.auth).send({ name: 'Demo Unity Alliance' });
    expect((await Candidate.findById(gov.body.candidate._id))!.party).toBe('Demo Unity Alliance');
    expect((await request(app).patch(`/api/admin/candidates/${gov.body.candidate._id}`).set(admin.auth).send({ active: false })).status).toBe(400);
    expect((await request(app).patch(`/api/admin/candidates/${gov.body.candidate._id}`).set(admin.auth).send({ active: false, reason: 'Withdrew per gazette notice' })).status).toBe(200);
  });

  it('agents and county admins cannot manage aspirants or parties', async () => {
    const agent = await as(app, 'AGENT');
    expect((await request(app).post('/api/admin/parties').set(agent.auth).send({ name: 'X Party', abbreviation: 'X' })).status).toBe(403);
    const ca = await as(app, 'COUNTY_ADMIN', { scope: { countyIds: [String(fx.county._id)] } });
    expect((await request(app).post('/api/admin/candidates').set(ca.auth).send({ electionId: String(fx.election._id), position: 'GOVERNOR', fullName: 'Nope', scopeRefId: String(fx.county._id) })).status).toBe(403);
  });
});

describe('constituencies and wards', () => {
  it('loads the official IEBC list once, idempotently, with its source', async () => {
    const sa = await as(app, 'SUPER_ADMIN');
    const eid = String(fx.election._id);
    const first = await request(app).post(`/api/admin/elections/${eid}/areas/load-official`).set(sa.auth);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ constituenciesAdded: 24, wardsAdded: 120, conflicts: [] });
    const again = await request(app).post(`/api/admin/elections/${eid}/areas/load-official`).set(sa.auth);
    expect(again.body).toMatchObject({ constituenciesAdded: 0, wardsAdded: 0, alreadyPresent: 144 });

    const cons = await request(app).get(`/api/public/elections/${eid}/constituencies`).query({ countyId: String(fx.county._id) });
    const township = cons.body.items.find((c: { code: string }) => c.code === '027');
    expect(township.name).toBe('Garissa Township');
    const wards = await request(app).get(`/api/public/elections/${eid}/wards`).query({ constituencyId: township._id });
    expect(wards.body.items.map((w: { code: string }) => w.code).sort()).toEqual(['0131', '0132', '0133', '0134']);
    const ward = await Ward.findOne({ code: '0131' }).populate('sourceId').lean();
    expect((ward!.sourceId as unknown as { url: string }).url).toContain('iebc.or.ke');

    const regional = await as(app, 'REGIONAL_ADMIN');
    expect((await request(app).post(`/api/admin/elections/${eid}/areas/load-official`).set(regional.auth)).status).toBe(403);
  });

  it('adds a constituency and ward by hand; codes are unique, names corrected only with a reason', async () => {
    const sa = await as(app, 'SUPER_ADMIN');
    const eid = String(fx.election._id);
    const c = await request(app).post(`/api/admin/elections/${eid}/constituencies`).set(sa.auth).send({ countyId: String(fx.county._id), code: '901', name: 'New Constituency' });
    expect(c.status).toBe(201);
    expect((await request(app).post(`/api/admin/elections/${eid}/constituencies`).set(sa.auth).send({ countyId: String(fx.county._id), code: '901', name: 'Dup' })).status).toBe(409);
    expect((await request(app).post(`/api/admin/elections/${eid}/constituencies`).set(sa.auth).send({ countyId: String(fx.county._id), code: 'AB', name: 'Bad' })).status).toBe(400);
    const w = await request(app).post(`/api/admin/elections/${eid}/wards`).set(sa.auth).send({ constituencyId: c.body.constituency._id, code: '9001', name: 'New Ward' });
    expect(w.status).toBe(201);
    expect(w.body.ward.countyId).toBe(String(fx.county._id));
    expect((await request(app).patch(`/api/admin/wards/${w.body.ward._id}`).set(sa.auth).send({ name: 'New Ward B' })).status).toBe(400);
    expect((await request(app).patch(`/api/admin/wards/${w.body.ward._id}`).set(sa.auth).send({ name: 'New Ward B', reason: 'Spelling per gazette' })).status).toBe(200);
    const areas = await request(app).get(`/api/admin/elections/${eid}/areas`).set(sa.auth);
    expect(areas.body.items.find((x: { code: string }) => x.code === '901').wards[0].name).toBe('New Ward B');
  });
});

describe('upload and area safeguards', () => {
  it('refuses an image it could never show when no scanner is configured', async () => {
    const sa = await as(app, 'SUPER_ADMIN');
    const saved = env.ALLOW_UNSCANNED_UPLOADS;
    (env as { ALLOW_UNSCANNED_UPLOADS: boolean }).ALLOW_UNSCANNED_UPLOADS = false;
    try {
      const r = await uploadImage(sa.auth, 'PARTY_LOGO');
      expect(r.status).toBe(503);
      expect(r.body.error.message).toContain('ALLOW_UNSCANNED_UPLOADS');
    } finally {
      (env as { ALLOW_UNSCANNED_UPLOADS: boolean }).ALLOW_UNSCANNED_UPLOADS = saved;
    }
  });

  it('flags a hand-made duplicate county when loading the official list', async () => {
    const sa = await as(app, 'SUPER_ADMIN');
    expect((await request(app).post('/api/admin/counties').set(sa.auth).send({ code: '098', name: 'MARSABIT COUNTY' })).status).toBe(201);
    const r = await request(app).post(`/api/admin/elections/${String(fx.election._id)}/areas/load-official`).set(sa.auth);
    expect(r.status).toBe(200);
    expect(r.body.conflicts.join(' ')).toContain('"MARSABIT COUNTY" (code 098) looks like a duplicate of Marsabit 010');
  });
});
