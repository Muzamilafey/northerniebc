import { authenticator } from 'otplib';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { connectMongo } from '../src/db/mongo.js';
import { encrypt } from '../src/lib/crypto.js';
import { clearCache } from '../src/lib/cache.js';
import '../src/models/index.js';
import {
  AgentAssignment,
  Candidate,
  Constituency,
  County,
  DataSource,
  Election,
  PollingStation,
  User,
  Ward,
  type Role
} from '../src/models/index.js';
import { hashPassword } from '../src/modules/auth/password.js';
import { seedReference } from '../src/scripts/seedReference.js';
import { loadSettings } from '../src/modules/settings/service.js';

export const PASSWORD = 'correct-horse-battery-staple-42';
let pwHash: string | undefined;

export async function setupDb(): Promise<Express> {
  await connectMongo(process.env.MONGODB_URI);
  for (const name of mongoose.modelNames()) await mongoose.model(name).createCollection().catch(() => undefined);
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).syncIndexes()));
  await seedReference();
  await loadSettings();
  clearCache();
  return createApp();
}

export async function teardownDb() {
  await mongoose.connection.db?.dropDatabase();
  await mongoose.disconnect();
}

let seq = 0;
export async function createUser(role: Role, opts: { scope?: { countyIds?: string[]; constituencyIds?: string[] }; mfa?: boolean; agentCode?: string; vetting?: 'PENDING' | 'APPROVED' | 'REJECTED'; stepUp?: boolean } = {}) {
  pwHash ??= await hashPassword(PASSWORD);
  const secret = authenticator.generateSecret();
  const mfa = opts.mfa ?? role !== 'AGENT';
  seq++;
  const u = await User.create({
    fullName: `Test ${role} ${seq}`,
    email: `user${seq}-${Date.now()}@example.org`,
    passwordHash: pwHash,
    role,
    scope: { countyIds: opts.scope?.countyIds ?? [], constituencyIds: opts.scope?.constituencyIds ?? [] },
    agentCode: role === 'AGENT' ? (opts.agentCode ?? `AGT-T${String(seq).padStart(7, '0')}`) : undefined,
    mustChangePassword: false,
    vetting: { status: opts.vetting ?? (role === 'AGENT' ? 'APPROVED' : 'PENDING') },
    mfa: mfa ? { enabled: true, secretEnc: encrypt(secret), recoveryCodeHashes: [] } : { enabled: false }
  });
  return { user: u, secret, id: String(u._id) };
}

export async function login(app: Express, u: { user: { email: string; agentCode?: string | null; role: string }; secret: string }) {
  const identifier = u.user.role === 'AGENT' && u.user.agentCode ? u.user.agentCode : u.user.email;
  const r1 = await request(app).post('/api/auth/login').send({ identifier, password: PASSWORD });
  if (r1.status !== 200) throw new Error(`login failed ${r1.status} ${JSON.stringify(r1.body)}`);
  if (r1.body.mfaRequired) {
    const r2 = await request(app).post('/api/auth/mfa/verify').send({ mfaToken: r1.body.mfaToken, code: authenticator.generate(u.secret) });
    if (r2.status !== 200) throw new Error(`mfa failed ${r2.status} ${JSON.stringify(r2.body)}`);
    return { token: r2.body.accessToken as string, cookie: r2.headers['set-cookie'] as unknown as string[] };
  }
  return { token: r1.body.accessToken as string, cookie: r1.headers['set-cookie'] as unknown as string[] };
}

export async function as(app: Express, role: Role, opts: Parameters<typeof createUser>[1] = {}) {
  const u = await createUser(role, opts);
  const { token } = await login(app, u);
  const auth = { Authorization: `Bearer ${token}` };
  // Agents confirm their password before submitting (step-up), as the app does.
  if (role === 'AGENT' && opts.stepUp !== false) {
    const r = await request(app).post('/api/agent/confirm-identity').set(auth).send({ password: PASSWORD });
    if (r.status !== 200 && opts.vetting === undefined) throw new Error(`step-up failed ${r.status}`);
  }
  return { ...u, token, auth };
}

/** A small synthetic election (test fixture only). */
export async function seedElection(opts: { publishProvisional?: boolean; requireEvidence?: boolean; stations?: number } = {}) {
  const county = (await County.findOne({ code: '007' }))!;
  const other = (await County.findOne({ code: '009' }))!;
  const src = await DataSource.create({ name: 'Test fixture source', kind: 'OTHER' });
  const election = await Election.create({
    name: 'Test Election',
    slug: `test-election-${Date.now()}-${seq++}`,
    type: 'GENERAL',
    electionDate: new Date(),
    status: 'ACTIVE',
    publishProvisional: opts.publishProvisional ?? true,
    positions: [
      { position: 'GOVERNOR', enabled: true, requiredFields: ['validVotes'], rules: ['CANDIDATE_SUM_EQUALS_VALID', 'CAST_NOT_EXCEEDING_REGISTERED'], requireEvidence: opts.requireEvidence ?? false },
      { position: 'MCA', enabled: true, requiredFields: [], rules: ['CANDIDATE_SUM_EQUALS_VALID'], requireEvidence: false }
    ]
  });
  const cons = await Constituency.create({ electionId: election._id, countyId: county._id, code: 'C1', name: 'Test Constituency' });
  const ward = await Ward.create({ electionId: election._id, countyId: county._id, constituencyId: cons._id, code: 'W1', name: 'Test Ward' });
  const cons2 = await Constituency.create({ electionId: election._id, countyId: other._id, code: 'C2', name: 'Other Constituency' });
  const ward2 = await Ward.create({ electionId: election._id, countyId: other._id, constituencyId: cons2._id, code: 'W2', name: 'Other Ward' });
  const stations = [];
  for (let i = 0; i < (opts.stations ?? 3); i++) {
    stations.push(await PollingStation.create({ electionId: election._id, countyId: county._id, constituencyId: cons._id, wardId: ward._id, code: `PS${i + 1}`, name: `Station ${i + 1}`, registeredVoters: 500 }));
  }
  const otherStation = await PollingStation.create({ electionId: election._id, countyId: other._id, constituencyId: cons2._id, wardId: ward2._id, code: 'PSX', name: 'Other County Station', registeredVoters: 500 });
  const govs = await Candidate.create([
    { electionId: election._id, position: 'GOVERNOR', fullName: 'Gov A', party: 'Party A', scopeType: 'COUNTY', scopeRefId: county._id, ballotOrder: 1 },
    { electionId: election._id, position: 'GOVERNOR', fullName: 'Gov B', party: 'Party B', scopeType: 'COUNTY', scopeRefId: county._id, ballotOrder: 2 },
    { electionId: election._id, position: 'GOVERNOR', fullName: 'Gov Other County', party: 'Party C', scopeType: 'COUNTY', scopeRefId: other._id, ballotOrder: 1 }
  ]);
  const mcas = await Candidate.create([
    { electionId: election._id, position: 'MCA', fullName: 'MCA A', scopeType: 'WARD', scopeRefId: ward._id },
    { electionId: election._id, position: 'MCA', fullName: 'MCA B', scopeType: 'WARD', scopeRefId: ward._id }
  ]);
  return { election, county, other, cons, ward, stations, otherStation, govs, mcas, src };
}

export async function assign(agentId: string, electionId: unknown, station: { _id: unknown; countyId: unknown; constituencyId: unknown; wardId: unknown }) {
  return AgentAssignment.create({ userId: agentId, electionId, pollingStationId: station._id, countyId: station.countyId, constituencyId: station.constituencyId, wardId: station.wardId });
}
