import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { isProd } from '../../config/env.js';
import { parse } from '../../lib/http.js';
import { requireAuth } from '../../middleware/auth.js';
import { csrfGuard, loginLimiter, limiter } from '../../middleware/security.js';
import { Session, User } from '../../models/identity.js';
import { notFound } from '../../lib/errors.js';
import * as auth from './service.js';
import { recordAuditStandalone } from '../../lib/audit.js';

const COOKIE = 'nie_rt';
const COOKIE_PATH = '/api/auth';

function setRefreshCookie(res: Response, value: string, expires: Date) {
  res.cookie(COOKIE, value, { httpOnly: true, secure: isProd, sameSite: 'strict', path: COOKIE_PATH, expires });
}

const client = (req: Request) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

function sendSession(res: Response, s: auth.IssuedSession) {
  setRefreshCookie(res, s.refreshCookie, s.refreshExpiresAt);
  res.json({ accessToken: s.accessToken, user: s.user, mfaSetupRequired: s.mfaSetupRequired });
}

export function authRouter() {
  const r = Router();
  const loginLimit = loginLimiter();

  r.post('/login', loginLimit, async (req, res) => {
    const body = parse(z.object({ identifier: z.string().min(3).max(200), password: z.string().min(1).max(256) }), req.body);
    const result = await auth.login(body.identifier, body.password, client(req));
    if (result.kind === 'mfa') return res.json({ mfaRequired: true, mfaToken: result.mfaToken });
    sendSession(res, result.session);
  });

  r.post('/mfa/verify', loginLimit, async (req, res) => {
    const body = parse(z.object({ mfaToken: z.string().min(10), code: z.string().min(6).max(20) }), req.body);
    sendSession(res, await auth.verifyMfaLogin(body.mfaToken, body.code, client(req)));
  });

  r.post('/refresh', csrfGuard, limiter('refresh', { windowMs: 60_000, limit: 60 }), async (req, res) => {
    const s = await auth.refresh(req.cookies?.[COOKIE], client(req));
    sendSession(res, s);
  });

  r.post('/logout', csrfGuard, async (req, res) => {
    const cookie: string | undefined = req.cookies?.[COOKIE];
    const familyId = cookie?.split('.')[0];
    if (familyId) await auth.revokeSession(familyId, 'logout');
    res.clearCookie(COOKIE, { path: COOKIE_PATH });
    res.status(204).end();
  });

  r.get('/me', requireAuth, async (req, res) => {
    const u = await User.findById(req.user!.id).lean();
    if (!u) throw notFound();
    res.json({ user: auth.toPublicUser(u), mfaVerified: req.user!.mfa });
  });

  r.post('/mfa/setup', requireAuth, async (req, res) => {
    const s = await auth.beginMfaSetup(req.user!.id);
    res.json({ otpauth: s.otpauth, qrDataUrl: s.qrDataUrl, secret: s.secret });
  });

  r.post('/mfa/enable', requireAuth, async (req, res) => {
    const body = parse(z.object({ code: z.string().min(6).max(8) }), req.body);
    res.json(await auth.enableMfa(req.user!.id, req.user!.sessionId, body.code, client(req)));
  });

  r.post('/password/change', requireAuth, async (req, res) => {
    const body = parse(z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256) }), req.body);
    await auth.changePassword(req.user!.id, body.currentPassword, body.newPassword, client(req), req.user!.sessionId);
    res.status(204).end();
  });

  r.post('/password/forgot', limiter('forgot', { windowMs: 60 * 60_000, limit: 5 }), async (req, res) => {
    const body = parse(z.object({ email: z.string().email().max(200) }), req.body);
    await auth.requestPasswordReset(body.email, client(req));
    res.json({ message: 'If an account exists for that email, a reset link has been sent.' });
  });

  r.post('/password/reset', limiter('reset', { windowMs: 60 * 60_000, limit: 10 }), async (req, res) => {
    const body = parse(z.object({ token: z.string().min(20).max(100), newPassword: z.string().min(1).max(256) }), req.body);
    await auth.resetPassword(body.token, body.newPassword, client(req));
    res.status(204).end();
  });

  r.get('/sessions', requireAuth, async (req, res) => {
    const sessions = await Session.find({ userId: req.user!.id, revokedAt: null, expiresAt: { $gt: new Date() } })
      .select('familyId userAgent ip lastUsedAt createdAt expiresAt mfaVerified')
      .sort({ lastUsedAt: -1 })
      .lean();
    res.json({ sessions: sessions.map((s) => ({ ...s, current: s.familyId === req.user!.sessionId })) });
  });

  r.delete('/sessions/:familyId', requireAuth, async (req, res) => {
    const s = await Session.findOne({ familyId: String(req.params.familyId), userId: req.user!.id });
    if (!s) throw notFound();
    await auth.revokeSession(s.familyId, 'user_revoked');
    await recordAuditStandalone({ actor: { id: req.user!.id, role: req.user!.role, ip: req.ip }, action: 'auth.session_revoked', entityType: 'Session', entityId: s.familyId });
    res.status(204).end();
  });

  return r;
}
