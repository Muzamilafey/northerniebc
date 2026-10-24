import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useDialog } from '../../../components/Dialog';
import { Empty, ErrorBox, Field, Loading, PageHeader, PublicImage, Success } from '../../../components/ui';
import { api } from '../../../lib/api';
import { POSITION_LABELS } from '../../../lib/format';
import { uploadImage } from '../../../lib/upload';
import { useApi } from '../../../lib/useApi';
import { CatalogTabs, PlusIcon, useAreas, type Candidate, type ElectionLite, type Party } from './shared';

const POSITION_ORDER = ['PRESIDENT', 'GOVERNOR', 'SENATOR', 'WOMAN_REP', 'MP', 'MCA'];

export default function AspirantList() {
  const dialog = useDialog();
  const navigate = useNavigate();
  const location = useLocation();
  const [sp, setSp] = useSearchParams();
  const get = (k: string) => sp.get(k) ?? '';
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
    setSp(next, { replace: true });
  };

  const elections = useApi<{ items: ElectionLite[] }>('/admin/elections');
  const eid = get('electionId') || elections.data?.items[0]?._id || '';
  const election = elections.data?.items.find((e) => e._id === eid);
  const positions = election?.positions.filter((p) => p.enabled).map((p) => p.position) ?? [];
  const { counties, constituencies, wards } = useAreas(eid, get('countyId'), get('constituencyId'));
  const parties = useApi<{ items: Party[] }>('/admin/parties');

  const [q, setQ] = useState(get('q'));
  useEffect(() => {
    const t = setTimeout(() => q !== get('q') && set({ q }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const list = useApi<{ items: Candidate[] }>(eid ? '/admin/candidates' : null, {
    electionId: eid,
    position: get('position') || undefined,
    countyId: get('wardId') || get('constituencyId') ? undefined : get('countyId') || undefined,
    constituencyId: get('wardId') ? undefined : get('constituencyId') || undefined,
    wardId: get('wardId') || undefined,
    q: get('q') || undefined,
    status: get('status') || undefined
  });

  const [msg, setMsg] = useState<{ ok?: string; err?: string }>(() => ((location.state as { saved?: string } | null)?.saved ? { ok: (location.state as { saved: string }).saved } : {}));
  useEffect(() => {
    if (location.state) navigate(location.pathname + location.search, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (fn: () => Promise<string>) => {
    setMsg({});
    try {
      setMsg({ ok: await fn() });
      void list.reload();
    } catch (x) {
      setMsg({ err: (x as Error).message });
    }
  };
  const edit = async (c: Candidate) => {
    const r = await dialog.form({
      title: `Edit ${c.fullName}`,
      message: `${POSITION_LABELS[c.position]} · ${c.areaName ?? ''}. Changes are recorded in the audit log.`,
      confirmLabel: 'Save changes',
      fields: [
        { name: 'fullName', label: 'Full name (as on the ballot)', defaultValue: c.fullName, minLength: 3, maxLength: 200 },
        {
          name: 'partyId',
          label: 'Party',
          type: 'select',
          defaultValue: c.independent ? 'IND' : c.partyId?._id ?? '',
          options: [{ value: 'IND', label: 'Independent' }, ...(parties.data?.items.filter((p) => p.active || p._id === c.partyId?._id).map((p) => ({ value: p._id, label: `${p.name} (${p.abbreviation})` })) ?? [])]
        },
        { name: 'ballotOrder', label: 'Ballot order (optional)', type: 'number', required: false, min: 0, step: '1', defaultValue: c.ballotOrder != null ? String(c.ballotOrder) : '' },
        { name: 'reason', label: 'Reason for the change', type: 'textarea', minLength: 3, maxLength: 500, placeholder: 'e.g. Name spelling per gazette notice' }
      ]
    });
    if (!r) return;
    await act(async () => {
      await api(`/admin/candidates/${c._id}`, {
        method: 'PATCH',
        body: { fullName: r.fullName, ...(r.partyId === 'IND' ? { independent: true } : { partyId: r.partyId, independent: false }), ...(r.ballotOrder ? { ballotOrder: Number(r.ballotOrder) } : {}), reason: r.reason }
      });
      return `${r.fullName} updated.`;
    });
  };
  const toggle = async (c: Candidate) => {
    const reason = await dialog.prompt(
      c.active
        ? { title: `Remove ${c.fullName} from the ballot?`, message: 'The aspirant stays in the record and can be restored. Reviewers see your reason.', label: 'Reason', type: 'textarea', minLength: 3, maxLength: 500, placeholder: 'e.g. Withdrew — gazette notice no. …', confirmLabel: 'Remove aspirant', tone: 'danger' }
        : { title: `Restore ${c.fullName} to the ballot?`, label: 'Reason', type: 'textarea', minLength: 3, maxLength: 500, confirmLabel: 'Restore aspirant' }
    );
    if (!reason) return;
    await act(async () => {
      await api(`/admin/candidates/${c._id}`, { method: 'PATCH', body: { active: !c.active, reason } });
      return c.active ? `${c.fullName} removed from the ballot.` : `${c.fullName} restored.`;
    });
  };
  const changePhoto = (c: Candidate, file?: File) =>
    file &&
    act(async () => {
      await api(`/admin/candidates/${c._id}`, { method: 'PATCH', body: { photoFileId: await uploadImage('CANDIDATE_PHOTO', file), reason: 'Photo updated' } });
      return `Photo updated for ${c.fullName}.`;
    });

  const addLink = `/admin/aspirants/new?${new URLSearchParams(Object.fromEntries(['electionId', 'position', 'countyId', 'constituencyId', 'wardId'].map((k) => [k, k === 'electionId' ? eid : get(k)]).filter(([, v]) => v)))}`;
  const items = list.data?.items ?? [];
  const groups = POSITION_ORDER.map((p) => ({ position: p, items: items.filter((c) => c.position === p) })).filter((g) => g.items.length);
  const filtered = ['position', 'countyId', 'q', 'status'].some((k) => get(k));

  if (elections.loading) return <Loading />;
  if (!elections.data?.items.length) {
    return (
      <div>
        <PageHeader title="Aspirants" />
        <Empty title="Create an election first">Aspirants belong to an election. Create one under <Link className="link" to="/admin/elections">Election setup</Link>.</Empty>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Aspirants"
        subtitle="Everyone on the ballot, by position and area. Photos and party logos appear on public results and the agents' count screen."
        actions={<Link to={addLink} className="btn-accent"><PlusIcon /> Add aspirant</Link>}
      />
      <CatalogTabs />

      <section aria-label="Filters" className="card mb-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Election"><select className="input" value={eid} onChange={(e) => set({ electionId: e.target.value, position: '', countyId: '', constituencyId: '', wardId: '' })}>{elections.data.items.map((e) => <option key={e._id} value={e._id}>{e.name}</option>)}</select></Field>
          <Field label="Position"><select className="input" value={get('position')} onChange={(e) => set({ position: e.target.value })}><option value="">All positions</option>{positions.map((p) => <option key={p} value={p}>{POSITION_LABELS[p]}</option>)}</select></Field>
          <Field label="Search"><input className="input" type="search" placeholder="Aspirant name" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
          <Field label="Status"><select className="input" value={get('status')} onChange={(e) => set({ status: e.target.value })}><option value="">All</option><option value="active">On the ballot</option><option value="removed">Removed</option></select></Field>
          <Field label="County"><select className="input" value={get('countyId')} onChange={(e) => set({ countyId: e.target.value, constituencyId: '', wardId: '' })}><option value="">All counties</option>{counties.data?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select></Field>
          <Field label="Constituency"><select className="input" value={get('constituencyId')} disabled={!get('countyId')} onChange={(e) => set({ constituencyId: e.target.value, wardId: '' })}><option value="">{get('countyId') ? 'Whole county' : 'Choose a county first'}</option>{constituencies.data?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select></Field>
          <Field label="Ward"><select className="input" value={get('wardId')} disabled={!get('constituencyId')} onChange={(e) => set({ wardId: e.target.value })}><option value="">{get('constituencyId') ? 'Whole constituency' : 'Choose a constituency first'}</option>{wards.data?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select></Field>
          <div className="flex items-end">{filtered && <button className="btn-outline w-full" onClick={() => { setQ(''); set({ position: '', countyId: '', constituencyId: '', wardId: '', q: '', status: '' }); }}>Clear filters</button>}</div>
        </div>
      </section>

      {msg.ok && <div className="mb-4"><Success>{msg.ok}</Success></div>}
      {msg.err && <div className="mb-4"><ErrorBox error={msg.err} /></div>}
      {list.error && <ErrorBox error={list.error} />}
      {list.loading && !list.data && <Loading />}

      {list.data && (
        <p className="mb-3 text-sm text-gray-600">
          {items.length} aspirant{items.length === 1 ? '' : 's'} · {items.filter((c) => c.active).length} on the ballot
        </p>
      )}
      {list.data && items.length === 0 && (
        <Empty title={filtered ? 'No aspirants match these filters' : 'No aspirants yet'}>
          <Link className="btn-accent mt-3" to={addLink}><PlusIcon /> Add the first aspirant</Link>
        </Empty>
      )}

      <div className="space-y-8">
        {groups.map((g) => (
          <section key={g.position} aria-labelledby={`pos-${g.position}`}>
            <h2 id={`pos-${g.position}`} className="mb-3 flex items-center gap-2 text-lg font-bold text-navy-900">
              {POSITION_LABELS[g.position]} <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">{g.items.length}</span>
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {g.items.map((c) => (
                <li key={c._id} className={`card flex flex-col gap-3 transition hover:shadow-md ${c.active ? '' : 'opacity-60'}`}>
                  <div className="flex items-start gap-3">
                    <PublicImage fileId={c.photoFileId} alt={c.fullName} size={64} rounded="rounded-full" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-navy-900" title={c.fullName}>{c.fullName}</p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-sm text-gray-700">
                        <PublicImage fileId={c.partyId?.logoFileId} alt="" fallback={c.partyAbbreviation ?? 'IND'} size={20} />
                        <span className="truncate" title={c.party ?? 'Independent'}>{c.partyAbbreviation ?? (c.independent ? 'Independent' : c.party ?? '—')}</span>
                      </p>
                      <p className="mt-0.5 truncate text-xs text-gray-500">{c.areaName}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${c.active ? 'bg-teal-600/10 text-teal-700' : 'bg-gray-100 text-gray-600'}`}>{c.active ? 'On ballot' : 'Removed'}</span>
                      {c.ballotOrder != null && <span className="text-xs text-gray-500">No. {c.ballotOrder}</span>}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 border-t border-gray-100 pt-3 text-xs">
                    <button className="btn-outline px-2.5 py-1 text-xs" onClick={() => void edit(c)}>Edit</button>
                    <label className="btn-outline cursor-pointer px-2.5 py-1 text-xs">
                      {c.photoFileId ? 'Change photo' : 'Add photo'}
                      <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => { void changePhoto(c, e.target.files?.[0]); e.target.value = ''; }} />
                    </label>
                    <button className={`ml-auto px-2.5 py-1 text-xs font-semibold ${c.active ? 'text-red-700 hover:underline' : 'text-navy-700 hover:underline'}`} onClick={() => void toggle(c)}>{c.active ? 'Remove from ballot' : 'Restore'}</button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
