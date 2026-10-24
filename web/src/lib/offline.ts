import { openDB, type IDBPDatabase } from 'idb';
import { ApiError, api } from './api';
import { toPayload, type Draft, type TallyEvent } from './draft';

export interface QueuedTally {
  countSessionId: string;
  seq: number;
  electionId: string;
  stationId: string;
  position: string;
  event: TallyEvent;
}

interface Schema {
  drafts: { key: string; value: Draft; indexes: { byState: string } };
  meta: { key: string; value: unknown };
  tally: { key: [string, number]; value: QueuedTally; indexes: { bySession: string } };
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null;
export function db() {
  dbp ??= openDB<Schema>('nie-agent', 2, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        const s = d.createObjectStore('drafts', { keyPath: 'key' });
        s.createIndex('byState', 'state');
        d.createObjectStore('meta');
      }
      if (oldVersion < 2) {
        const t = d.createObjectStore('tally', { keyPath: ['countSessionId', 'seq'] });
        t.createIndex('bySession', 'countSessionId');
      }
    }
  });
  return dbp;
}

export const getDraft = async (key: string) => (await db()).get('drafts', key);
export const saveDraft = async (d: Draft) => (await db()).put('drafts', d);
export const allDrafts = async () => (await db()).getAll('drafts');
export const deleteDraft = async (key: string) => (await db()).delete('drafts', key);
export const getMeta = async <T>(k: string) => (await (await db()).get('meta', k)) as T | undefined;
export const setMeta = async (k: string, v: unknown) => (await db()).put('meta', v, k);

export async function deviceId(): Promise<string> {
  let id = await getMeta<string>('deviceId');
  if (!id) {
    id = crypto.randomUUID();
    await setMeta('deviceId', id);
  }
  return id;
}

/** Saves a draft and, for live counts, queues its tap event for immediate sending. */
export async function saveChange(d: Draft, event?: TallyEvent) {
  const db_ = await db();
  const tx = db_.transaction(['drafts', 'tally'], 'readwrite');
  await tx.objectStore('drafts').put(d);
  if (event && d.countSessionId) {
    await tx.objectStore('tally').put({ countSessionId: d.countSessionId, seq: event.seq, electionId: d.electionId, stationId: d.stationId, position: d.position, event });
  }
  await tx.done;
  if (event) scheduleTallySend();
}

export interface TallyStatus {
  pending: number;
  recorded: Record<string, { lastSeq: number; tallies: Record<string, number>; flags: string[] }>;
  error?: string;
}
const tallyListeners = new Set<(s: TallyStatus) => void>();
let tallyStatus: TallyStatus = { pending: 0, recorded: {} };
export function onTally(l: (s: TallyStatus) => void) {
  tallyListeners.add(l);
  l(tallyStatus);
  return () => tallyListeners.delete(l);
}
function emitTally(patch: Partial<TallyStatus>) {
  tallyStatus = { ...tallyStatus, ...patch };
  tallyListeners.forEach((l) => l(tallyStatus));
}

let tallyTimer: ReturnType<typeof setTimeout> | undefined;
let tallyInFlight: Promise<void> | null = null;
export function scheduleTallySend(delayMs = 250) {
  clearTimeout(tallyTimer);
  tallyTimer = setTimeout(() => void sendTallies(), delayMs);
}

/**
 * Sends queued tap events to the server in sequence order, per counting session. Events are
 * removed from the phone only after the server confirms them; a sequence gap reported by the
 * server is answered by resending from the expected number.
 */
export function sendTallies(): Promise<void> {
  // Callers share one in-flight send, so awaiting this always means "taps uploaded as far as possible".
  tallyInFlight ??= doSendTallies().finally(() => {
    tallyInFlight = null;
  });
  return tallyInFlight;
}

async function doSendTallies(): Promise<void> {
  if (!navigator.onLine) {
    emitTally({ pending: (await (await db()).count('tally')) });
    return;
  }
  try {
    const all = await (await db()).getAll('tally');
    const sessions = [...new Set(all.map((t) => t.countSessionId))];
    for (const sid of sessions) {
      const items = all.filter((t) => t.countSessionId === sid).sort((a, b) => a.seq - b.seq);
      const first = items[0]!;
      try {
        const r = await api<{ lastSeq: number; tallies: Record<string, number>; flags: string[] }>('/agent/tally-events', {
          body: { clientSessionId: sid, electionId: first.electionId, pollingStationId: first.stationId, position: first.position, events: items.map((i) => i.event) }
        });
        const tx = (await db()).transaction('tally', 'readwrite');
        for (const i of items) if (i.seq <= r.lastSeq) await tx.store.delete([sid, i.seq]);
        await tx.done;
        emitTally({ recorded: { ...tallyStatus.recorded, [sid]: r }, error: undefined });
      } catch (e) {
        emitTally({ error: e instanceof Error ? e.message : 'Could not record taps' });
        if (!(e instanceof ApiError) || e.status >= 500 || e.status === 401) break; // retry later
      }
    }
  } finally {
    emitTally({ pending: await (await db()).count('tally') });
    if (tallyStatus.pending > 0 && navigator.onLine) scheduleTallySend(5000);
  }
}

