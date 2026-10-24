import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { badRequest } from './errors.js';

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest('Validation failed', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

export type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

export function pageParams(q: Record<string, unknown>, maxLimit = 100) {
  const page = Math.max(1, Number.parseInt(String(q.page ?? '1'), 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(String(q.limit ?? '25'), 10) || 25));
  return { page, limit, skip: (page - 1) * limit };
}

/** Escapes user input before using it inside a RegExp (prevents ReDoS / regex injection). */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
