import { logger } from '../lib/logger.js';
import { processOutboxBatch } from './outboxWorker.js';
import { processNotificationBatch } from '../modules/notifications/service.js';
import { processPendingDonations } from '../modules/donations/service.js';
import { sealAuditChain } from '../lib/audit.js';

interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
}

const jobs: Job[] = [
  { name: 'outbox', everyMs: 500, run: () => processOutboxBatch() },
  { name: 'audit-seal', everyMs: 1000, run: () => sealAuditChain() },
  { name: 'notifications', everyMs: 5000, run: () => processNotificationBatch() },
  { name: 'donation-timeouts', everyMs: 60_000, run: () => processPendingDonations() }
];

const timers: NodeJS.Timeout[] = [];
const running = new Set<Promise<unknown>>();
let stopped = false;

/** Simple in-process scheduler. Each job is non-overlapping; all claims are atomic so several instances may run. */
export function startJobs() {
  stopped = false;
  for (const job of jobs) {
    let busy = false;
    const tick = async () => {
      if (busy || stopped) return;
      busy = true;
      const p = job.run().catch((err) => logger.error({ err, job: job.name }, 'Background job failed'));
      running.add(p);
      await p;
      running.delete(p);
      busy = false;
    };
    timers.push(setInterval(tick, job.everyMs));
  }
  logger.info('Background jobs started');
}

export async function stopJobs() {
  stopped = true;
  timers.splice(0).forEach(clearInterval);
  await Promise.allSettled([...running]);
}