export type SyncStatus = 'ONLINE' | 'OFFLINE' | 'SYNCING' | 'SYNCED' | 'SYNC_FAILED';
type Listener = (s: { status: SyncStatus; lastSyncAt?: number; pending: number }) => void;
const listeners = new Set<Listener>();
let running = false;
let status: SyncStatus = typeof navigator !== 'undefined' && !navigator.onLine ? 'OFFLINE' : 'ONLINE';

async function emit() {
  const drafts = await allDrafts();
  const pending = drafts.filter((d) => d.state === 'QUEUED' || d.state === 'SYNCING').length;
  const lastSyncAt = await getMeta<number>('lastSyncAt');
  listeners.forEach((l) => l({ status, lastSyncAt, pending }));
}
export function onSync(l: Listener) {
  listeners.add(l);
  void emit();
  return () => listeners.delete(l);
}

/**
 * Sends queued submissions in the order they were queued. A draft is marked SYNCED only after
 * the server returns a receipt. Network failures stop the run (preserving order) and leave items
 * queued with the same idempotency key; server conflicts require explicit resolution.
 */
export async function syncNow(): Promise<void> {
  if (running) return;
  if (!navigator.onLine) {
    status = 'OFFLINE';
    return emit();
  }
  running = true;
  status = 'SYNCING';
  await emit();
  let failed = false;
  try {
    const dev = await deviceId();
    await sendTallies();
    const queued = (await allDrafts()).filter((d) => d.state === 'QUEUED' || d.state === 'SYNCING').sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0));
    for (let d of queued) {
      // A result is never sent ahead of the live taps it was counted from.
      if (d.countSessionId && (await (await db()).countFromIndex('tally', 'bySession', d.countSessionId)) > 0) {
        await saveDraft({ ...d, state: 'QUEUED', lastError: 'Waiting for the live count to finish uploading' });
        failed = true;
        break;
      }
      d = { ...d, state: 'SYNCING', attempts: (d.attempts ?? 0) + 1 };
      await saveDraft(d);
      try {
        for (const ev of d.evidence) {
          if (ev.fileId || !ev.blob) continue;
          const form = new FormData();
          form.append('file', ev.blob, ev.name);
          const up = await api<{ fileId: string }>('/agent/evidence', { form });
          ev.fileId = up.fileId;
          ev.blob = undefined;
          await saveDraft(d);
        }
        const r = await api<{ receipt: NonNullable<Draft['receipt']> }>('/agent/submissions', { body: toPayload(d, dev) });
        await saveDraft({ ...d, state: 'SYNCED', receipt: r.receipt, baseRevision: r.receipt.revision, idempotencyKey: undefined, queuedAt: undefined, history: [], lastError: undefined, updatedAt: Date.now() });
        await setMeta('lastSyncAt', Date.now());
      } catch (e) {
        if (e instanceof ApiError && e.code === 'STEP_UP_REQUIRED') {
          // Never sent without the agent's explicit password confirmation.
          await saveDraft({ ...d, state: 'AWAITING_CONFIRMATION', lastError: e.message });
          failed = true;
        } else if (e instanceof ApiError && e.status === 409 && (e.details as { serverRevision?: number | null })?.serverRevision !== undefined) {
          await saveDraft({ ...d, state: 'CONFLICT', lastError: e.message, conflictServerRevision: (e.details as { serverRevision: number | null }).serverRevision });
        } else if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 408 && e.status !== 429) {
          await saveDraft({ ...d, state: 'FAILED', lastError: e.message, idempotencyKey: undefined, queuedAt: undefined });
          failed = true;
        } else {
          // Network/server/auth error: keep it queued with the same key and stop to preserve ordering.
          await saveDraft({ ...d, state: 'QUEUED', lastError: e instanceof Error ? e.message : 'Network error' });
          failed = true;
          break;
        }
      }
    }
  } finally {
    running = false;
    status = !navigator.onLine ? 'OFFLINE' : failed ? 'SYNC_FAILED' : 'SYNCED';
    await emit();
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    status = 'ONLINE';
    void sendTallies();
    void syncNow();
  });
  window.addEventListener('offline', () => {
    status = 'OFFLINE';
    void emit();
  });
}
