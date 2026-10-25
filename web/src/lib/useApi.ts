import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/**
 * Fetch hook with loading / error / data states and manual reload.
 * With `refreshMs`, it also refreshes silently on that interval: no loading flicker, no
 * overlapping requests, paused while the tab is hidden, and the last data is kept if a
 * refresh fails (`stale` is set until one succeeds).
 */
export function useApi<T>(path: string | null, query?: Record<string, string | number | boolean | undefined | null>, opts: { refreshMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [stale, setStale] = useState(false);
  const key = path ? `${path}|${JSON.stringify(query ?? {})}` : null;
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const d = await api<T>(path, { query });
      if (my === seq.current) {
        setData(d);
        setUpdatedAt(new Date());
        setStale(false);
      }
    } catch (e) {
      if (my === seq.current) setError(e as Error);
    } finally {
      if (my === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    void load();
  }, [load]);

  const refreshMs = opts.refreshMs;
  useEffect(() => {
    if (!path || !refreshMs) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      if (!document.hidden) {
        const my = seq.current;
        try {
          const d = await api<T>(path, { query });
          // Ignore the answer if the filters changed or a manual reload started meanwhile.
          if (!stopped && my === seq.current) {
            setData(d);
            setUpdatedAt(new Date());
            setStale(false);
            setError(null);
          }
        } catch {
          if (!stopped && my === seq.current) setStale(true);
        }
      }
      if (!stopped) timer = setTimeout(() => void tick(), refreshMs);
    };
    timer = setTimeout(() => void tick(), refreshMs);
    const onVisible = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshMs]);

  return { data, error, loading, reload: load, setData, updatedAt, stale };
}
