/** Tiny TTL cache for hot public read endpoints. Invalidated by outbox events. */
const store = new Map<string, { at: number; value: unknown }>();
const MAX = 2000;

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  if (store.size >= MAX) store.delete(store.keys().next().value!);
  store.set(key, { at: Date.now(), value });
  return value;
}

export function invalidatePrefix(prefix: string) {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}

export function clearCache() {
  store.clear();
}
