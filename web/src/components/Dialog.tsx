import { createContext, useContext, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';

type Tone = 'primary' | 'accent' | 'danger';
const TONE_BUTTON: Record<Tone, string> = { primary: 'btn-primary', accent: 'btn-accent', danger: 'btn-danger' };
const TONE_ICON: Record<Tone, { bg: string; path: string }> = {
  primary: { bg: 'bg-navy-50 text-navy-700', path: 'M12 8v4m0 4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z' },
  accent: { bg: 'bg-brand-50 text-brand-700', path: 'M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z' },
  danger: { bg: 'bg-red-50 text-red-700', path: 'M12 9v3.75m0 3.75h.008M10.3 3.86 1.82 18a1.98 1.98 0 0 0 1.7 3h16.96a1.98 1.98 0 0 0 1.7-3L13.7 3.86a1.98 1.98 0 0 0-3.4 0Z' }
};

/**
 * Accessible modal: labelled, focus moves in and is kept inside, Escape or the backdrop cancels,
 * page scrolling is paused, and focus returns to the control that opened it.
 */
export function Modal({ title, description, tone = 'primary', icon = true, onClose, children, size = 'md' }: { title: string; description?: ReactNode; tone?: Tone; icon?: boolean; onClose: () => void; children: ReactNode; size?: 'md' | 'lg' }) {
  const titleId = useId();
  const descId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = panel.current?.querySelector<HTMLElement>('[autofocus], input:not([type=hidden]), textarea, select') ?? panel.current?.querySelector<HTMLElement>('button');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close.current();
      } else if (e.key === 'Tab' && panel.current) {
        const items = [...panel.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute('disabled'));
        if (!items.length) return;
        const [a, z] = [items[0]!, items[items.length - 1]!];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
        else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, []);

  return (
    <div className="animate-backdrop fixed inset-0 z-50 flex items-end justify-center bg-navy-900/50 p-3 backdrop-blur-[2px] sm:items-center sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descId : undefined} className={`animate-dialog w-full ${size === 'lg' ? 'max-w-2xl' : 'max-w-md'} max-h-[90vh] overflow-y-auto rounded-2xl bg-white shadow-2xl ring-1 ring-black/5`}>
        <div className="flex items-start gap-3 p-5 pb-0">
          {icon && (
            <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${TONE_ICON[tone].bg}`} aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5"><path d={TONE_ICON[tone].path} /></svg>
            </span>
          )}
          <div className="min-w-0 flex-1 pt-1">
            <h2 id={titleId} className="text-lg font-bold leading-snug text-navy-900">{title}</h2>
            {description && <div id={descId} className="mt-1 text-sm text-gray-600">{description}</div>}
          </div>
          <button type="button" onClick={onClose} className="-mr-1 -mt-1 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-5 w-5" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/** Footer with Cancel + main action; full-width buttons on phones. */
export function ModalActions({ onCancel, confirmLabel, tone = 'primary', busy, submit = true, cancelLabel = 'Cancel' }: { onCancel: () => void; confirmLabel: string; tone?: Tone; busy?: boolean; submit?: boolean; cancelLabel?: string }) {
  return (
    <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <button type="button" className="btn-outline sm:min-w-24" onClick={onCancel}>{cancelLabel}</button>
      <button type={submit ? 'submit' : 'button'} className={`${TONE_BUTTON[tone]} sm:min-w-24`} disabled={busy}>{busy ? 'Working…' : confirmLabel}</button>
    </div>
  );
}

export interface DialogField {
  name: string;
  label: string;
  type?: 'text' | 'textarea' | 'number' | 'select';
  defaultValue?: string;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  step?: string;
  options?: { value: string; label: string }[];
}
interface BaseOptions { title: string; message?: ReactNode; confirmLabel?: string; cancelLabel?: string; tone?: Tone }
export interface FormOptions extends BaseOptions { fields: DialogField[] }
export interface PromptOptions extends BaseOptions, Omit<DialogField, 'name'> {}

interface DialogApi {
  /** Yes/no question. Resolves true only when confirmed. */
  confirm: (o: BaseOptions) => Promise<boolean>;
  /** One answer. Resolves the trimmed text, or null when cancelled. */
  prompt: (o: PromptOptions) => Promise<string | null>;
  /** Several answers. Resolves the trimmed values by field name, or null when cancelled. */
  form: (o: FormOptions) => Promise<Record<string, string> | null>;
}

const Ctx = createContext<DialogApi | null>(null);

type Pending = { id: number } & ({ kind: 'confirm'; o: BaseOptions; resolve: (v: boolean) => void } | { kind: 'form'; o: FormOptions; resolve: (v: Record<string, string> | null) => void });
let nextId = 0;

export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([]);
  const api = useRef<DialogApi | null>(null);
  if (!api.current) {
    const push = (p: Pending) => setQueue((q) => [...q, p]);
    const form = (o: FormOptions) => new Promise<Record<string, string> | null>((resolve) => push({ id: ++nextId, kind: 'form', o, resolve }));
    api.current = {
      confirm: (o) => new Promise<boolean>((resolve) => push({ id: ++nextId, kind: 'confirm', o, resolve })),
      form,
      prompt: async ({ title, message, confirmLabel, cancelLabel, tone, ...field }) => {
        const r = await form({ title, message, confirmLabel, cancelLabel, tone, fields: [{ name: 'value', ...field }] });
        return r ? r.value! : null;
      }
    };
  }
  const current = queue[0];
  const done = (fn: () => void) => {
    fn();
    setQueue((q) => q.slice(1));
  };
  return (
    <Ctx.Provider value={api.current}>
      {children}
      {current?.kind === 'confirm' && (
        <Modal key={current.id} title={current.o.title} description={current.o.message} tone={current.o.tone} onClose={() => done(() => current.resolve(false))}>
          <form onSubmit={(e) => { e.preventDefault(); done(() => current.resolve(true)); }}>
            <ModalActions onCancel={() => done(() => current.resolve(false))} confirmLabel={current.o.confirmLabel ?? 'Confirm'} cancelLabel={current.o.cancelLabel} tone={current.o.tone} />
          </form>
        </Modal>
      )}
      {current?.kind === 'form' && <FormDialog key={current.id} o={current.o} onDone={(v) => done(() => current.resolve(v))} />}
    </Ctx.Provider>
  );
}

function FormDialog({ o, onDone }: { o: FormOptions; onDone: (v: Record<string, string> | null) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(o.fields.map((f) => [f.name, f.defaultValue ?? ''])));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onDone(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()])));
  };
  return (
    <Modal title={o.title} description={o.message} tone={o.tone} icon={false} onClose={() => onDone(null)}>
      <form onSubmit={submit} className="space-y-4">
        {o.fields.map((f, i) => {
          const common = {
            id: `dlg-${f.name}`,
            className: 'input',
            value: values[f.name] ?? '',
            required: f.required ?? true,
            placeholder: f.placeholder,
            autoFocus: i === 0,
            'aria-describedby': f.hint ? `dlg-${f.name}-hint` : undefined,
            onChange: (e: { target: { value: string } }) => setValues((v) => ({ ...v, [f.name]: e.target.value }))
          };
          return (
            <div key={f.name}>
              <label htmlFor={common.id} className="label">{f.label}</label>
              {f.type === 'textarea' ? (
                <textarea {...common} rows={3} minLength={f.minLength} maxLength={f.maxLength} />
              ) : f.type === 'select' ? (
                <select {...common}>{f.options?.map((op) => <option key={op.value} value={op.value}>{op.label}</option>)}</select>
              ) : (
                <input {...common} type={f.type ?? 'text'} minLength={f.minLength} maxLength={f.maxLength} min={f.min} max={f.max} step={f.step} inputMode={f.type === 'number' ? 'decimal' : undefined} />
              )}
              {f.hint && <p id={`dlg-${f.name}-hint`} className="mt-1 text-xs text-gray-500">{f.hint}</p>}
            </div>
          );
        })}
        <ModalActions onCancel={() => onDone(null)} confirmLabel={o.confirmLabel ?? 'Save'} cancelLabel={o.cancelLabel} tone={o.tone} />
      </form>
    </Modal>
  );
}

export function useDialog(): DialogApi {
  const d = useContext(Ctx);
  if (!d) throw new Error('useDialog must be used inside <DialogProvider>');
  return d;
}
