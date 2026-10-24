import type { NextFunction, Request, Response } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { badRequest, forbidden } from '../lib/errors.js';
import { corsOrigins, env, isTest } from '../config/env.js';
import { getRedis } from '../realtime/redis.js';
import { sha256 } from '../lib/crypto.js';

/**
 * Rejects object keys that start with "$" or contain "." anywhere in body or query.
 * Combined with zod validation this prevents NoSQL operator injection.
 */
export function rejectMongoOperators(req: Request, _res: Response, next: NextFunction) {
  const bad = (v: unknown, depth = 0): boolean => {
    if (depth > 20) return true;
    if (Array.isArray(v)) return v.some((x) => bad(x, depth + 1));
    if (v && typeof v === 'object') {
      return Object.entries(v as Record<string, unknown>).some(([k, val]) => k.includes('$') || k.includes('.') || bad(val, depth + 1));
    }
    return false;
  };
  if (bad(req.body) || bad(req.query)) return next(badRequest('Invalid characters in request keys'));
  next();
}

/**
 * Cookie-authenticated endpoints (refresh/logout) require a same-origin Origin header and a
 * custom header that cross-site forms cannot set. Bearer-token endpoints are not CSRF-prone.
 */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (origin && !corsOrigins.includes(origin)) return next(forbidden('Origin not allowed'));
  if (req.headers['x-requested-with'] !== 'XMLHttpRequest') return next(forbidden('Missing CSRF header'));
  next();
}

export function ipHash(req: Request): string {
  return sha256(`${req.ip ?? ''}|${env.BLIND_INDEX_KEY.slice(0, 8)}`).slice(0, 32);
}

export function limiter(name: string, opts: Partial<Options> & { windowMs: number; limit: number }) {
  const redis = getRedis();
  return rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => isTest && process.env.ENABLE_RATE_LIMIT_IN_TESTS !== '1',
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' } },
    ...(redis
      ? {
          store: new RedisStore({
            prefix: `rl:${name}:`,
            sendCommand: (...args: string[]) => redis.call(args[0]!, ...args.slice(1)) as never
          })
        }
      : {}),
    ...opts
  });
}

export const loginLimiter = () => limiter('login', { windowMs: 15 * 60_000, limit: 20 });
export const publicFormLimiter = () => limiter('public-form', { windowMs: 60 * 60_000, limit: 10 });
export const donationLimiter = () => limiter('donation', { windowMs: 15 * 60_000, limit: 10 });
export const apiLimiter = () => limiter('api', { windowMs: 60_000, limit: 600 });
