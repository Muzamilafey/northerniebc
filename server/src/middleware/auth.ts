import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { can, type Permission } from '../lib/permissions.js';
import { PRIVILEGED_ROLES, Session, User, type Role } from '../models/identity.js';
import type { AuthUser } from '../types/express.js';

export interface AccessClaims {
  sub: string;
  sid: string;
  mfa: boolean;
  typ: 'access';
}

export function signAccessToken(claims: Omit<AccessClaims, 'typ'>): string {
  return jwt.sign({ ...claims, typ: 'access' }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    algorithm: 'HS256',
    issuer: 'northern-iebc'
  });
}

/**
 * Resolves the user from a bearer token. The role and scope are loaded from the
 * database on each request, and the session must still be active, so suspension and
 * session revocation take effect immediately.
 */
export async function resolveUser(token: string): Promise<AuthUser | null> {
  let claims: AccessClaims;
  try {
    claims = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: 'northern-iebc' }) as AccessClaims;
  } catch {
    return null;
  }
  if (claims.typ !== 'access') return null;
  const [user, session] = await Promise.all([
    User.findById(claims.sub).lean(),
    Session.findOne({ familyId: claims.sid, userId: claims.sub, revokedAt: null }).lean()
  ]);
  if (!user || user.status !== 'ACTIVE' || !session || session.expiresAt < new Date()) return null;
  return {
    id: String(user._id),
    role: user.role as Role,
    fullName: user.fullName,
    sessionId: claims.sid,
    mfa: Boolean(claims.mfa && session.mfaVerified),
    scope: {
      countyIds: (user.scope?.countyIds ?? []).map(String),
      constituencyIds: (user.scope?.constituencyIds ?? []).map(String)
    }
  };
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) {
    const u = await resolveUser(h.slice(7));
    if (u) req.user = u;
  }
  next();
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return next(unauthorized());
  const u = await resolveUser(h.slice(7));
  if (!u) return next(unauthorized('Session expired or revoked'));
  req.user = u;
  next();
}

export function mfaSatisfied(user: AuthUser): boolean {
  if (!env.REQUIRE_MFA_FOR_PRIVILEGED) return true;
  if (!PRIVILEGED_ROLES.includes(user.role)) return true;
  return user.mfa;
}

/** requireAuth + permission check + MFA enforcement for privileged roles, as a single handler. */
export function requirePermission(...perms: Permission[]): RequestHandler {
  return (req, res, next) => {
    void requireAuth(req, res, (err?: unknown) => {
      if (err) return next(err);
      const user = req.user!;
      if (!perms.some((p) => can(user, p))) return next(forbidden());
      if (!mfaSatisfied(user)) return next(forbidden('Multi-factor authentication is required for this account'));
      next();
    }).catch(next);
  };
}
