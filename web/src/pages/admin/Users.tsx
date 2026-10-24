import { useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import { ROLE_LABELS, useAuth, type Role } from '../../lib/auth';
import { ErrorBox, Field, Loading, PageHeader, Pager, Success } from '../../components/ui';
import { fmtDateTime } from '../../lib/format';
import { useApi } from '../../lib/useApi';

interface UserRow { _id: string; fullName: string; email: string; role: Role; agentCode?: string; status: string; lastLoginAt?: string; mfa: { enabled: boolean }; phoneMasked?: string; scope: { countyIds: string[] }; vetting?: { status: string; note?: string; accreditationReference?: string } }

export default function Users() {
  const { user } = useAuth();
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
      e.currentTarget.reset();
      void list.reload();
    } catch (x) {
      setErr((x as Error).message);
    }
  }

  async function action(u: UserRow, act: string) {
    setErr(undefined);
    const reason = act === 'revoke-sessions' || act === 'reset-password' ? undefined : window.prompt(`Reason to ${act} ${u.fullName}:`);
    if (reason === null) return;
    try {
      const r = await api<{ temporaryPassword?: string }>(`/admin/users/${u._id}/${act}`, { body: reason ? { reason } : {} });
      if (r?.temporaryPassword) setCreated({ email: u.email, agentCode: u.agentCode, temporaryPassword: r.temporaryPassword });
      void list.reload();
    } catch (x) {
      setErr((x as Error).message);
    }
  }

  const creatable: Role[] = user?.role === 'SUPER_ADMIN' ? Object.keys(ROLE_LABELS) as Role[] : user?.role === 'REGIONAL_ADMIN' ? ['COUNTY_ADMIN', 'CONSTITUENCY_SUPERVISOR', 'VERIFICATION_OFFICER', 'FINANCE_OFFICER', 'AGENT'] : user?.role === 'COUNTY_ADMIN' ? ['CONSTITUENCY_SUPERVISOR', 'AGENT'] : ['AGENT'];

  return (
    <div className="space-y-6">
      <PageHeader title="Users & agents" subtitle="Create, suspend, revoke and reassign accounts. Every change is recorded in the audit log." />
      {created && <Success>Account {created.agentCode ?? created.email} — temporary password: <code className="select-all rounded bg-white px-1">{created.temporaryPassword}</code>. Share it through a secure channel; it is shown only once and must be changed at first sign-in. New agents must be approved by a different administrator before they can count.</Success>}
      {err && <ErrorBox error={err} />}
      <form className="card grid gap-3 sm:grid-cols-3" onSubmit={create}>
        <h2 className="font-bold sm:col-span-3">Create account</h2>
        <Field label="Full name"><input name="fullName" className="input" required /></Field>
        <Field label="Email"><input name="email" type="email" className="input" required /></Field>
        <Field label="Phone (optional)"><input name="phone" className="input" placeholder="07XX XXX XXX" /></Field>
        <Field label="Role"><select name="role" className="input">{creatable.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></Field>
        <Field label="County scope" hint="Required for county administrators; optional for officers."><select name="countyIds" className="input" multiple>{counties?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select></Field>
        <div className="flex items-end"><button className="btn-primary">Create</button></div>
      </form>

      <div className="card">
        <div className="mb-3 flex flex-wrap gap-2">
          <input className="input max-w-xs" placeholder="Search name, email or agent ID" onKeyDown={(e) => e.key === 'Enter' && setFilter({ ...filter, q: (e.target as HTMLInputElement).value })} />
          <button className={filter.vetting === 'PENDING' ? 'btn-primary' : 'btn-outline'} onClick={() => setFilter(filter.vetting === 'PENDING' ? {} : { vetting: 'PENDING' })}>Agents awaiting approval</button>
          <select className="input max-w-xs" onChange={(e) => setFilter({ ...filter, role: e.target.value || undefined })}><option value="">All roles</option>{Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </div>
        {list.loading && <Loading />}
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Agent approval</th><th>MFA</th><th>Last login</th><th>Actions</th></tr></thead>
            <tbody>
              {list.data?.items.map((u) => (
                <tr key={u._id}>
                  <td><p className="font-medium">{u.fullName}</p><p className="text-xs text-gray-500">{u.agentCode ?? u.email} {u.phoneMasked}</p></td>
                  <td>{ROLE_LABELS[u.role]}</td>
                  <td>{u.status}</td>
                  <td>{u.role === 'AGENT' ? <span className={u.vetting?.status === 'APPROVED' ? 'text-green-800' : u.vetting?.status === 'REJECTED' ? 'text-red-700' : 'font-semibold text-amber-800'}>{u.vetting?.status ?? 'PENDING'}</span> : '—'}</td>
                  <td>{u.mfa.enabled ? 'On' : 'Off'}</td>
                  <td className="text-xs">{fmtDateTime(u.lastLoginAt)}</td>
                  <td className="space-x-1 whitespace-nowrap text-xs">
                    {u.role === 'AGENT' && u.vetting?.status !== 'APPROVED' && <button className="link font-semibold" onClick={() => setVetting(u)}>Review approval</button>}
                    {u.role === 'AGENT' && <button className="link" onClick={() => setSelected(u)}>Assign</button>}
                    {u.status === 'ACTIVE' && <button className="link" onClick={() => action(u, 'suspend')}>Suspend</button>}
                    {u.status === 'SUSPENDED' && <button className="link" onClick={() => action(u, 'reactivate')}>Reactivate</button>}
                    {u.status !== 'REVOKED' && <button className="link text-red-700" onClick={() => action(u, 'revoke')}>Revoke</button>}
                    <button className="link" onClick={() => action(u, 'revoke-sessions')}>End sessions</button>
                    <button className="link" onClick={() => action(u, 'reset-password')}>Reset password</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.data && <Pager page={page} total={list.data.total} limit={list.data.limit} onPage={setPage} />}
      </div>
      {selected && <AssignAgent agent={selected} onClose={() => setSelected(null)} />}
      {vetting && <VetAgent agent={vetting} onClose={(m) => { setVetting(null); if (m) setCreated(undefined); void list.reload(); if (m?.err) setErr(m.err); }} />}
    </div>
  );
}

function AssignAgent({ agent, onClose }: { agent: UserRow; onClose: () => void }) {
  const { data: el } = useApi<{ items: { _id: string; name: string }[] }>('/admin/elections');
  const [electionId, setElectionId] = useState('');
  const eid = electionId || el?.items[0]?._id || '';
  const [countyId, setCountyId] = useState('');
  const [consId, setConsId] = useState('');
  const [wardId, setWardId] = useState('');
  const { data: counties } = useApi<{ items: { _id: string; name: string }[] }>('/public/counties');
  const { data: consts } = useApi<{ items: { _id: string; name: string }[] }>(eid && countyId ? `/public/elections/${eid}/constituencies` : null, { countyId });
  const { data: wards } = useApi<{ items: { _id: string; name: string }[] }>(eid && consId ? `/public/elections/${eid}/wards` : null, { constituencyId: consId });
  const { data: stations } = useApi<{ items: { _id: string; code: string; name: string }[] }>(eid && wardId ? `/public/elections/${eid}/stations` : null, { wardId });
  const current = useApi<{ items: { _id: string; pollingStationId: { code: string; name: string }; electionId: string }[] }>('/admin/assignments', { userId: agent._id });
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  async function assign(stationId: string) {
    try {
      await api('/admin/assignments', { body: { userId: agent._id, electionId: eid, pollingStationId: stationId, replaceExisting: true } });
      setMsg({ ok: 'Assigned. Previous assignments for this election were revoked.' });
      void current.reload();
    } catch (e) {
      setMsg({ err: (e as Error).message });
    }
  }
  return (
    <div className="card space-y-3 border-brand-500">
      <div className="flex justify-between"><h2 className="font-bold">Assign {agent.fullName} ({agent.agentCode})</h2><button className="link" onClick={onClose}>Close</button></div>
      <p className="text-sm">Current: {current.data?.items.length ? current.data.items.map((a) => `${a.pollingStationId.code} ${a.pollingStationId.name}`).join('; ') : 'none'}</p>
      {current.data?.items.map((a) => <button key={a._id} className="link mr-2 text-xs text-red-700" onClick={async () => { const reason = prompt('Reason for revoking this assignment'); if (!reason) return; await api(`/admin/assignments/${a._id}/revoke`, { body: { reason } }); void current.reload(); }}>Revoke {a.pollingStationId.code}</button>)}
      <div className="grid gap-2 sm:grid-cols-4">
        <select className="input" value={eid} onChange={(e) => setElectionId(e.target.value)}>{el?.items.map((e) => <option key={e._id} value={e._id}>{e.name}</option>)}</select>
        <select className="input" value={countyId} onChange={(e) => { setCountyId(e.target.value); setConsId(''); setWardId(''); }}><option value="">County…</option>{counties?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select>
        <select className="input" value={consId} onChange={(e) => { setConsId(e.target.value); setWardId(''); }}><option value="">Constituency…</option>{consts?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select>
        <select className="input" value={wardId} onChange={(e) => setWardId(e.target.value)}><option value="">Ward…</option>{wards?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select>
      </div>
      <ul className="max-h-60 overflow-auto text-sm">{stations?.items.map((s) => <li key={s._id} className="flex justify-between border-b py-1"><span>{s.code} — {s.name}</span><button className="link" onClick={() => assign(s._id)}>Assign here</button></li>)}</ul>
      {msg.ok && <Success>{msg.ok}</Success>}
      {msg.err && <ErrorBox error={msg.err} />}
    </div>
  );
}

/** Agent vetting: a different administrator confirms identity, phone and accreditation. */
function VetAgent({ agent, onClose }: { agent: UserRow; onClose: (m?: { err?: string }) => void }) {
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
    <section className="card space-y-3 border-brand-500">
      <div className="flex justify-between"><h2 className="font-bold">Approve agent {agent.fullName} ({agent.agentCode})</h2><button className="link" onClick={() => onClose()}>Close</button></div>
      <p className="text-sm text-gray-600">Approve only after checking in person or by video. The administrator who created this account cannot approve it.</p>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.identityChecked} onChange={(e) => setForm({ ...form, identityChecked: e.target.checked })} /> National ID / passport checked against the name on the account</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.phoneChecked} onChange={(e) => setForm({ ...form, phoneChecked: e.target.checked })} /> Phone number confirmed (call or SMS code)</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.accreditationChecked} onChange={(e) => setForm({ ...form, accreditationChecked: e.target.checked })} /> Accreditation / appointment letter checked</label>
      <Field label="Accreditation reference"><input className="input" value={form.accreditationReference} onChange={(e) => setForm({ ...form, accreditationReference: e.target.value })} placeholder="e.g. letter number or accreditation ID" /></Field>
      <Field label="Note (what you checked)"><textarea className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
      {err && <ErrorBox error={err} />}
      <div className="flex gap-2">
        <button className="btn-primary" disabled={!all || form.note.length < 5} onClick={() => decide('APPROVE')}>Approve agent</button>
        <button className="btn-danger" disabled={form.note.length < 5} onClick={() => decide('REJECT')}>Reject</button>
      </div>
    </section>
  );
}
