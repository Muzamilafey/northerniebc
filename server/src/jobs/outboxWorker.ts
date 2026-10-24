import { OutboxEvent } from '../models/system.js';
import { invalidatePrefix } from '../lib/cache.js';
import { logger } from '../lib/logger.js';
import { getIo } from '../realtime/socket.js';

type Payload = Record<string, string | number | undefined>;

async function handle(type: string, p: Payload) {
  const io = getIo();
  switch (type) {
    case 'results.submission':
    case 'results.verification':
    case 'results.station_result_changed': {
      invalidatePrefix(`tally:${p.electionId}`);
      io?.to(`public:election:${p.electionId}`).emit('results:updated', { electionId: p.electionId, position: p.position ?? null });
      const detail = { type, ...p };
      io?.to(`admin:${p.electionId}:all`).emit('admin:results', detail);
      if (p.countyId) io?.to(`admin:${p.electionId}:county:${p.countyId}`).emit('admin:results', detail);
      if (p.constituencyId) io?.to(`admin:${p.electionId}:constituency:${p.constituencyId}`).emit('admin:results', detail);
      break;
    }
    case 'donation.confirmed':
    case 'donation.status_changed':
      invalidatePrefix('donations:');
      io?.to('public:donations').emit('donations:updated', {});
      break;
    case 'finance.published':
    case 'projects.published':
    case 'accountability.published':
      invalidatePrefix('public:');
      break;
    default:
      break;
  }
}

/** Claims and processes outbox events. Safe with multiple workers (atomic claim with lease). */
export async function processOutboxBatch(limit = 100): Promise<number> {
  let n = 0;
  for (let i = 0; i < limit; i++) {
    const now = new Date();
    const ev = await OutboxEvent.findOneAndUpdate(
      { $or: [{ status: 'PENDING', availableAt: { $lte: now } }, { status: 'PROCESSING', lockedUntil: { $lt: now } }] },
      { $set: { status: 'PROCESSING', lockedUntil: new Date(now.getTime() + 30_000) }, $inc: { attempts: 1 } },
      { sort: { createdAt: 1 }, new: true }
    ).lean();
    if (!ev) break;
    n++;
    try {
      await handle(ev.type, ev.payload as Payload);
      await OutboxEvent.updateOne({ _id: ev._id }, { $set: { status: 'DONE', processedAt: new Date() }, $unset: { lockedUntil: 1 } });
    } catch (err) {
      const failed = ev.attempts >= 10;
      await OutboxEvent.updateOne(
        { _id: ev._id },
        { $set: { status: failed ? 'FAILED' : 'PENDING', lastError: (err as Error).message, availableAt: new Date(Date.now() + 2 ** Math.min(ev.attempts, 8) * 1000) } }
      );
      logger.error({ err, type: ev.type }, 'Outbox event failed');
    }
  }
  return n;
}
