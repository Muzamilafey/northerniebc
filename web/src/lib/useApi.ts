import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

/** Fetch hook with loading / error / data states and manual reload. */
export function useApi<T>(path: string | null, query?: Record<string, string | number | boolean | undefined | null>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const key = path ? `${path}|${JSON.stringify(query ?? {})}` : null;
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const d = await api<T>(path, { query });
      if (my === seq.current) setData(d);
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
  return { data, error, loading, reload: load, setData };
}
