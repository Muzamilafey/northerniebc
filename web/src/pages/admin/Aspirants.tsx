import { useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import { uploadImage } from '../../lib/upload';
import { Empty, ErrorBox, Field, PageHeader, PublicImage, Success } from '../../components/ui';
import { POSITION_LABELS } from '../../lib/format';
import { useApi } from '../../lib/useApi';

interface Party { _id: string; name: string; abbreviation: string; logoFileId?: string; active: boolean }
interface Candidate { _id: string; fullName: string; position: string; party?: string; partyAbbreviation?: string; independent: boolean; partyId?: { _id: string; logoFileId?: string } | null; photoFileId?: string; scopeType: string; scopeRefId?: string; ballotOrder?: number; active: boolean }
interface Area { _id: string; name: string; code?: string }

const SCOPE_OF: Record<string, 'NATIONAL' | 'COUNTY' | 'CONSTITUENCY' | 'WARD'> = { PRESIDENT: 'NATIONAL', GOVERNOR: 'COUNTY', SENATOR: 'COUNTY', WOMAN_REP: 'COUNTY', MP: 'CONSTITUENCY', MCA: 'WARD' };

export default function Aspirants() {
  const [tab, setTab] = useState<'aspirants' | 'parties'>('aspirants');
  return (
    <div className="space-y-4">
      <PageHeader title="Aspirants & parties" subtitle="Add the aspirants on the ballot for each position, with their photo and party. Party logos appear wherever their aspirants are shown." />
      <div className="flex gap-2">
        <button className={tab === 'aspirants' ? 'btn-primary' : 'btn-outline'} onClick={() => setTab('aspirants')}>Aspirants</button>
        <button className={tab === 'parties' ? 'btn-primary' : 'btn-outline'} onClick={() => setTab('parties')}>Parties</button>
      </div>
      {tab === 'aspirants' ? <AspirantsTab /> : <PartiesTab />}
    </div>
  );
}

function AspirantsTab() {
  const { data: el } = useApi<{ items: { _id: string; name: string; positions: { position: string; enabled: boolean }[] }[] }>('/admin/elections');
  const [electionId, setElectionId] = useState('');
  const eid = electionId || el?.items[0]?._id || '';
  const election = el?.items.find((e) => e._id === eid);
  const positions = election?.positions.filter((p) => p.enabled).map((p) => p.position) ?? [];
  const [position, setPosition] = useState('');
  const pos = position || positions[0] || '';
  const scope = SCOPE_OF[pos];
  const [countyId, setCountyId] = useState('');
  const [constituencyId, setConstituencyId] = useState('');
  const [wardId, setWardId] = useState('');
  const { data: counties } = useApi<{ items: Area[] }>('/public/counties');
  const constsApi = useApi<{ items: Area[] }>(eid && countyId ? `/public/elections/${eid}/constituencies` : null, { countyId });
  const consts = constsApi.data;
  const { data: wards } = useApi<{ items: Area[] }>(eid && constituencyId ? `/public/elections/${eid}/wards` : null, { constituencyId });
  const areaName = (items: Area[] | undefined, id: string) => items?.find((a) => a._id === id)?.name ?? '';
  const scopeRefId = scope === 'COUNTY' ? countyId : scope === 'CONSTITUENCY' ? constituencyId : scope === 'WARD' ? wardId : '';
  const where = !scopeRefId ? '' : scope === 'COUNTY' ? `${areaName(counties?.items, countyId)} County` : scope === 'CONSTITUENCY' ? `${areaName(consts?.items, constituencyId)} Constituency` : scope === 'WARD' ? `${areaName(wards?.items, wardId)} Ward` : '';
  const list = useApi<{ items: Candidate[] }>(eid && pos ? '/admin/candidates' : null, { electionId: eid, position: pos, scopeRefId: scopeRefId || undefined });
  const { data: parties } = useApi<{ items: Party[] }>('/admin/parties');
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [busy, setBusy] = useState(false);

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setMsg({});
    setBusy(true);
    try {
      if (scope !== 'NATIONAL' && !scopeRefId) throw new Error(`Choose the ${scope?.toLowerCase()} this aspirant is contesting in`);
      const photo = f.get('photo') as File | null;
      const photoFileId = photo && photo.size > 0 ? await uploadImage('CANDIDATE_PHOTO', photo) : undefined;
      const partyId = String(f.get('partyId') ?? '');
      await api('/admin/candidates', {
        body: {
          electionId: eid,
          position: pos,
          fullName: String(f.get('fullName')).trim(),
          ...(partyId === 'IND' ? { independent: true } : partyId ? { partyId } : {}),
          scopeRefId: scope === 'NATIONAL' ? null : scopeRefId,
          ballotOrder: f.get('ballotOrder') ? Number(f.get('ballotOrder')) : undefined,
          sourceReference: f.get('sourceReference') || undefined,
          photoFileId
        }
      });
      form.reset();
      setMsg({ ok: 'Aspirant added.' });
      void list.reload();
    } catch (x) {
      setMsg({ err: (x as Error).message });
    } finally {
      setBusy(false);
    }
  }

  // Super admins only; others see the server's permission message.
  const loadAreas = async () => {
    setMsg({});
    setBusy(true);
    try {
      const r = await api<{ countiesAdded: number; constituenciesAdded: number; wardsAdded: number; conflicts: string[] }>(`/admin/elections/${eid}/areas/load-official`, { method: 'POST' });
      setMsg({ ok: `Loaded ${r.constituenciesAdded} constituencies and ${r.wardsAdded} wards${r.countiesAdded ? ` (and ${r.countiesAdded} missing counties)` : ''}.${r.conflicts.length ? ` Check: ${r.conflicts.join('; ')}` : ''}` });
      void constsApi.reload();
    } catch (x) {
      setMsg({ err: (x as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (c: Candidate) => {
    const reason = prompt(c.active ? 'Reason for removing this aspirant from the ballot (e.g. withdrawal notice):' : 'Reason for restoring this aspirant:');
    if (!reason) return;
    try {
      await api(`/admin/candidates/${c._id}`, { method: 'PATCH', body: { active: !c.active, reason } });
      void list.reload();
    } catch (x) {
      setMsg({ err: (x as Error).message });
    }
  };
  const changePhoto = async (c: Candidate, file?: File) => {
    if (!file) return;
    try {
      const photoFileId = await uploadImage('CANDIDATE_PHOTO', file);
      await api(`/admin/candidates/${c._id}`, { method: 'PATCH', body: { photoFileId, reason: 'Photo updated' } });
      void list.reload();
    } catch (x) {
      setMsg({ err: (x as Error).message });
    }
  };

  if (!el) return null;
  if (!el.items.length) return <Empty title="Create an election first">Aspirants belong to an election. Create one under Election setup.</Empty>;
  return (
    <div className="space-y-4">
      <div className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Election"><select className="input" value={eid} onChange={(e) => { setElectionId(e.target.value); setPosition(''); }}>{el.items.map((e) => <option key={e._id} value={e._id}>{e.name}</option>)}</select></Field>
        <Field label="County"><select className="input" value={countyId} onChange={(e) => { setCountyId(e.target.value); setConstituencyId(''); setWardId(''); }}><option value="">Choose county…</option>{counties?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select></Field>
        <Field label="Constituency"><select className="input" value={constituencyId} disabled={!countyId} onChange={(e) => { setConstituencyId(e.target.value); setWardId(''); }}><option value="">{countyId ? 'Choose constituency…' : 'Choose a county first'}</option>{consts?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select></Field>
        <Field label="Ward"><select className="input" value={wardId} disabled={!constituencyId} onChange={(e) => setWardId(e.target.value)}><option value="">{constituencyId ? 'Choose ward…' : 'Choose a constituency first'}</option>{wards?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select></Field>
        <Field label="Position"><select className="input" value={pos} onChange={(e) => setPosition(e.target.value)}>{positions.length === 0 && <option value="">No positions enabled</option>}{positions.map((p) => <option key={p} value={p}>{POSITION_LABELS[p]}</option>)}</select></Field>
        <p className="text-xs text-gray-500 sm:col-span-2 lg:col-span-5">President is national. Governor, Senator and Woman Representative are chosen per county, Member of Parliament per constituency, and MCA per ward.</p>
      </div>
      {positions.length === 0 && <p className="text-sm text-amber-800">Enable positions for this election under Election setup first.</p>}
      {countyId && consts?.items.length === 0 && (
        <div className="card flex flex-wrap items-center gap-3 border-amber-300 bg-amber-50 text-sm text-amber-900">
          <p className="flex-1">No constituencies or wards are loaded for this county in this election yet.</p>
          <button className="btn-primary" disabled={busy} onClick={loadAreas}>Load official IEBC constituencies &amp; wards</button>
        </div>
      )}
      {scope && scope !== 'NATIONAL' && !scopeRefId && <p className="text-sm text-amber-800">{POSITION_LABELS[pos]} aspirants contest per {scope.toLowerCase()} — choose the {scope.toLowerCase()} above to add or list them.</p>}

      {pos && (
        <form className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-3" onSubmit={add}>
          <h2 className="font-bold sm:col-span-2 lg:col-span-3">Add aspirant — {POSITION_LABELS[pos]}{scope === 'NATIONAL' ? ' (national)' : where ? `, ${where}` : ''}</h2>
          <Field label="Full name (as on the ballot)"><input name="fullName" className="input" required minLength={3} /></Field>
          <Field label="Party">
            <select name="partyId" className="input" defaultValue="">
              <option value="">Choose…</option>
              <option value="IND">Independent</option>
              {parties?.items.filter((p) => p.active).map((p) => <option key={p._id} value={p._id}>{p.name} ({p.abbreviation})</option>)}
            </select>
          </Field>
          <Field label="Ballot order (optional)"><input name="ballotOrder" type="number" min={0} className="input" /></Field>
          <Field label="Photo (JPEG/PNG/WebP, max 2 MB)"><input name="photo" type="file" accept="image/jpeg,image/png,image/webp" className="input" /></Field>
          <Field label="Source reference (e.g. gazette notice)"><input name="sourceReference" className="input" /></Field>
          <div className="flex items-end"><button className="btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Add aspirant'}</button></div>
        </form>
      )}
      {msg.ok && <Success>{msg.ok}</Success>}
      {msg.err && <ErrorBox error={msg.err} />}

      <div className="card overflow-x-auto">
        <h2 className="mb-2 font-bold">Aspirants{scopeRefId ? ' in this area' : ''}</h2>
        {list.data?.items.length === 0 ? <p className="text-sm text-gray-600">No aspirants added yet.</p> : (
          <table className="table">
            <thead><tr><th>Photo</th><th>Name</th><th>Party</th><th>Order</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {list.data?.items.map((c) => (
                <tr key={c._id} className={c.active ? '' : 'text-gray-400'}>
                  <td><PublicImage fileId={c.photoFileId} alt={c.fullName} size={44} rounded="rounded-full" /></td>
                  <td className="font-medium">{c.fullName}</td>
                  <td><span className="inline-flex items-center gap-2"><PublicImage fileId={c.partyId?.logoFileId} alt={`${c.party ?? 'Independent'} logo`} size={28} fallback={c.partyAbbreviation} />{c.party ?? '—'}</span></td>
                  <td>{c.ballotOrder ?? '—'}</td>
                  <td>{c.active ? 'On ballot' : 'Removed'}</td>
                  <td className="space-x-2 whitespace-nowrap text-xs">
                    <label className="link cursor-pointer">Change photo<input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => void changePhoto(c, e.target.files?.[0])} /></label>
                    <button className="link" onClick={() => void toggle(c)}>{c.active ? 'Remove from ballot' : 'Restore'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function PartiesTab() {
  const list = useApi<{ items: Party[] }>('/admin/parties');
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
      form.reset();
      setMsg({ ok: 'Party added.' });
      void list.reload();
    } catch (x) {
      setMsg({ err: (x as Error).message });
    }
  }
  const setLogo = async (p: Party, file?: File) => {
    if (!file) return;
    try {
      await api(`/admin/parties/${p._id}`, { method: 'PATCH', body: { logoFileId: await uploadImage('PARTY_LOGO', file) } });
      void list.reload();
    } catch (x) {
      setMsg({ err: (x as Error).message });
    }
  };
  return (
    <div className="space-y-4">
      <form className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={add}>
        <h2 className="font-bold sm:col-span-2 lg:col-span-4">Add party</h2>
        <Field label="Party name"><input name="name" className="input" required minLength={2} /></Field>
        <Field label="Abbreviation"><input name="abbreviation" className="input" required maxLength={20} /></Field>
        <Field label="Logo (JPEG/PNG/WebP, max 2 MB)"><input name="logo" type="file" accept="image/jpeg,image/png,image/webp" className="input" /></Field>
        <Field label="Source (e.g. Registrar of Political Parties)"><input name="sourceReference" className="input" /></Field>
        <div><button className="btn-primary">Add party</button></div>
      </form>
      {msg.ok && <Success>{msg.ok}</Success>}
      {msg.err && <ErrorBox error={msg.err} />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.data?.items.map((p) => (
          <div key={p._id} className="card flex items-center gap-3">
            <PublicImage fileId={p.logoFileId} alt={`${p.name} logo`} size={56} fallback={p.abbreviation} />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{p.name}</p>
              <p className="text-xs text-gray-500">{p.abbreviation}{p.active ? '' : ' · inactive'}</p>
              <label className="link cursor-pointer text-xs">{p.logoFileId ? 'Replace logo' : 'Upload logo'}<input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => void setLogo(p, e.target.files?.[0])} /></label>
            </div>
          </div>
        ))}
      </div>
      {list.data?.items.length === 0 && <Empty title="No parties yet">Add the registered parties your aspirants belong to.</Empty>}
    </div>
  );
}
