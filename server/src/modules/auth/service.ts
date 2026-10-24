import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import { env } from '../../config/env.js';
import { recordAuditStandalone, recordAudit } from '../../lib/audit.js';
import { decrypt, encrypt, randomToken, sha256 } from '../../lib/crypto.js';
import { badRequest, unauthorized } from '../../lib/errors.js';
import { PRIVILEGED_ROLES, Session, User, type Role } from '../../models/identity.js';
import { signAccessToken } from '../../middleware/auth.js';
import { getDummyHash, hashPassword, passwordProblems, verifyPassword } from './password.js';
import { withTransaction } from '../../db/mongo.js';
import { enqueueEmail } from '../notifications/service.js';

authenticator.options = { window: 1 };

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

export interface IssuedSession {
  accessToken: string;
  refreshCookie: string;
  refreshExpiresAt: Date;
  user: PublicUser;
  mfaSetupRequired: boolean;
}

export interface PublicUser {
  id: string;
  fullName: string;
  email: string;
  role: Role;
  agentCode?: string | null;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  scope: { countyIds: string[]; constituencyIds: string[] };
}

export function toPublicUser(u: {
  _id: unknown;
  fullName: string;
  email: string;
  role: string;
  agentCode?: string | null;
  mfa?: { enabled?: boolean | null } | null;
  mustChangePassword?: boolean | null;
  scope?: { countyIds?: unknown[]; constituencyIds?: unknown[] } | null;
}): PublicUser {
  return {
    id: String(u._id),
    fullName: u.fullName,
    email: u.email,
    role: u.role as Role,
    agentCode: u.agentCode ?? null,
    mfaEnabled: Boolean(u.mfa?.enabled),
    mustChangePassword: Boolean(u.mustChangePassword),
    scope: {
      countyIds: (u.scope?.countyIds ?? []).map(String),
      constituencyIds: (u.scope?.constituencyIds ?? []).map(String)
    }
  };
}

function refreshTtlMs(role: Role) {
  return PRIVILEGED_ROLES.includes(role)
    ? env.PRIVILEGED_REFRESH_TOKEN_TTL_HOURS * 3600_000
    : env.REFRESH_TOKEN_TTL_DAYS * 86400_000;
}

async function issueSession(userId: string, role: Role, mfaVerified: boolean, client: ClientInfo): Promise<IssuedSession> {
  const familyId = crypto.randomUUID();
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + refreshTtlMs(role));
  await Session.create({
    userId,
    familyId,
    currentTokenHash: sha256(token),
    mfaVerified,
    userAgent: client.userAgent?.slice(0, 300),
    ip: client.ip,
    expiresAt
  });
  const user = await User.findById(userId).lean();
  return {
    accessToken: signAccessToken({ sub: userId, sid: familyId, mfa: mfaVerified }),
    refreshCookie: `${familyId}.${token}`,
    refreshExpiresAt: expiresAt,
    user: toPublicUser(user!),
    mfaSetupRequired: env.REQUIRE_MFA_FOR_PRIVILEGED && PRIVILEGED_ROLES.includes(role) && !user!.mfa?.enabled
  };
}

export type LoginResult = { kind: 'session'; session: IssuedSession } | { kind: 'mfa'; mfaToken: string };

export async function login(identifier: string, password: string, client: ClientInfo): Promise<LoginResult> {
  const id = identifier.trim();
  const user = await User.findOne(id.includes('@') ? { email: id.toLowerCase() } : { agentCode: id.toUpperCase() }).select('+passwordHash');
  if (!user) {
    await verifyPassword(await getDummyHash(), password);
    throw unauthorized('Invalid credentials');
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw unauthorized('Account temporarily locked after repeated failed attempts. Try again later.');
  }
  const ok = await verifyPassword(user.passwordHash, password);
  if (!ok || user.status !== 'ACTIVE') {
    if (!ok) {
      user.failedLoginCount = (user.failedLoginCount ?? 0) + 1;
      if (user.failedLoginCount >= MAX_FAILED) {
        user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
        user.failedLoginCount = 0;
      }
      await user.save();
    }
    await recordAuditStandalone({
      actor: { id: String(user._id), role: user.role, ip: client.ip },
      action: 'auth.login_failed',
      entityType: 'User',
      entityId: String(user._id),
      meta: { reason: ok ? `status_${user.status}` : 'bad_password' }
    });
    throw unauthorized('Invalid credentials');
  }
  user.failedLoginCount = 0;
  user.lockedUntil = undefined;
  await user.save();

  if (user.mfa?.enabled) {
    const mfaToken = jwt.sign({ sub: String(user._id), typ: 'mfa' }, env.JWT_ACCESS_SECRET, {
      expiresIn: 300,
      algorithm: 'HS256',
      issuer: 'northern-iebc'
    });
    return { kind: 'mfa', mfaToken };
  }
  return { kind: 'session', session: await completeLogin(String(user._id), false, client) };
}

