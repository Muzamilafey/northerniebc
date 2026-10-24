import { Router } from 'express';
import mongoose from 'mongoose';
import { getRedis } from '../../realtime/redis.js';
import { OutboxEvent } from '../../models/index.js';

export function healthRouter() {
  const r = Router();
  r.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  r.get('/readyz', async (_req, res) => {
    const checks: Record<string, string> = {};
    try {
      await mongoose.connection.db!.admin().ping();
      checks.mongo = 'ok';
    } catch {
      checks.mongo = 'down';
    }
    const redis = getRedis();
    if (redis) checks.redis = await redis.ping().then(() => 'ok').catch(() => 'down');
    const backlog = await OutboxEvent.countDocuments({ status: { $in: ['PENDING', 'FAILED'] } }).catch(() => -1);
    checks.outboxBacklog = String(backlog);
    const ok = checks.mongo === 'ok' && checks.redis !== 'down';
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'degraded', checks });
  });
  return r;
}
