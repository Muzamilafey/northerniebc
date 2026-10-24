import { useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import { ErrorBox, Field, PageHeader, StatusBadge, Success } from '../../components/ui';
import { fmtDate, POSITION_LABELS, POSITIONS } from '../../lib/format';
import { useApi } from '../../lib/useApi';

const FIELDS = ['registeredVoters', 'totalVotesCast', 'rejectedVotes', 'rejectedObjectedTo', 'disputedVotes', 'validVotes'];
const RULES: [string, string][] = [
  ['CANDIDATE_SUM_EQUALS_VALID', 'Candidate votes sum to valid votes'],
  ['VALID_PLUS_REJECTED_EQUALS_CAST', 'Valid + rejected = total cast'],
  ['CAST_NOT_EXCEEDING_REGISTERED', 'Votes cast do not exceed registered voters'],
  ['REGISTERED_MATCHES_STATION_REGISTER', 'Registered voters match the station register']
];
interface PositionCfg { position: string; enabled: boolean; formReferenceLabel: string; requiredFields: string[]; rules: string[]; requireEvidence: boolean }
interface Election { _id: string; name: string; slug: string; type: string; electionDate: string; status: string; publishProvisional: boolean; positions: PositionCfg[] }

const NEXT: Record<string, string[]> = { DRAFT: ['ACTIVE'], ACTIVE: ['CLOSED'], CLOSED: ['ACTIVE', 'ARCHIVED'], ARCHIVED: [] };

export default function Elections() {
  const list = useApi<{ items: Election[] }>('/admin/elections');
  const [err, setErr] = useState<string>();
  const [ok, setOk] = useState<string>();
  const [editing, setEditing] = useState<Election | null>(null);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setErr(undefined);
    try {
      await api('/admin/elections', { body: { name: f.get('name'), slug: f.get('slug'), type: f.get('type'), electionDate: f.get('electionDate'), positions: [] } });
      setOk('Election created as DRAFT. Configure positions and rules from the official documentation, then import the register.');
      void list.reload();
    } catch (x) {
      setErr((x as Error).message);
    }
  }
  async function patch(id: string, body: unknown) {
    setErr(undefined);
    try {
      await api(`/admin/elections/${id}`, { method: 'PATCH', body });
      setOk('Saved');
      void list.reload();
    } catch (x) {
      setErr((x as Error).message);
    }
  }
  return (
    <div className="space-y-6">
      <PageHeader title="Election setup" subtitle="Configure elections, positions and reconciliation rules from authoritative election documentation. Register and candidates are loaded through Data imports." />
      {ok && <Success>{ok}</Success>}
      {err && <ErrorBox error={err} />}
      <form className="card grid gap-3 sm:grid-cols-5" onSubmit={create}>
        <Field label="Name"><input name="name" className="input" required /></Field>
        <Field label="Slug"><input name="slug" className="input" pattern="[a-z0-9-]{3,80}" required /></Field>
        <Field label="Type"><select name="type" className="input"><option value="GENERAL">General election</option><option value="BY_ELECTION">By-election</option></select></Field>
        <Field label="Election date"><input name="electionDate" type="date" className="input" required /></Field>
        <div className="flex items-end"><button className="btn-primary">Create</button></div>
      </form>
      {list.data?.items.map((e) => (
        <section key={e._id} className="card">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><p className="font-bold">{e.name}</p><p className="text-xs text-gray-500">{e.type} · {fmtDate(e.electionDate)} · ID {e._id}</p></div>
            <div className="flex items-center gap-2"><StatusBadge status={e.status} />{NEXT[e.status]!.map((s) => <button key={s} className="btn-outline px-2 py-1 text-xs" onClick={() => confirm(`Move to ${s}?`) && patch(e._id, { status: s })}>→ {s}</button>)}</div>
          </div>
          <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={e.publishProvisional} onChange={(x) => patch(e._id, { publishProvisional: x.target.checked })} /> Publish provisional (unverified) agent results to the public, clearly labelled</label>
          <p className="mt-2 text-sm">Positions: {e.positions.filter((p) => p.enabled).map((p) => POSITION_LABELS[p.position]).join(', ') || 'none configured'} <button className="link ml-2" onClick={() => setEditing(e)}>Configure positions</button></p>
          {editing?._id === e._id && <PositionEditor election={e} onSave={(positions) => { void patch(e._id, { positions }); setEditing(null); }} />}
        </section>
      ))}
    </div>
  );
}

function PositionEditor({ election, onSave }: { election: Election; onSave: (p: PositionCfg[]) => void }) {
  const [cfg, setCfg] = useState<PositionCfg[]>(() => POSITIONS.map((p) => election.positions.find((x) => x.position === p) ?? { position: p, enabled: false, formReferenceLabel: 'Official results form reference', requiredFields: [], rules: ['CANDIDATE_SUM_EQUALS_VALID'], requireEvidence: true }));
  const upd = (i: number, v: Partial<PositionCfg>) => setCfg(cfg.map((c, j) => (j === i ? { ...c, ...v } : c)));
  const toggle = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  return (
    <div className="mt-3 space-y-3 rounded-lg border p-3">
      <p className="text-xs text-amber-900">Apply only the rules and fields that the official forms for this election require. Rules flag discrepancies for reviewers; figures are never adjusted.</p>
      {cfg.map((c, i) => (
        <div key={c.position} className="border-b pb-2">
          <label className="flex items-center gap-2 font-semibold"><input type="checkbox" checked={c.enabled} onChange={(e) => upd(i, { enabled: e.target.checked })} /> {POSITION_LABELS[c.position]}</label>
          {c.enabled && (
            <div className="mt-2 grid gap-2 text-xs sm:grid-cols-3">
              <label>Form reference label<input className="input" value={c.formReferenceLabel} onChange={(e) => upd(i, { formReferenceLabel: e.target.value })} /></label>
              <div>Required fields{FIELDS.map((f) => <label key={f} className="block"><input type="checkbox" checked={c.requiredFields.includes(f)} onChange={() => upd(i, { requiredFields: toggle(c.requiredFields, f) })} /> {f}</label>)}</div>
              <div>Reconciliation rules{RULES.map(([r, l]) => <label key={r} className="block"><input type="checkbox" checked={c.rules.includes(r)} onChange={() => upd(i, { rules: toggle(c.rules, r) })} /> {l}</label>)}<label className="mt-1 block"><input type="checkbox" checked={c.requireEvidence} onChange={(e) => upd(i, { requireEvidence: e.target.checked })} /> Require photo of form</label></div>
            </div>
          )}
        </div>
      ))}
      <button className="btn-primary" onClick={() => onSave(cfg.filter((c) => c.enabled))}>Save positions</button>
    </div>
  );
}
