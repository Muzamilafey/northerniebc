import { useEffect, useRef, useState } from 'react';

/** Live countdown such as "2h 05m 09s"; calls onDone once when it reaches zero. */
export function Countdown({ to, clockOffsetMs = 0, onDone }: { to: string; clockOffsetMs?: number; onDone?: () => void }) {
  const [now, setNow] = useState(() => Date.now() + clockOffsetMs);
  const fired = useRef(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + clockOffsetMs), 1000);
    return () => clearInterval(t);
  }, [clockOffsetMs]);
  const left = Math.max(0, new Date(to).getTime() - now);
  useEffect(() => {
    if (left === 0 && !fired.current) {
      fired.current = true;
      onDone?.();
    }
  }, [left, onDone]);
  const sec = Math.floor(left / 1000);
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), ss = sec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return <span className="font-mono tabular-nums">{d > 0 ? `${d}d ` : ''}{d > 0 || h > 0 ? `${h}h ` : ''}{pad(m)}m {pad(ss)}s</span>;
}
