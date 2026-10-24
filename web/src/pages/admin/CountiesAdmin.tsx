import { useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import { uploadImage } from '../../lib/upload';
import { ErrorBox, Field, PageHeader, PublicImage, Success } from '../../components/ui';
import { useApi } from '../../lib/useApi';
import { LogoEditor } from '../../components/LogoEditor';
import { useDialog } from '../../components/Dialog';

interface County { _id: string; code: string; name: string; region?: string; logoFileId?: string }

export default function CountiesAdmin() {
  const dialog = useDialog();
  const list = useApi<{ items: County[] }>('/public/counties');
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setMsg({});
    try {
      const logo = f.get('logo') as File | null;
      const logoFileId = logo && logo.size > 0 ? await uploadImage('COUNTY_LOGO', logo) : undefined;
      await api('/admin/counties', { body: { code: String(f.get('code')).padStart(3, '0'), name: f.get('name'), region: f.get('region') || undefined, logoFileId } });
      form.reset();
      setMsg({ ok: 'County added.' });
      void list.reload();
    } catch (x) {
      setMsg({ err: (x as Error).message });
    }
  }
  const update = async (c: County, body: Record<string, unknown>) => {
    try {
      await api(`/admin/counties/${c._id}`, { method: 'PATCH', body });
      void list.reload();
    } catch (x) {
      setMsg({ err: (x as Error).message });
    }
  };
  const setLogo = async (c: County, logoFileId: string | null) => {
    await api(`/admin/counties/${c._id}`, { method: 'PATCH', body: { logoFileId } });
    void list.reload();
  };
  return (
    <div className="space-y-4">
      <PageHeader title="Counties" subtitle="Counties, constituencies and wards covered by the platform. Use official IEBC codes (e.g. Garissa 007). Codes cannot be changed after creation." />
      <form className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-5" onSubmit={add}>
        <h2 className="font-bold sm:col-span-2 lg:col-span-5">Add county</h2>
        <Field label="County code"><input name="code" className="input" required pattern="\d{1,3}" placeholder="e.g. 012" /></Field>
        <Field label="Name"><input name="name" className="input" required /></Field>
        <Field label="Region (optional)"><input name="region" className="input" /></Field>
        <Field label="Logo (JPEG/PNG/WebP, max 2 MB)"><input name="logo" type="file" accept="image/jpeg,image/png,image/webp" className="input" /></Field>
        <div className="flex items-end"><button className="btn-primary">Add county</button></div>
      </form>
      {msg.ok && <Success>{msg.ok}</Success>}
      {msg.err && <ErrorBox error={msg.err} />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.data?.items.map((c) => (
          <div key={c._id} className="card flex items-center gap-3">
            <PublicImage fileId={c.logoFileId} alt={`${c.name} County logo`} size={64} fallback={c.name} />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{c.name}</p>
              <p className="text-xs text-gray-500">Code {c.code}{c.region ? ` · ${c.region}` : ''}</p>
              <LogoEditor fileId={c.logoFileId} purpose="COUNTY_LOGO" label={`${c.name} County logo`} onSave={(id) => setLogo(c, id)} />
              <div className="mt-1 flex gap-3 text-xs">
                <button className="link" onClick={async () => { const region = await dialog.prompt({ title: `Region for ${c.name} County`, label: 'Region', defaultValue: c.region ?? '', required: false, maxLength: 100, placeholder: 'e.g. North Eastern' }); if (region !== null) void update(c, { region }); }}>Edit region</button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {list.data && <AreasSection counties={list.data.items} />}
    </div>
  );
}

interface Ward { _id: string; code: string; name: string }
interface Constituency { _id: string; code: string; name: string; countyId: string; wards: Ward[] }
interface LoadSummary { constituenciesAdded: number; wardsAdded: number; alreadyPresent: number; conflicts: string[] }

/** Constituencies and wards belong to an election (boundaries can change between elections). */
function AreasSection({ counties }: { counties: County[] }) {
  const dialog = useDialog();
  const { data: el } = useApi<{ items: { _id: string; name: string }[] }>('/admin/elections');
  const [electionId, setElectionId] = useState('');
  const eid = electionId || el?.items[0]?._id || '';
  const areas = useApi<{ items: Constituency[] }>(eid ? `/admin/elections/${eid}/areas` : null);
  const [countyId, setCountyId] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<string>) => {
    setMsg({});
    setBusy(true);
    try {
      setMsg({ ok: await fn() });
      void areas.reload();
    } catch (x) {
      setMsg({ err: (x as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const loadOfficial = () =>
    run(async () => {
      const r = await api<LoadSummary>(`/admin/elections/${eid}/areas/load-official`, { method: 'POST' });
      return `Loaded from the IEBC 2022 ward schedule: ${r.constituenciesAdded} constituencies and ${r.wardsAdded} wards added, ${r.alreadyPresent} already present.${r.conflicts.length ? ` Conflicts: ${r.conflicts.join('; ')}` : ''}`;
    });
  const addConstituency = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    void run(async () => {
      await api(`/admin/elections/${eid}/constituencies`, { body: { countyId: f.get('countyId'), code: String(f.get('code')).padStart(3, '0'), name: f.get('name') } });
      form.reset();
      return 'Constituency added.';
    });
  };
  const addWard = (consId: string) => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    void run(async () => {
      await api(`/admin/elections/${eid}/wards`, { body: { constituencyId: consId, code: String(f.get('code')).padStart(4, '0'), name: f.get('name') } });
      form.reset();
      return 'Ward added.';
    });
  };
  const rename = async (kind: 'constituencies' | 'wards', item: { _id: string; name: string }) => {
    const r = await dialog.form({
      title: `Correct the name of ${item.name}`,
      message: 'Only the spelling changes — the official code stays the same. The correction is recorded in the audit log.',
      confirmLabel: 'Save correction',
      fields: [
        { name: 'name', label: 'Corrected name', defaultValue: item.name, minLength: 2, maxLength: 100 },
        { name: 'reason', label: 'Reason', type: 'textarea', minLength: 5, maxLength: 500, placeholder: 'e.g. Spelling per Kenya Gazette notice no. …' }
      ]
    });
    if (!r || r.name === item.name) return;
    const { name, reason } = r;
    void run(async () => {
      await api(`/admin/${kind}/${item._id}`, { method: 'PATCH', body: { name, reason } });
      return 'Name corrected.';
    });
  };

  if (!el) return null;
  const countyName = (id: string) => counties.find((c) => c._id === id)?.name ?? '';
  const shown = (areas.data?.items ?? []).filter((c) => !countyId || c.countyId === countyId);
  const total = areas.data?.items.length ?? 0;
  return (
    <section className="space-y-3" aria-labelledby="areas-h">
      <h2 id="areas-h" className="text-xl font-bold text-navy-900">Constituencies &amp; wards</h2>
      {!el.items.length ? (
        <p className="text-sm text-gray-600">Create an election first — constituencies and wards are kept per election.</p>
      ) : (
        <>
          <div className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Election"><select className="input" value={eid} onChange={(e) => setElectionId(e.target.value)}>{el.items.map((e) => <option key={e._id} value={e._id}>{e.name}</option>)}</select></Field>
            <Field label="Show county"><select className="input" value={countyId} onChange={(e) => setCountyId(e.target.value)}><option value="">All counties</option>{counties.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select></Field>
            <div className="flex items-end sm:col-span-2">
              <button className="btn-primary" disabled={busy || !eid} onClick={loadOfficial}>Load official IEBC list (24 constituencies, 120 wards)</button>
            </div>
            <p className="text-xs text-gray-500 sm:col-span-2 lg:col-span-4">
              Source: IEBC, <a className="link" href="https://www.iebc.or.ke/docs/rov_per_caw.pdf" target="_blank" rel="noreferrer">Registered Voters per County Assembly Ward, 2022 General Election</a>. Loading is safe to repeat — existing entries are never overwritten.
            </p>
          </div>
          {msg.ok && <Success>{msg.ok}</Success>}
          {msg.err && <ErrorBox error={msg.err} />}

          <form className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={addConstituency}>
            <h3 className="font-bold sm:col-span-2 lg:col-span-4">Add a constituency by hand</h3>
            <Field label="County"><select name="countyId" className="input" required defaultValue={countyId}><option value="">Choose…</option>{counties.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select></Field>
            <Field label="Constituency code"><input name="code" className="input" required pattern="\d{1,3}" placeholder="e.g. 027" /></Field>
            <Field label="Name"><input name="name" className="input" required minLength={2} /></Field>
            <div className="flex items-end"><button className="btn-outline" disabled={busy}>Add constituency</button></div>
          </form>

          <p className="text-sm text-gray-600">{total ? `${shown.length} constituencies, ${shown.reduce((n, c) => n + c.wards.length, 0)} wards shown.` : 'No constituencies yet for this election.'}</p>
          <ul className="space-y-2">
            {shown.map((c) => (
              <li key={c._id} className="card p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button className="flex-1 text-left" aria-expanded={open === c._id} onClick={() => setOpen(open === c._id ? null : c._id)}>
                    <span className="font-semibold">{c.name}</span> <span className="text-xs text-gray-500">· code {c.code} · {countyName(c.countyId)} · {c.wards.length} wards</span>
                  </button>
                  <button className="link text-xs" onClick={() => rename('constituencies', c)}>Correct name</button>
                </div>
                {open === c._id && (
                  <div className="mt-2 space-y-2">
                    <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                      {c.wards.map((w) => (
                        <li key={w._id} className="flex items-center justify-between rounded bg-gray-50 px-2 py-1 text-sm">
                          <span>{w.name} <span className="text-xs text-gray-500">{w.code}</span></span>
                          <button className="link text-xs" onClick={() => rename('wards', w)}>Correct</button>
                        </li>
                      ))}
                    </ul>
                    <form className="flex flex-wrap items-end gap-2" onSubmit={addWard(c._id)}>
                      <Field label="Ward code"><input name="code" className="input w-28" required pattern="\d{1,4}" placeholder="e.g. 0131" /></Field>
                      <Field label="Ward name"><input name="name" className="input" required minLength={2} /></Field>
                      <button className="btn-outline" disabled={busy}>Add ward</button>
                    </form>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
