import { useState, type FormEvent } from 'react';
import { LogoEditor } from '../../../components/LogoEditor';
import { Empty, ErrorBox, Field, PageHeader, PublicImage, Segmented, Success } from '../../../components/ui';
import { Modal, ModalActions } from '../../../components/Dialog';
import { Icon } from '../../../components/icons';
import { api } from '../../../lib/api';
import { uploadImage } from '../../../lib/upload';
import { useApi } from '../../../lib/useApi';
import { CatalogTabs, type Party } from './shared';

export default function Parties() {
  const list = useApi<{ items: Party[] }>('/admin/parties');
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setMsg({});
    try {
      const logo = f.get('logo') as File | null;
      const logoFileId = logo && logo.size > 0 ? await uploadImage('PARTY_LOGO', logo) : undefined;
      await api('/admin/parties', { body: { name: f.get('name'), abbreviation: f.get('abbreviation'), logoFileId, sourceReference: f.get('sourceReference') || undefined } });
      setAdding(false);
      setMsg({ ok: 'Party added.' });
      void list.reload();
    } catch (x) {
      setMsg({ err: (x as Error).message });
    }
  }
  const setLogo = async (p: Party, logoFileId: string | null) => {
    await api(`/admin/parties/${p._id}`, { method: 'PATCH', body: { logoFileId } });
    void list.reload();
  };
  const [q, setQ] = useState('');
  const shown = (list.data?.items ?? []).filter((p) => !q || `${p.name} ${p.abbreviation}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-4">
      <PageHeader title="Parties" subtitle="Registered political parties and their logos. Logos appear next to every aspirant of the party." actions={<button className="btn-accent" onClick={() => { setMsg({}); setAdding(true); }}><Icon name="plus" className="h-4 w-4" /> Add one party</button>} />
      <CatalogTabs />
      <RegisteredPartiesLoader onImported={() => void list.reload()} />
      {adding && (
        <Modal title="Add a party" icon={false} onClose={() => setAdding(false)}>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={add}>
            <div className="sm:col-span-2"><Field label="Party name"><input name="name" className="input" required minLength={2} autoFocus /></Field></div>
            <Field label="Abbreviation"><input name="abbreviation" className="input uppercase" required maxLength={20} /></Field>
            <Field label="Source" hint="e.g. ORPP register, month and year"><input name="sourceReference" className="input" /></Field>
            <div className="sm:col-span-2"><Field label="Logo (optional)" hint="JPEG, PNG or WebP, up to 2 MB."><input name="logo" type="file" accept="image/jpeg,image/png,image/webp" className="input" /></Field></div>
            {msg.err && <div className="sm:col-span-2"><ErrorBox error={msg.err} /></div>}
            <div className="sm:col-span-2"><ModalActions onCancel={() => setAdding(false)} confirmLabel="Add party" tone="accent" /></div>
          </form>
        </Modal>
      )}
      {msg.ok && <Success>{msg.ok}</Success>}
      {msg.err && !adding && <ErrorBox error={msg.err} />}
      {!!list.data?.items.length && (
        <div className="flex flex-wrap items-center gap-3">
          <input className="input max-w-xs" placeholder="Search parties" aria-label="Search parties" value={q} onChange={(e) => setQ(e.target.value)} />
          <p className="text-sm text-gray-600">{shown.length} of {list.data.items.length} parties · {list.data.items.filter((p) => !p.logoFileId).length} without a logo</p>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((p) => (
          <div key={p._id} className="card flex items-center gap-3">
            <PublicImage fileId={p.logoFileId} alt={`${p.name} logo`} size={56} fallback={p.abbreviation} />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{p.name}</p>
              <p className="text-xs text-gray-500">{p.abbreviation}{p.active ? '' : ' · inactive'}</p>
              <LogoEditor fileId={p.logoFileId} purpose="PARTY_LOGO" label={`${p.name} logo`} onSave={(id) => setLogo(p, id)} />
            </div>
          </div>
        ))}
      </div>
      {list.data?.items.length === 0 && <Empty title="No parties yet">Add the registered parties your aspirants belong to.</Empty>}
    </div>
  );
}

interface PreviewRow { number?: string | null; name: string; abbreviation: string | null; status: 'NEW' | 'EXISTS'; problem?: string; include?: boolean }
interface Preview { title: string | null; asAt: string | null; source: string; rows: PreviewRow[]; warnings: string[] }
const ORPP_PAGE = 'https://orpp.or.ke/list-of-political-parties/';

/** Loads the register of fully registered parties: read (link, PDF or pasted text) -> review -> import. */
function RegisteredPartiesLoader({ onImported }: { onImported: () => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'url' | 'pdf' | 'text'>('url');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});

  const read = async () => {
    setMsg({});
    setPreview(null);
    setBusy(true);
    try {
      let r: Preview;
      if (mode === 'pdf') {
        if (!file) throw new Error('Choose the PDF downloaded from the ORPP website');
        const form = new FormData();
        form.append('file', file);
        r = await api<Preview>('/admin/parties/read', { form });
      } else r = await api<Preview>('/admin/parties/read', { body: mode === 'url' ? { url } : { text } });
      setPreview({ ...r, rows: r.rows.map((x) => ({ ...x, include: x.status === 'NEW' && !x.problem })) });
    } catch (x) {
      setMsg({ err: (x as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const edit = (i: number, patch: Partial<PreviewRow>) =>
    setPreview((p) => (p ? { ...p, rows: p.rows.map((r, j) => (j === i ? { ...r, ...patch, problem: patch.abbreviation !== undefined ? (patch.abbreviation ? undefined : r.problem) : r.problem } : r)) } : p));
  const doImport = async () => {
    if (!preview) return;
    const rows = preview.rows.filter((r) => r.include && r.status === 'NEW' && r.abbreviation).map((r) => ({ name: r.name.trim(), abbreviation: r.abbreviation!.trim() }));
    if (!rows.length) return setMsg({ err: 'Tick at least one new party with an abbreviation.' });
    setBusy(true);
    try {
      const r = await api<{ created: number; alreadyPresent: number; skipped: { name: string; problem: string }[] }>('/admin/parties/import', {
        body: { rows, source: { title: preview.title, url: preview.source.startsWith('https://') ? preview.source : null, asAt: preview.asAt } }
      });
      setMsg({ ok: `Imported ${r.created} parties.${r.skipped.length ? ` Skipped ${r.skipped.length}: ${r.skipped.map((s) => `${s.name} (${s.problem})`).join('; ')}` : ''} Add their logos below.` });
      setPreview(null);
      onImported();
    } catch (x) {
      setMsg({ err: (x as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const included = preview?.rows.filter((r) => r.include).length ?? 0;
  return (
    <div className="card space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h2 className="font-bold">Load all registered parties</h2>
          <p className="text-sm text-gray-600">From the Office of the Registrar of Political Parties (ORPP) list of fully registered parties. You review every row before anything is saved; parties already here are left unchanged.</p>
        </div>
        <button className={open ? 'btn-outline' : 'btn-primary'} onClick={() => setOpen(!open)}>{open ? 'Close' : 'Load parties'}</button>
      </div>
      {open && (
        <>
          <Segmented label="How to load the list" value={mode} onChange={setMode} options={[{ value: 'url', label: 'ORPP link' }, { value: 'pdf', label: 'Upload ORPP PDF' }, { value: 'text', label: 'Paste list' }]} />
          {mode === 'url' && (
            <Field label="Link to the ORPP list (PDF or page on orpp.or.ke)" hint={`Open ${ORPP_PAGE}, copy the link to the latest "Fully Registered Political Parties" list and paste it here. Read by AI.`}>
              <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://orpp.or.ke/wp-content/uploads/…/Fully-Registered-Parties….pdf" />
            </Field>
          )}
          {mode === 'pdf' && (
            <Field label="ORPP list (PDF)" hint="Download the latest list from orpp.or.ke and upload it here. Read by AI.">
              <input type="file" accept="application/pdf" className="input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Field>
          )}
          {mode === 'text' && (
            <Field label="One party per line" hint={'For example "Orange Democratic Movement (ODM)" or "United Democratic Alliance, UDA". Copy the rows from the ORPP list. No AI needed.'}>
              <textarea className="input min-h-40 font-mono text-sm" value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          )}
          <button className="btn-primary" disabled={busy} onClick={read}>{busy && !preview ? 'Reading…' : 'Read list'}</button>
          {msg.ok && <Success>{msg.ok}</Success>}
          {msg.err && <ErrorBox error={msg.err} />}
          {preview && (
            <div className="space-y-2">
              <p className="text-sm">
                <strong>{preview.title ?? 'Party list'}</strong>
                {preview.asAt ? ` · as at ${preview.asAt}` : ''} · {preview.rows.length} rows · {preview.rows.filter((r) => r.status === 'EXISTS').length} already here
              </p>
              {preview.warnings.map((w) => <p key={w} className="rounded bg-amber-50 p-2 text-sm text-amber-900">{w}</p>)}
              <div className="max-h-[28rem] overflow-auto">
                <table className="table">
                  <thead><tr><th>Import</th><th>#</th><th>Party name</th><th>Abbreviation</th><th>Status</th></tr></thead>
                  <tbody>
                    {preview.rows.map((r, i) => (
                      <tr key={i} className={r.status === 'EXISTS' ? 'text-gray-400' : ''}>
                        <td><input type="checkbox" aria-label={`Import ${r.name}`} disabled={r.status === 'EXISTS'} checked={!!r.include} onChange={(e) => edit(i, { include: e.target.checked })} /></td>
                        <td className="text-xs">{r.number ?? ''}</td>
                        <td>{r.status === 'NEW' ? <input className="input py-1" value={r.name} onChange={(e) => edit(i, { name: e.target.value })} aria-label="Party name" /> : r.name}</td>
                        <td>{r.status === 'NEW' ? <input className="input w-28 py-1 uppercase" value={r.abbreviation ?? ''} maxLength={20} onChange={(e) => edit(i, { abbreviation: e.target.value.toUpperCase() || null })} aria-label={`Abbreviation for ${r.name}`} /> : r.abbreviation}</td>
                        <td className="text-xs">{r.status === 'EXISTS' ? 'Already here' : r.problem ? <span className="text-amber-800">{r.problem}</span> : 'New'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button className="btn-primary" disabled={busy || !included} onClick={doImport}>Import {included} parties</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
