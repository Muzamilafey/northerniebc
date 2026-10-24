import { openDB, type IDBPDatabase } from 'idb';
import { ApiError, api } from './api';
import { toPayload, type Draft } from './draft';

interface Schema {
  drafts: { key: string; value: Draft; indexes: { byState: string } };
  meta: { key: string; value: unknown };
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null;
export function db() {
  dbp ??= openDB<Schema>('nie-agent', 1, {
    upgrade(d) {
      const s = d.createObjectStore('drafts', { keyPath: 'key' });
      s.createIndex('byState', 'state');
      d.createObjectStore('meta');
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
    const queued = (await allDrafts()).filter((d) => d.state === 'QUEUED' || d.state === 'SYNCING').sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0));
    for (let d of queued) {
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
        if (e instanceof ApiError && e.status === 409 && (e.details as { serverRevision?: number | null })?.serverRevision !== undefined) {
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
    void syncNow();
  });
  window.addEventListener('offline', () => {
    status = 'OFFLINE';
    void emit();
  });
}
