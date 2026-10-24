import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { corsOrigins } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { can } from '../lib/permissions.js';
import { mfaSatisfied, resolveUser } from '../middleware/auth.js';
import { getRedis } from './redis.js';
import type { AuthUser } from '../types/express.js';

let io: Server | undefined;

/**
 * Real-time channel. Public clients only receive "something changed" pings and re-fetch
 * through the public API, so unpublished figures never travel over public sockets.
 * Authorised monitors join rooms limited to their geographic scope.
 */
export function initSocket(server: HttpServer): Server {
  io = new Server(server, {
    path: '/socket.io',
    cors: { origin: corsOrigins, credentials: false },
    serveClient: false,
    maxHttpBufferSize: 10_000
  });
  const redis = getRedis();
  if (redis) io.adapter(createAdapter(redis, redis.duplicate()));

  io.use(async (socket, next) => {
    const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
    if (token) {
      const user = await resolveUser(token).catch(() => null);
      if (user) socket.data.user = user;
    }
    next();
  });

  io.on('connection', (socket) => {
    const user = socket.data.user as AuthUser | undefined;
    socket.on('subscribe', (msg: unknown) => {
      const electionId = typeof (msg as { electionId?: unknown })?.electionId === 'string' ? (msg as { electionId: string }).electionId : null;
      if (!electionId || !/^[a-f0-9]{24}$/i.test(electionId)) return;
      socket.join(`public:election:${electionId}`);
      if (user && can(user, 'results.monitor') && mfaSatisfied(user)) {
        if (user.role === 'SUPER_ADMIN' || user.role === 'REGIONAL_ADMIN' || ((user.role === 'VERIFICATION_OFFICER') && user.scope.countyIds.length === 0)) {
          socket.join(`admin:${electionId}:all`);
        } else {
          for (const c of user.scope.countyIds) socket.join(`admin:${electionId}:county:${c}`);
          for (const c of user.scope.constituencyIds) socket.join(`admin:${electionId}:constituency:${c}`);
        }
      }
    });
    socket.on('subscribe:donations', () => socket.join('public:donations'));
  });
  logger.info('Socket.IO initialised');
  return io;
}

export function getIo(): Server | undefined {
  return io;
}

export async function closeSocket() {
  if (io) {
    await new Promise<void>((resolve) => io!.close(() => resolve()));
    io = undefined;
  }
}
