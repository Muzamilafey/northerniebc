import { useEffect, useId, useRef, useState } from 'react';

export interface MenuItem { label: string; onSelect: () => void; danger?: boolean; hidden?: boolean }

/** "More actions" dropdown: keyboard operable, closes on Escape, outside click or selection. */
export function Menu({ items, label = 'More actions' }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number; up: boolean }>({ top: 0, right: 0, up: false });
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const visible = items.filter((i) => !i.hidden);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        root.current?.querySelector<HTMLButtonElement>('button')?.focus();
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const els = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? [])];
        const i = els.indexOf(document.activeElement as HTMLButtonElement);
        els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length]?.focus();
      }
    };
    const close = () => setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    root.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  if (!visible.length) return null;
  return (
    <div ref={root} className="relative inline-block text-left">
      <button type="button" className="btn-outline btn-sm" aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); const up = window.innerHeight - r.bottom < 260; setPos({ top: up ? r.top - 4 : r.bottom + 4, right: window.innerWidth - r.right, up }); setOpen(!open); }} aria-label={label} title={label}>
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true"><path d="M3 10a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Zm5.5 0a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Zm5.5 0a1.5 1.5 0 1 1 3 0 1.5 1.5 0 0 1-3 0Z" /></svg>
      </button>
      {open && (
        <div id={id} role="menu" style={{ position: 'fixed', top: pos.top, right: pos.right, transform: pos.up ? 'translateY(-100%)' : undefined }} className="z-50 w-52 overflow-hidden rounded-xl border border-gray-200 bg-white py-1 shadow-lg">
          {visible.map((i) => (
            <button
              key={i.label}
              type="button"
              role="menuitem"
              className={`block w-full px-3 py-2 text-left text-sm hover:bg-gray-50 focus:bg-gray-50 focus:outline-none ${i.danger ? 'text-red-700' : 'text-gray-800'}`}
              onClick={() => {
                setOpen(false);
                i.onSelect();
              }}
            >
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
