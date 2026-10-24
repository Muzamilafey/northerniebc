import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { isProd } from '../config/env.js';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  const e = err as { type?: string; status?: number; code?: number | string; message?: string };
  if (e?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request too large' } });
  if (e?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON' } });
  if (e?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'File too large' } });
  if (err instanceof mongoose.Error.CastError) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: `Invalid ${err.path}` } });
  if (err instanceof mongoose.Error.ValidationError) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Validation failed', details: Object.values(err.errors).map((x) => ({ path: x.path, message: x.message })) } });
  }
  if (e?.code === 11000) return res.status(409).json({ error: { code: 'CONFLICT', message: 'Duplicate record' } });
  if (err instanceof mongoose.Error.VersionError) return res.status(409).json({ error: { code: 'CONFLICT', message: 'Record was modified concurrently; reload and retry' } });
  logger.error({ err, path: req.path, requestId: req.requestId }, 'Unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error', requestId: req.requestId, ...(isProd ? {} : { debug: e?.message }) } });
}
