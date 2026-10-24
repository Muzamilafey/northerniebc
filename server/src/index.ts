import http from 'node:http';
import { env } from './config/env.js';
import { connectMongo, disconnectMongo } from './db/mongo.js';
import { startJobs, stopJobs } from './jobs/scheduler.js';
import { logger } from './lib/logger.js';
import { closeRedis } from './realtime/redis.js';
import { closeSocket, initSocket } from './realtime/socket.js';
import { createApp } from './app.js';
import { loadSettings } from './modules/settings/service.js';

async function main() {
  await connectMongo();
  await loadSettings();
  setInterval(() => void loadSettings().catch(() => undefined), 30_000).unref();
  const app = createApp();
  const server = http.createServer(app);
  server.headersTimeout = 30_000;
  server.requestTimeout = 60_000;
  initSocket(server);
  if (env.RUN_WORKERS) startJobs();
  server.listen(env.PORT, () => logger.info({ port: env.PORT }, 'The Northern IEBC API listening'));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down gracefully');
    const force = setTimeout(() => process.exit(1), 25_000).unref();
    server.close();
    await closeSocket();
    await stopJobs();
    await closeRedis();
    await disconnectMongo();
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled rejection'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