async function completeLogin(userId: string, mfaVerified: boolean, client: ClientInfo) {
  const user = await User.findByIdAndUpdate(userId, { lastLoginAt: new Date(), lastLoginIp: client.ip }, { new: true });
  await recordAuditStandalone({
    actor: { id: userId, role: user!.role, ip: client.ip },
    action: 'auth.login',
    entityType: 'User',
    entityId: userId,
    meta: { mfa: mfaVerified, userAgent: client.userAgent?.slice(0, 200) }
  });
  return issueSession(userId, user!.role as Role, mfaVerified, client);
}

export async function verifyMfaLogin(mfaToken: string, code: string, client: ClientInfo): Promise<IssuedSession> {
  let claims: { sub: string; typ: string };
  try {
    claims = jwt.verify(mfaToken, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: 'northern-iebc' }) as typeof claims;
  } catch {
    throw unauthorized('MFA challenge expired. Please sign in again.');
  }
  if (claims.typ !== 'mfa') throw unauthorized();
  const user = await User.findById(claims.sub).select('+mfa.secretEnc +mfa.recoveryCodeHashes');
  if (!user || user.status !== 'ACTIVE' || !user.mfa?.enabled || !user.mfa.secretEnc) throw unauthorized();
  const normalized = code.replace(/\s/g, '');
  let ok = /^\d{6}$/.test(normalized) && authenticator.check(normalized, decrypt(user.mfa.secretEnc));
  if (!ok) {
    const h = sha256(normalized.toUpperCase());
    const idx = user.mfa.recoveryCodeHashes.indexOf(h);
    if (idx >= 0) {
      user.mfa.recoveryCodeHashes.splice(idx, 1);
      await user.save();
      ok = true;
    }
  }
  if (!ok) {
    await recordAuditStandalone({
      actor: { id: String(user._id), role: user.role, ip: client.ip },
      action: 'auth.mfa_failed',
      entityType: 'User',
      entityId: String(user._id)
    });
    throw unauthorized('Invalid verification code');
  }
  return completeLogin(String(user._id), true, client);
}

export async function refresh(cookie: string | undefined, client: ClientInfo): Promise<IssuedSession & { familyId: string }> {
  if (!cookie) throw unauthorized('No session');
  const [familyId, token] = cookie.split('.');
  if (!familyId || !token) throw unauthorized('No session');
  const session = await Session.findOne({ familyId });
  if (!session || session.revokedAt || session.expiresAt < new Date()) throw unauthorized('Session expired');
  const hash = sha256(token);
  if (session.currentTokenHash !== hash) {
    if (session.previousTokenHashes.includes(hash)) {
      // A rotated-out token was presented again: treat the family as compromised.
      session.revokedAt = new Date();
      session.revokedReason = 'refresh_token_reuse';
      await session.save();
      await recordAuditStandalone({
        actor: { id: String(session.userId), ip: client.ip },
        action: 'auth.refresh_reuse_detected',
        entityType: 'Session',
        entityId: familyId
      });
    }
    throw unauthorized('Session expired');
  }
  const user = await User.findById(session.userId).lean();
  if (!user || user.status !== 'ACTIVE') throw unauthorized('Account not active');
  const next = randomToken(32);
  const r = await Session.updateOne(
    { _id: session._id, currentTokenHash: hash },
    {
      $set: { currentTokenHash: sha256(next), lastUsedAt: new Date(), ip: client.ip },
      $push: { previousTokenHashes: { $each: [hash], $slice: -20 } }
    }
  );
  if (r.modifiedCount !== 1) throw unauthorized('Session expired');
  return {
    familyId,
    accessToken: signAccessToken({ sub: String(user._id), sid: familyId, mfa: session.mfaVerified }),
    refreshCookie: `${familyId}.${next}`,
    refreshExpiresAt: session.expiresAt,
    user: toPublicUser(user),
    mfaSetupRequired: env.REQUIRE_MFA_FOR_PRIVILEGED && PRIVILEGED_ROLES.includes(user.role as Role) && !user.mfa?.enabled
  };
}

export async function revokeSession(familyId: string, reason: string) {
  await Session.updateOne({ familyId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });
}

export async function revokeAllSessions(userId: string, reason: string) {
  await Session.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } });
}

