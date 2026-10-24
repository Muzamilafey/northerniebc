import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

let client: Redis | undefined;

/** Optional Redis connection, used for the Socket.IO adapter, rate limiting and caching. */
export function getRedis(): Redis | undefined {
  if (!env.REDIS_URL) return undefined;
  if (!client) {
    client = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, enableOfflineQueue: true });
    client.on('error', (err) => logger.warn({ err: err.message }, 'Redis error'));
  }
  return client;
}

export async function closeRedis() {
  if (client) {
    await client.quit().catch(() => undefined);
    client = undefined;
  }
}
