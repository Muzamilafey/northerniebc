import { useRef, useState } from 'react';
import { uploadImage } from '../lib/upload';
import { useDialog } from './Dialog';

/** Add, change or remove a logo/photo. Uploads first, then hands the new file id (or null) to onSave. */
export function LogoEditor({ fileId, purpose, label, onSave }: { fileId?: string | null; purpose: 'PARTY_LOGO' | 'COUNTY_LOGO' | 'CANDIDATE_PHOTO'; label: string; onSave: (fileId: string | null) => Promise<void> }) {
  const dialog = useDialog();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const run = async (fn: () => Promise<void>) => {
    setErr('');
    setBusy(true);
    try {
      await fn();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div className="mt-1 text-xs">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-outline px-2 py-1 text-xs" disabled={busy} onClick={() => input.current?.click()} aria-label={`${fileId ? 'Change' : 'Add'} ${label}`}>
          {busy ? 'Uploading…' : fileId ? 'Change logo' : 'Add logo'}
        </button>
        {fileId && (
          <button type="button" className="link" disabled={busy} onClick={async () => { if (await dialog.confirm({ title: `Remove the ${label}?`, message: 'The image stops showing on the public pages. You can add a new one at any time.', confirmLabel: 'Remove', tone: 'danger' })) void run(() => onSave(null)); }}>
            Remove
          </button>
        )}
      </div>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void run(async () => onSave(await uploadImage(purpose, f))); }} />
      {err && <p role="alert" className="mt-1 text-red-700">{err}</p>}
    </div>
  );
}
