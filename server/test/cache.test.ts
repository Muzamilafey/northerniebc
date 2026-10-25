import { describe, expect, it } from 'vitest';
import { cached, clearCache } from '../src/lib/cache.js';

describe('results cache', () => {
  it('shares one computation between simultaneous requests and expires after its TTL', async () => {
    clearCache();
    let calls = 0;
    const slow = () => new Promise<number>((r) => setTimeout(() => r(++calls), 30));
    const all = await Promise.all(Array.from({ length: 50 }, () => cached('k', 1000, slow)));
    expect(new Set(all)).toEqual(new Set([1]));
    expect(calls).toBe(1);
    expect(await cached('k', 1000, slow)).toBe(1);
    await new Promise((r) => setTimeout(r, 1050));
    expect(await cached('k', 1000, slow)).toBe(2);
  });

  it('does not cache failures', async () => {
    clearCache();
    await expect(cached('bad', 1000, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await cached('bad', 1000, async () => 'ok')).toBe('ok');
  });
});
