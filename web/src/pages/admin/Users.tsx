import { useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import { ROLE_LABELS, useAuth, type Role } from '../../lib/auth';
import { Empty, ErrorBox, Field, Loading, PageHeader, Pager, Success } from '../../components/ui';
import { Icon } from '../../components/icons';
import { Menu } from '../../components/Menu';
import { fmtDateTime } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import { Modal, ModalActions, useDialog } from '../../components/Dialog';

interface UserRow { _id: string; fullName: string; email: string; role: Role; agentCode?: string; status: string; lastLoginAt?: string; mfa: { enabled: boolean }; phoneMasked?: string; scope: { countyIds: string[] }; vetting?: { status: string; note?: string; accreditationReference?: string } }

export default function Users() {
  const { user } = useAuth();
  const dialog = useDialog();
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<{ role?: string; q?: string; vetting?: string }>({});
  const [vetting, setVetting] = useState<UserRow | null>(null);
  const list = useApi<{ items: UserRow[]; total: number; limit: number }>('/admin/users', { ...filter, page });
  const { data: counties } = useApi<{ items: { _id: string; name: string }[] }>('/public/counties');
  const [created, setCreated] = useState<{ email: string; agentCode?: string; temporaryPassword: string }>();
  const [err, setErr] = useState<string>();
  const [selected, setSelected] = useState<UserRow | null>(null);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setErr(undefined);
    try {
      const countyIds = f.getAll('countyIds').map(String).filter(Boolean);
      const r = await api<{ user: UserRow; temporaryPassword: string }>('/admin/users', { body: { fullName: f.get('fullName'), email: f.get('email'), phone: f.get('phone') || undefined, role: f.get('role'), scope: { countyIds, constituencyIds: [] } } });
      setCreated({ email: r.user.email, agentCode: r.user.agentCode, temporaryPassword: r.temporaryPassword });
      setCreating(false);
      void list.reload();
    } catch (x) {
      setErr((x as Error).message);
    }
  }

  async function action(u: UserRow, act: string) {
    setErr(undefined);
    const copy: Record<string, { title: string; message: string; confirmLabel: string; tone: 'primary' | 'danger'; needsReason: boolean }> = {
      suspend: { title: `Suspend ${u.fullName}?`, message: 'They are signed out at once and cannot sign in until reactivated.', confirmLabel: 'Suspend account', tone: 'danger', needsReason: true },
      reactivate: { title: `Reactivate ${u.fullName}?`, message: 'They will be able to sign in again.', confirmLabel: 'Reactivate', tone: 'primary', needsReason: true },
      revoke: { title: `Permanently revoke ${u.fullName}?`, message: 'The account is closed for good and cannot be reactivated. Their records stay in the audit log.', confirmLabel: 'Revoke account', tone: 'danger', needsReason: true },
      'revoke-sessions': { title: `End all sessions for ${u.fullName}?`, message: 'They are signed out on every device and must sign in again.', confirmLabel: 'End sessions', tone: 'primary', needsReason: false },
      'reset-password': { title: `Reset the password for ${u.fullName}?`, message: 'A one-time temporary password is created and shown once. Their current password stops working and all sessions end.', confirmLabel: 'Reset password', tone: 'danger', needsReason: false }
    };
    const c = copy[act] ?? { title: `${act} ${u.fullName}?`, message: '', confirmLabel: 'Confirm', tone: 'primary' as const, needsReason: true };
    let reason: string | undefined;
    if (c.needsReason) {
      const r = await dialog.prompt({ title: c.title, message: c.message, label: 'Reason (recorded in the audit log)', type: 'textarea', minLength: 3, maxLength: 500, confirmLabel: c.confirmLabel, tone: c.tone });
      if (r === null) return;
      reason = r;
    } else if (!(await dialog.confirm({ title: c.title, message: c.message, confirmLabel: c.confirmLabel, tone: c.tone }))) return;
    try {
      const r = await api<{ temporaryPassword?: string }>(`/admin/users/${u._id}/${act}`, { body: reason ? { reason } : {} });
      if (r?.temporaryPassword) setCreated({ email: u.email, agentCode: u.agentCode, temporaryPassword: r.temporaryPassword });
      void list.reload();
    } catch (x) {
      setErr((x as Error).message);
    }
  }

  const creatable: Role[] = user?.role === 'SUPER_ADMIN' ? Object.keys(ROLE_LABELS) as Role[] : user?.role === 'REGIONAL_ADMIN' ? ['COUNTY_ADMIN', 'CONSTITUENCY_SUPERVISOR', 'VERIFICATION_OFFICER', 'FINANCE_OFFICER', 'AGENT'] : user?.role === 'COUNTY_ADMIN' ? ['CONSTITUENCY_SUPERVISOR', 'AGENT'] : ['AGENT'];

  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const statusBadge: Record<string, string> = { ACTIVE: 'bg-green-100 text-green-800', SUSPENDED: 'bg-amber-100 text-amber-900', REVOKED: 'bg-gray-200 text-gray-600' };
  const vetBadge: Record<string, [string, string]> = { APPROVED: ['Approved', 'bg-green-100 text-green-800'], REJECTED: ['Rejected', 'bg-red-100 text-red-800'], PENDING: ['Awaiting approval', 'bg-amber-100 text-amber-900'] };
  const initials = (n: string) => n.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users & agents"
        subtitle="Create, approve, suspend and assign accounts. Every change is recorded in the audit log."
        actions={<button className="btn-accent" onClick={() => setCreating(true)}><Icon name="plus" className="h-4 w-4" /> New account</button>}
      />
      {err && <ErrorBox error={err} />}

      <section className="card">
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
          <form className="flex flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setFilter({ ...filter, q: search || undefined }); }}>
            <input className="input" type="search" placeholder="Search name, email or agent ID" aria-label="Search users" value={search} onChange={(e) => setSearch(e.target.value)} />
            <button className="btn-outline">Search</button>
          </form>
          <div className="inline-flex rounded-lg border border-gray-300 bg-gray-50 p-0.5 text-sm" role="group" aria-label="Show">
            <button className={`rounded-md px-3 py-1.5 font-semibold ${filter.vetting !== 'PENDING' ? 'bg-white text-navy-900 shadow-sm' : 'text-gray-600'}`} aria-pressed={filter.vetting !== 'PENDING'} onClick={() => { setPage(1); setFilter({ ...filter, vetting: undefined }); }}>Everyone</button>
            <button className={`rounded-md px-3 py-1.5 font-semibold ${filter.vetting === 'PENDING' ? 'bg-white text-navy-900 shadow-sm' : 'text-gray-600'}`} aria-pressed={filter.vetting === 'PENDING'} onClick={() => { setPage(1); setFilter({ ...filter, vetting: 'PENDING' }); }}>Agents awaiting approval</button>
          </div>
          <select className="input lg:max-w-[14rem]" aria-label="Role" value={filter.role ?? ''} onChange={(e) => { setPage(1); setFilter({ ...filter, role: e.target.value || undefined }); }}><option value="">All roles</option>{Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </div>
        {list.loading && !list.data && <Loading />}
        {list.data?.items.length === 0 && <Empty title="No accounts match">Try a different search or filter.</Empty>}
        {!!list.data?.items.length && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Agent approval</th><th>MFA</th><th>Last sign-in</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {list.data.items.map((u) => {
                  const vet = u.role === 'AGENT' ? vetBadge[u.vetting?.status ?? 'PENDING'] ?? vetBadge.PENDING! : null;
                  return (
                    <tr key={u._id}>
                      <td>
                        <div className="flex items-center gap-3">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-navy-50 text-xs font-bold text-navy-700" aria-hidden="true">{initials(u.fullName)}</span>
                          <div className="min-w-0">
                            <p className="font-semibold text-gray-900">{u.fullName}</p>
                            <p className="truncate text-xs text-gray-500">{u.agentCode ?? u.email}{u.phoneMasked ? ` · ${u.phoneMasked}` : ''}</p>
                          </div>
                        </div>
                      </td>
                      <td className="whitespace-nowrap">{ROLE_LABELS[u.role]}</td>
                      <td><span className={`badge ${statusBadge[u.status] ?? 'bg-gray-100 text-gray-700'}`}>{u.status.charAt(0) + u.status.slice(1).toLowerCase()}</span></td>
                      <td>{vet ? <span className={`badge ${vet[1]}`}>{vet[0]}</span> : <span className="text-gray-400">—</span>}</td>
                      <td>{u.mfa.enabled ? <span className="badge bg-green-100 text-green-800">On</span> : <span className="badge bg-gray-100 text-gray-600">Off</span>}</td>
                      <td className="whitespace-nowrap text-xs text-gray-600">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : 'Never'}</td>
                      <td>
                        <div className="flex items-center justify-end gap-2">
                          {u.role === 'AGENT' && u.vetting?.status !== 'APPROVED' && u.status !== 'REVOKED' && <button className="btn-primary btn-sm" onClick={() => setVetting(u)}>Review approval</button>}
                          {u.role === 'AGENT' && u.vetting?.status === 'APPROVED' && u.status === 'ACTIVE' && <button className="btn-outline btn-sm" onClick={() => setSelected(u)}>Assign station</button>}
                          <Menu
                            label={`More actions for ${u.fullName}`}
                            items={[
                              { label: 'Assign station', onSelect: () => setSelected(u), hidden: u.role !== 'AGENT' || u.vetting?.status === 'APPROVED' || u.status === 'REVOKED' },
                              { label: 'Suspend', onSelect: () => void action(u, 'suspend'), hidden: u.status !== 'ACTIVE' },
                              { label: 'Reactivate', onSelect: () => void action(u, 'reactivate'), hidden: u.status !== 'SUSPENDED' },
                              { label: 'End all sessions', onSelect: () => void action(u, 'revoke-sessions') },
                              { label: 'Reset password', onSelect: () => void action(u, 'reset-password') },
                              { label: 'Revoke account', onSelect: () => void action(u, 'revoke'), danger: true, hidden: u.status === 'REVOKED' }
                            ]}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {list.data && <Pager page={page} total={list.data.total} limit={list.data.limit} onPage={setPage} />}
      </section>

      {creating && (
        <Modal title="New account" description="The person gets a one-time temporary password and must change it at first sign-in." icon={false} size="lg" onClose={() => setCreating(false)}>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => { await create(e); }}>
            <Field label="Full name"><input name="fullName" className="input" required autoFocus /></Field>
            <Field label="Email"><input name="email" type="email" className="input" required /></Field>
            <Field label="Phone (optional)"><input name="phone" className="input" placeholder="07XX XXX XXX" /></Field>
            <Field label="Role"><select name="role" className="input">{creatable.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></Field>
            <div className="sm:col-span-2">
              <Field label="County scope" hint="Required for county administrators; optional for officers. Hold Ctrl (or ⌘) to pick several.">
                <select name="countyIds" className="input min-h-[7rem]" multiple>{counties?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select>
              </Field>
            </div>
            {err && <div className="sm:col-span-2"><ErrorBox error={err} /></div>}
            <div className="sm:col-span-2"><ModalActions onCancel={() => setCreating(false)} confirmLabel="Create account" tone="accent" /></div>
          </form>
        </Modal>
      )}

      {created && (
        <Modal title="Account ready" description="Share this temporary password through a secure channel. It is shown only once." tone="accent" onClose={() => setCreated(undefined)}>
          <dl className="space-y-3 text-sm">
            <div><dt className="text-xs font-semibold uppercase text-gray-500">Sign-in</dt><dd className="font-semibold">{created.agentCode ?? created.email}</dd></div>
            <div>
              <dt className="text-xs font-semibold uppercase text-gray-500">Temporary password</dt>
              <dd className="mt-1 flex items-center gap-2">
                <code className="flex-1 select-all rounded-lg bg-gray-100 px-3 py-2 font-mono text-base">{created.temporaryPassword}</code>
                <button type="button" className="btn-outline btn-sm" onClick={() => void navigator.clipboard?.writeText(created.temporaryPassword)}>Copy</button>
              </dd>
            </div>
          </dl>
          {created.agentCode && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">New agents must be approved by a different administrator before they can count.</p>}
          <div className="mt-5 flex justify-end"><button className="btn-primary" onClick={() => setCreated(undefined)}>Done</button></div>
        </Modal>
      )}

      {selected && (
        <Modal title={`Assign ${selected.fullName}`} description={`Agent ${selected.agentCode ?? ''} — pick the polling station they will report from.`} icon={false} size="lg" onClose={() => { setSelected(null); void list.reload(); }}>
          <AssignAgent agent={selected} onClose={() => setSelected(null)} />
        </Modal>
      )}
      {vetting && (
        <Modal title={`Approve agent ${vetting.fullName}`} description="Approve only after checking in person or by video. The administrator who created this account cannot approve it." icon={false} size="lg" onClose={() => setVetting(null)}>
          <VetAgent agent={vetting} onClose={(m) => { setVetting(null); void list.reload(); if (m?.err) setErr(m.err); }} />
        </Modal>
      )}
    </div>
  );
}

function AssignAgent({ agent, onClose }: { agent: UserRow; onClose: () => void }) {
  const dialog = useDialog();
  const { data: el } = useApi<{ items: { _id: string; name: string }[] }>('/admin/elections');
  const [electionId, setElectionId] = useState('');
  const eid = electionId || el?.items[0]?._id || '';
  const [countyId, setCountyId] = useState('');
  const [consId, setConsId] = useState('');
  const [wardId, setWardId] = useState('');
  const [stationId, setStationId] = useState('');
  const { data: counties } = useApi<{ items: { _id: string; name: string }[] }>('/public/counties');
  const { data: consts } = useApi<{ items: { _id: string; name: string }[] }>(eid && countyId ? `/public/elections/${eid}/constituencies` : null, { countyId });
  const { data: wards } = useApi<{ items: { _id: string; name: string }[] }>(eid && consId ? `/public/elections/${eid}/wards` : null, { constituencyId: consId });
  const stations = useApi<{ items: { _id: string; code: string; name: string; registeredVoters?: number }[] }>(eid && wardId ? `/public/elections/${eid}/stations` : null, { wardId });
  const current = useApi<{ items: { _id: string; pollingStationId: { code: string; name: string }; electionId: string }[] }>('/admin/assignments', { userId: agent._id });
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [busy, setBusy] = useState(false);
  const wardName = wards?.items.find((w) => w._id === wardId)?.name ?? '';

  const run = async (fn: () => Promise<string | void>) => {
    setMsg({});
    setBusy(true);
    try {
      const ok = await fn();
      if (ok) setMsg({ ok });
    } catch (e) {
      setMsg({ err: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      if (!stationId) throw new Error('Choose the polling station first');
      await api('/admin/assignments', { body: { userId: agent._id, electionId: eid, pollingStationId: stationId, replaceExisting: true } });
      void current.reload();
      return 'Assignment saved. Any earlier assignment for this election was revoked.';
    });
  const addStation = async () => {
    const r = await dialog.form({
      title: `Add a polling station in ${wardName} Ward`,
      message: 'Use the code and name exactly as printed on the IEBC register of polling stations.',
      confirmLabel: 'Add station',
      fields: [
        { name: 'code', label: 'Polling station code', placeholder: 'e.g. 011049024100101', minLength: 3, maxLength: 20 },
        { name: 'name', label: 'Polling station name', placeholder: 'e.g. Bulla Pesa Primary School', minLength: 2, maxLength: 200 },
        { name: 'registeredVoters', label: 'Registered voters (optional)', type: 'number', required: false, min: 0, step: '1' }
      ]
    });
    if (!r) return;
    await run(async () => {
      const { station } = await api<{ station: { _id: string } }>(`/admin/elections/${eid}/stations`, { body: { wardId, code: r.code, name: r.name, registeredVoters: r.registeredVoters ? Number(r.registeredVoters) : undefined } });
      await stations.reload();
      setStationId(station._id);
      return 'Polling station added — now save the assignment.';
    });
  };
  const revoke = async (a: { _id: string; pollingStationId: { code: string; name: string } }) => {
    const reason = await dialog.prompt({ title: `Revoke ${agent.fullName} from ${a.pollingStationId.name}?`, message: 'The agent can no longer count or submit for this station.', label: 'Reason', type: 'textarea', minLength: 3, maxLength: 500, confirmLabel: 'Revoke assignment', tone: 'danger' });
    if (!reason) return;
    await run(async () => {
      await api(`/admin/assignments/${a._id}/revoke`, { body: { reason } });
      void current.reload();
      return 'Assignment revoked.';
    });
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-gray-50 p-3 text-sm">
        <span className="font-medium">Current assignment: </span>
        {current.data?.items.length ? (
          current.data.items.map((a) => (
            <span key={a._id} className="mr-3 inline-flex items-center gap-2">
              {a.pollingStationId.code} — {a.pollingStationId.name}
              <button className="link text-xs text-red-700" onClick={() => void revoke(a)}>Revoke</button>
            </span>
          ))
        ) : (
          'none'
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Election"><select className="input" value={eid} onChange={(e) => { setElectionId(e.target.value); setCountyId(''); setConsId(''); setWardId(''); setStationId(''); }}>{el?.items.map((e) => <option key={e._id} value={e._id}>{e.name}</option>)}</select></Field>
        <Field label="County"><select className="input" value={countyId} onChange={(e) => { setCountyId(e.target.value); setConsId(''); setWardId(''); setStationId(''); }}><option value="">Choose county…</option>{counties?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select></Field>
        <Field label="Constituency"><select className="input" value={consId} disabled={!countyId} onChange={(e) => { setConsId(e.target.value); setWardId(''); setStationId(''); }}><option value="">{countyId ? 'Choose constituency…' : 'Choose a county first'}</option>{consts?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select></Field>
        <Field label="Ward"><select className="input" value={wardId} disabled={!consId} onChange={(e) => { setWardId(e.target.value); setStationId(''); }}><option value="">{consId ? 'Choose ward…' : 'Choose a constituency first'}</option>{wards?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select></Field>
        <Field label="Polling station">
          <select className="input" value={stationId} disabled={!wardId || !stations.data?.items.length} onChange={(e) => setStationId(e.target.value)}>
            <option value="">{!wardId ? 'Choose a ward first' : stations.data?.items.length ? 'Choose station…' : 'No stations in this ward'}</option>
            {stations.data?.items.map((s) => <option key={s._id} value={s._id}>{s.code} — {s.name}</option>)}
          </select>
        </Field>
      </div>
      {wardId && stations.data && stations.data.items.length === 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="flex-1">No polling stations are loaded for {wardName} Ward yet. Import the IEBC register under Data imports, or add this station by hand.</p>
          <button className="btn-outline" disabled={busy} onClick={() => void addStation()}>Add a polling station</button>
        </div>
      )}
      <div className="flex flex-col-reverse gap-2 border-t border-gray-100 pt-4 sm:flex-row sm:items-center">
        {wardId && !!stations.data?.items.length && <button className="link text-sm" disabled={busy} onClick={() => void addStation()}>Station missing? Add it</button>}
        <div className="flex flex-col-reverse gap-2 sm:ml-auto sm:flex-row">
          <button className="btn-outline" onClick={onClose}>Close</button>
          <button className="btn-accent" disabled={busy || !stationId} onClick={() => void save()}>{busy ? 'Saving…' : 'Save assignment'}</button>
        </div>
      </div>
      {msg.ok && <Success>{msg.ok}</Success>}
      {msg.err && <ErrorBox error={msg.err} />}
    </div>
  );
}

/** Agent vetting: a different administrator confirms identity, phone and accreditation. */
function VetAgent({ agent, onClose }: { agent: UserRow; onClose: (m?: { err?: string }) => void }) {
  const ident = useApi<{ fullName: string; source: string; locked: boolean; nationalId: string | null; kraPin: string | null; verifiedAt: string | null; email: string; emailVerified: boolean; phoneMasked: string | null }>(`/admin/users/${agent._id}/identity`);
  const [form, setForm] = useState({ identityChecked: false, phoneChecked: false, accreditationChecked: false, accreditationReference: '', note: '' });
  const [err, setErr] = useState<string>();
  const decide = async (decision: 'APPROVE' | 'REJECT') => {
    try {
      await api(`/admin/users/${agent._id}/vetting`, { body: { decision, ...form, accreditationReference: form.accreditationReference || undefined } });
      onClose({});
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const all = form.identityChecked && form.phoneChecked && form.accreditationChecked && form.accreditationReference.trim().length > 0;
  return (
    <section className="space-y-3">
      {ident.data && (
        <dl className="grid gap-1 rounded bg-gray-50 p-3 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-gray-500">Name</dt><dd>{ident.data.fullName}{ident.data.locked && <span className="ml-1 text-xs text-green-800">(from KRA, locked)</span>}</dd></div>
          <div><dt className="text-xs text-gray-500">Identity source</dt><dd>{ident.data.source === 'KRA_PIN_CHECKER' ? `KRA PIN Checker, ${fmtDateTime(ident.data.verifiedAt)}` : 'Entered by administrator'}</dd></div>
          <div><dt className="text-xs text-gray-500">National ID</dt><dd>{ident.data.nationalId ?? '—'}</dd></div>
          <div><dt className="text-xs text-gray-500">KRA PIN</dt><dd>{ident.data.kraPin ?? '—'}</dd></div>
          <div><dt className="text-xs text-gray-500">Email</dt><dd>{ident.data.email} {ident.data.emailVerified && '(verified)'}</dd></div>
          <div><dt className="text-xs text-gray-500">Phone</dt><dd>{ident.data.phoneMasked ?? '—'}</dd></div>
          <p className="text-xs text-gray-500 sm:col-span-2">Viewing these details is recorded in the audit log. Compare them with the agent's ID card.</p>
        </dl>
      )}
      <label className="flex items-center gap-3 rounded-lg border border-gray-200 p-3 text-sm"><input type="checkbox" checked={form.identityChecked} onChange={(e) => setForm({ ...form, identityChecked: e.target.checked })} /> National ID / passport checked against the name on the account</label>
      <label className="flex items-center gap-3 rounded-lg border border-gray-200 p-3 text-sm"><input type="checkbox" checked={form.phoneChecked} onChange={(e) => setForm({ ...form, phoneChecked: e.target.checked })} /> Phone number confirmed (call or SMS code)</label>
      <label className="flex items-center gap-3 rounded-lg border border-gray-200 p-3 text-sm"><input type="checkbox" checked={form.accreditationChecked} onChange={(e) => setForm({ ...form, accreditationChecked: e.target.checked })} /> Accreditation / appointment letter checked</label>
      <Field label="Accreditation reference"><input className="input" value={form.accreditationReference} onChange={(e) => setForm({ ...form, accreditationReference: e.target.value })} placeholder="e.g. letter number or accreditation ID" /></Field>
      <Field label="Note (what you checked)"><textarea className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
      {err && <ErrorBox error={err} />}
      <div className="flex flex-col-reverse gap-2 border-t border-gray-100 pt-4 sm:flex-row sm:justify-end">
        <button className="btn-outline" onClick={() => onClose()}>Cancel</button>
        <button className="btn-danger" disabled={form.note.length < 5} onClick={() => decide('REJECT')}>Reject</button>
        <button className="btn-accent" disabled={!all || form.note.length < 5} onClick={() => decide('APPROVE')}>Approve agent</button>
      </div>
    </section>
  );
}