export async function beginMfaSetup(userId: string) {
  const user = await User.findById(userId);
  if (!user) throw unauthorized();
  const secret = authenticator.generateSecret(20);
  await User.updateOne({ _id: userId }, { $set: { 'mfa.pendingSecretEnc': encrypt(secret) } });
  const otpauth = authenticator.keyuri(user.email, 'The Northern IEBC', secret);
  return { otpauth, qrDataUrl: await QRCode.toDataURL(otpauth), secret };
}

export async function enableMfa(userId: string, sessionFamilyId: string, code: string, client: ClientInfo) {
  const user = await User.findById(userId).select('+mfa.pendingSecretEnc');
  if (!user?.mfa?.pendingSecretEnc) throw badRequest('Start MFA setup first');
  const secret = decrypt(user.mfa.pendingSecretEnc);
  if (!authenticator.check(code.replace(/\s/g, ''), secret)) throw badRequest('Invalid verification code');
  const recoveryCodes = Array.from({ length: 10 }, () => randomToken(6).toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 10));
  await withTransaction(async (s) => {
    await User.updateOne(
      { _id: userId },
      {
        $set: {
          'mfa.enabled': true,
          'mfa.secretEnc': encrypt(secret),
          'mfa.recoveryCodeHashes': recoveryCodes.map((c) => sha256(c))
        },
        $unset: { 'mfa.pendingSecretEnc': 1 }
      },
      { session: s }
    );
    await Session.updateOne({ familyId: sessionFamilyId }, { $set: { mfaVerified: true } }, { session: s });
    await recordAudit(s, {
      actor: { id: userId, role: user.role, ip: client.ip },
      action: 'auth.mfa_enabled',
      entityType: 'User',
      entityId: userId
    });
  });
  return {
    recoveryCodes,
    accessToken: signAccessToken({ sub: userId, sid: sessionFamilyId, mfa: true })
  };
}

export async function changePassword(userId: string, current: string, next: string, client: ClientInfo, keepFamilyId: string) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user || !(await verifyPassword(user.passwordHash, current))) throw unauthorized('Current password is incorrect');
  const problems = passwordProblems(next, [user.fullName, user.email.split('@')[0]!]);
  if (problems.length) throw badRequest('Weak password', problems);
  user.passwordHash = await hashPassword(next);
  user.passwordChangedAt = new Date();
  user.mustChangePassword = false;
  await user.save();
  await Session.updateMany(
    { userId, revokedAt: null, familyId: { $ne: keepFamilyId } },
    { $set: { revokedAt: new Date(), revokedReason: 'password_changed' } }
  );
  await recordAuditStandalone({ actor: { id: userId, role: user.role, ip: client.ip }, action: 'auth.password_changed', entityType: 'User', entityId: userId });
}

const RESET_TTL_MS = 30 * 60_000;

/** Always succeeds from the caller's point of view, to avoid account enumeration. */
export async function requestPasswordReset(email: string, client: ClientInfo) {
  const user = await User.findOne({ email: email.toLowerCase().trim(), status: 'ACTIVE' });
  if (!user) return;
  const token = randomToken(32);
  user.set('resetTokenHash', sha256(token));
  user.set('resetTokenExpiresAt', new Date(Date.now() + RESET_TTL_MS));
  await user.save();
  await enqueueEmail(user.email, 'Reset your Northern IEBC password', [
    `A password reset was requested for your account.`,
    `Open this link within 30 minutes to choose a new password:`,
    `${env.PUBLIC_BASE_URL}/reset-password?token=${token}`,
    ``,
    `If you did not request this, ignore this email and tell your administrator.`
  ].join('\n'));
  await recordAuditStandalone({ actor: { id: String(user._id), role: user.role, ip: client.ip }, action: 'auth.password_reset_requested', entityType: 'User', entityId: String(user._id) });
}

export async function resetPassword(token: string, next: string, client: ClientInfo) {
  const user = await User.findOne({ resetTokenHash: sha256(token), resetTokenExpiresAt: { $gt: new Date() } }).select('+resetTokenHash');
  if (!user) throw badRequest('Reset link is invalid or has expired');
  const problems = passwordProblems(next, [user.fullName, user.email.split('@')[0]!]);
  if (problems.length) throw badRequest('Weak password', problems);
  user.passwordHash = await hashPassword(next);
  user.passwordChangedAt = new Date();
  user.mustChangePassword = false;
  user.set('resetTokenHash', undefined);
  user.set('resetTokenExpiresAt', undefined);
  user.failedLoginCount = 0;
  user.lockedUntil = undefined;
  await user.save();
  await revokeAllSessions(String(user._id), 'password_reset');
  await recordAuditStandalone({ actor: { id: String(user._id), role: user.role, ip: client.ip }, action: 'auth.password_reset', entityType: 'User', entityId: String(user._id) });
}
