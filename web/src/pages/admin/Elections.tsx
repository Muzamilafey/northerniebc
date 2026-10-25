import { useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import { Empty, ErrorBox, Field, PageHeader, Segmented, Success } from '../../components/ui';
import { Icon } from '../../components/icons';
import { Countdown } from '../../components/Countdown';
import { fmtDate, POSITION_LABELS, POSITIONS } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import { Modal, ModalActions, useDialog } from '../../components/Dialog';

const FIELDS = ['registeredVoters', 'totalVotesCast', 'rejectedVotes', 'rejectedObjectedTo', 'disputedVotes', 'validVotes'];
const RULES: [string, string][] = [
  ['CANDIDATE_SUM_EQUALS_VALID', 'Candidate votes sum to valid votes'],
  ['VALID_PLUS_REJECTED_EQUALS_CAST', 'Valid + rejected = total cast'],
  ['CAST_NOT_EXCEEDING_REGISTERED', 'Votes cast do not exceed registered voters'],
  ['REGISTERED_MATCHES_STATION_REGISTER', 'Registered voters match the station register']
];
interface PositionCfg { position: string; enabled: boolean; formCode?: string; formReferenceLabel: string; requiredFields: string[]; rules: string[]; requireEvidence: boolean }
interface Intake { mode: 'OPEN' | 'CLOSED' | 'SCHEDULED'; opensAt?: string | null; closesAt?: string | null }
interface Election { _id: string; name: string; slug: string; type: string; electionDate: string; status: string; publishProvisional: boolean; positions: PositionCfg[]; resultsIntake?: Intake; intake?: { open: boolean; message: string; mode: string; opensAt: string | null; closesAt: string | null }; agentNotice?: { text?: string; updatedAt?: string } }

/** East Africa Time is UTC+3 all year (no daylight saving). datetime-local values are entered in EAT. */
function AgentNotice({ election, onSave }: { election: Election; onSave: (text: string) => Promise<void> }) {
  const saved = election.agentNotice?.text ?? '';
  const [text, setText] = useState(saved);
  const [busy, setBusy] = useState(false);
  const save = async (t: string) => {
    setBusy(true);
    try {
      await onSave(t);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 rounded-xl border border-gray-200 p-4">
      <p className="font-semibold text-navy-900">Message to agents</p>
      <p className="text-xs text-gray-500">Shown at the top of every assigned agent's screen within a few seconds, e.g. opening time, what to bring, who to call.{election.agentNotice?.updatedAt && saved ? ` Last changed ${new Date(election.agentNotice.updatedAt).toLocaleString('en-GB', { timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short' })} EAT.` : ''}</p>
      <textarea className="input mt-2" rows={2} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} placeholder="No message" aria-label="Message to agents" />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-gray-400">{text.length}/500</span>
        <div className="flex gap-2">
          {saved && <button className="btn-ghost btn-sm text-red-700" disabled={busy} onClick={() => { setText(''); void save(''); }}>Remove message</button>}
          <button className="btn-accent btn-sm" disabled={busy || text.trim() === saved} onClick={() => void save(text.trim())}>{busy ? 'Saving…' : saved ? 'Update message' : 'Send to agents'}</button>
        </div>
      </div>
    </div>
  );
}

const toEatInput = (iso?: string | null) => (iso ? new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(0, 16) : '');
const fromEatInput = (v: string) => (v ? new Date(`${v}:00+03:00`).toISOString() : null);

function IntakeControl({ election, onSave, onTick }: { election: Election; onSave: (intake: Intake) => Promise<void>; onTick: () => void }) {
  const cur = election.resultsIntake ?? { mode: 'OPEN' as const };
  const [mode, setMode] = useState<Intake['mode']>(cur.mode ?? 'OPEN');
  const [opens, setOpens] = useState(toEatInput(cur.opensAt));
  const [closes, setCloses] = useState(toEatInput(cur.closesAt));
  const [busy, setBusy] = useState(false);
  const dirty = mode !== (cur.mode ?? 'OPEN') || opens !== toEatInput(cur.opensAt) || closes !== toEatInput(cur.closesAt);
  const save = async () => {
    setBusy(true);
    try {
      await onSave(mode === 'SCHEDULED' ? { mode, opensAt: fromEatInput(opens), closesAt: fromEatInput(closes) } : { mode, opensAt: null, closesAt: null });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 rounded-xl border border-gray-200 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-semibold text-navy-900">Receiving results from agents</p>
          <p className={`mt-1 inline-flex items-center gap-2 text-sm ${election.intake?.open ? 'text-green-800' : 'text-amber-900'}`}>
            <span className={`h-2 w-2 rounded-full ${election.intake?.open ? 'bg-green-600' : 'bg-amber-500'}`} aria-hidden="true" />
            {election.intake?.open ? 'Open now' : 'Not receiving now'} — {election.intake?.message}
          </p>
          {election.intake && !election.intake.open && election.intake.mode === 'SCHEDULED' && election.intake.opensAt && new Date(election.intake.opensAt) > new Date() && <p className="mt-1 text-sm text-gray-700">Opens in <Countdown to={election.intake.opensAt} onDone={onTick} /></p>}
          {election.intake?.open && election.intake.closesAt && <p className="mt-1 text-sm text-gray-700">Closes in <Countdown to={election.intake.closesAt} onDone={onTick} /></p>}
        </div>
        <Segmented label="Receiving results" value={mode} onChange={setMode} options={[{ value: 'OPEN', label: 'Open' }, { value: 'CLOSED', label: 'Paused' }, { value: 'SCHEDULED', label: 'Scheduled' }]} />
      </div>
      {mode === 'SCHEDULED' && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Opens (East Africa Time)" hint="Leave blank to open straight away."><input type="datetime-local" className="input" value={opens} onChange={(e) => setOpens(e.target.value)} /></Field>
          <Field label="Closes (East Africa Time)" hint="Leave blank to stay open until you change it."><input type="datetime-local" className="input" value={closes} onChange={(e) => setCloses(e.target.value)} /></Field>
        </div>
      )}
      <p className="mt-3 text-xs text-gray-500">While results are not being received, agents cannot record counts or submit results; the counting screen tells them when results open. All times are East Africa Time (UTC+3).</p>
      {dirty && (
        <div className="mt-3 flex justify-end gap-2">
          <button className="btn-outline btn-sm" onClick={() => { setMode(cur.mode ?? 'OPEN'); setOpens(toEatInput(cur.opensAt)); setCloses(toEatInput(cur.closesAt)); }}>Cancel</button>
          <button className="btn-accent btn-sm" disabled={busy || (mode === 'SCHEDULED' && !opens && !closes)} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      )}
    </div>
  );
}

const NEXT: Record<string, string[]> = { DRAFT: ['ACTIVE'], ACTIVE: ['CLOSED'], CLOSED: ['ACTIVE', 'ARCHIVED'], ARCHIVED: [] };

export default function Elections() {
  const dialog = useDialog();
  // Refreshes so the 'receiving results' status follows the schedule without reloading the page.
  const list = useApi<{ items: Election[] }>('/admin/elections', undefined, { refreshMs: 5000 });
  const [err, setErr] = useState<string>();
  const [ok, setOk] = useState<string>();
  const [editing, setEditing] = useState<Election | null>(null);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setErr(undefined);
    try {
      await api('/admin/elections', { body: { name: f.get('name'), slug: f.get('slug'), type: f.get('type'), electionDate: f.get('electionDate'), positions: [] } });
      setOk('Election created as a draft. Configure its positions next.');
      setCreating(false);
      setDraft({ name: '', slug: '' });
      setSlugTouched(false);
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
  const [creating, setCreating] = useState(false);
  const [slugTouched, setSlugTouched] = useState(false);
  const [draft, setDraft] = useState({ name: '', slug: '' });
  const humanStatus = (st: string) => st.charAt(0) + st.slice(1).toLowerCase();
  const statusCls: Record<string, string> = { DRAFT: 'bg-gray-100 text-gray-700', ACTIVE: 'bg-green-100 text-green-800', CLOSED: 'bg-amber-100 text-amber-900', ARCHIVED: 'bg-gray-200 text-gray-600' };
  const move = async (e: Election, st: string) => {
    if (await dialog.confirm({ title: `Move “${e.name}” to ${humanStatus(st)}?`, message: st === 'ACTIVE' ? 'Agents can start counting and submitting results.' : st === 'CLOSED' ? 'No further submissions will be accepted.' : 'The election is archived for the record.', confirmLabel: `Move to ${humanStatus(st)}`, tone: st === 'CLOSED' || st === 'ARCHIVED' ? 'danger' : 'primary' })) void patch(e._id, { status: st });
  };
  return (
    <div className="space-y-6">
      <PageHeader
        title="Election setup"
        subtitle="Elections, contested positions and reconciliation rules — set from the official election documentation."
        actions={<button className="btn-accent" onClick={() => { setErr(undefined); setCreating(true); }}><Icon name="plus" className="h-4 w-4" /> New election</button>}
      />
      {ok && <Success>{ok}</Success>}
      {err && !creating && <ErrorBox error={err} />}
      {list.data?.items.length === 0 && <Empty title="No elections yet" action={<button className="btn-accent" onClick={() => setCreating(true)}><Icon name="plus" className="h-4 w-4" /> Create the first election</button>}>Create an election, then enable its positions and load the register.</Empty>}

      <div className="space-y-4">
        {list.data?.items.map((e) => {
          const enabled = e.positions.filter((p) => p.enabled);
          return (
            <section key={e._id} className="card">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-bold text-navy-900">{e.name}</h2>
                    <span className={`badge ${statusCls[e.status] ?? 'bg-gray-100 text-gray-700'}`}>{humanStatus(e.status)}</span>
                  </div>
                  <p className="mt-1 text-sm text-gray-600">{e.type === 'BY_ELECTION' ? 'By-election' : 'General election'} · {fmtDate(e.electionDate)}</p>
                  <p className="mt-0.5 text-xs text-gray-400">ID {e._id}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className="btn-outline btn-sm" onClick={() => setEditing(e)}>Configure positions</button>
                  {NEXT[e.status]!.map((st) => <button key={st} className={st === 'ACTIVE' ? 'btn-accent btn-sm' : 'btn-outline btn-sm'} onClick={() => void move(e, st)}>{st === 'ACTIVE' ? (e.status === 'DRAFT' ? 'Activate' : 'Reopen') : st === 'CLOSED' ? 'Close voting' : 'Archive'}</button>)}
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {enabled.length ? enabled.map((p) => <span key={p.position} className="badge bg-navy-50 text-navy-800">{POSITION_LABELS[p.position]}{p.formCode ? ` · Form ${p.formCode}` : ''}</span>) : <span className="text-sm text-amber-800">No positions enabled yet — configure them before activating.</span>}
              </div>
              <IntakeControl key={JSON.stringify(e.resultsIntake ?? {})} election={e} onSave={(resultsIntake) => patch(e._id, { resultsIntake })} onTick={() => void list.reload()} />
              <AgentNotice key={e.agentNotice?.updatedAt ?? 'none'} election={e} onSave={(text) => patch(e._id, { agentNotice: { text } })} />
              <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 bg-gray-50/60 p-3 text-sm">
                <input type="checkbox" className="mt-0.5" checked={e.publishProvisional} onChange={(x) => void patch(e._id, { publishProvisional: x.target.checked })} />
                <span><span className="font-semibold">Publish provisional results</span><span className="block text-gray-600">Show unverified agent results to the public, clearly labelled as provisional.</span></span>
              </label>
            </section>
          );
        })}
      </div>

      {creating && (
        <Modal title="New election" description="It starts as a draft. Enable positions and load the register before activating it." icon={false} onClose={() => setCreating(false)}>
          <form className="space-y-4" onSubmit={async (ev) => { await create(ev); }}>
            <Field label="Name"><input name="name" className="input" required autoFocus value={draft.name} onChange={(ev) => { const name = ev.target.value; setDraft({ name, slug: slugTouched ? draft.slug : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) }); }} placeholder="e.g. General Election 2027" /></Field>
            <Field label="Web address (slug)" hint="Lowercase letters, numbers and dashes."><input name="slug" className="input" pattern="[a-z0-9-]{3,80}" required value={draft.slug} onChange={(ev) => { setSlugTouched(true); setDraft({ ...draft, slug: ev.target.value }); }} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Type"><select name="type" className="input"><option value="GENERAL">General election</option><option value="BY_ELECTION">By-election</option></select></Field>
              <Field label="Election date"><input name="electionDate" type="date" className="input" required /></Field>
            </div>
            {err && <ErrorBox error={err} />}
            <ModalActions onCancel={() => setCreating(false)} confirmLabel="Create election" tone="accent" />
          </form>
        </Modal>
      )}
      {editing && (
        <Modal title={`Positions — ${editing.name}`} description="Enable each contested position and the checks its official form requires." icon={false} size="lg" onClose={() => setEditing(null)}>
          <PositionEditor election={editing} onCancel={() => setEditing(null)} onSave={(positions) => { void patch(editing._id, { positions }); setEditing(null); }} />
        </Modal>
      )}
    </div>
  );
}

function PositionEditor({ election, onSave, onCancel }: { election: Election; onSave: (p: PositionCfg[]) => void; onCancel: () => void }) {
  const { data: tpl } = useApi<{ templates: Record<string, { formCode: string; title: string; requiredFields: string[]; rules: string[] }>; note: string }>('/admin/form-templates');
  const [cfg, setCfg] = useState<PositionCfg[]>(() => POSITIONS.map((p) => election.positions.find((x) => x.position === p) ?? { position: p, enabled: false, formReferenceLabel: 'Official results form reference', requiredFields: [], rules: ['CANDIDATE_SUM_EQUALS_VALID'], requireEvidence: true }));
  const upd = (i: number, v: Partial<PositionCfg>) => setCfg(cfg.map((c, j) => (j === i ? { ...c, ...v } : c)));
  const toggle = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  return (
    <div className="space-y-3">
      <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">Apply only the rules and fields the official forms for this election require. Rules flag discrepancies for reviewers; figures are never adjusted.{tpl ? ` ${tpl.note}` : ''}</p>
      {cfg.map((c, i) => (
        <div key={c.position} className={`rounded-xl border p-3 transition ${c.enabled ? 'border-navy-600/40 bg-navy-50/30' : 'border-gray-200'}`}>
          <label className="flex cursor-pointer items-center gap-3 font-semibold"><input type="checkbox" checked={c.enabled} onChange={(e) => upd(i, { enabled: e.target.checked })} /> {POSITION_LABELS[c.position]}</label>
          {c.enabled && (
            <div className="mt-3 grid gap-4 text-xs sm:grid-cols-3">
              <div className="space-y-1">
                <label>Official form code<input className="input" value={c.formCode ?? ''} placeholder={tpl?.templates[c.position]?.formCode} onChange={(e) => upd(i, { formCode: e.target.value.toUpperCase() || undefined })} /></label>
                <label>Form reference label<input className="input" value={c.formReferenceLabel} onChange={(e) => upd(i, { formReferenceLabel: e.target.value })} /></label>
                {tpl?.templates[c.position] && <button type="button" className="btn-outline px-2 py-1 text-xs" onClick={() => { const t = tpl.templates[c.position]!; upd(i, { formCode: t.formCode, requiredFields: t.requiredFields, rules: t.rules, formReferenceLabel: `${t.title.split(' —')[0]} serial number` }); }}>Apply {tpl.templates[c.position]!.title.split(' —')[0]} template</button>}
              </div>
              <div>Required fields{FIELDS.map((f) => <label key={f} className="block"><input type="checkbox" checked={c.requiredFields.includes(f)} onChange={() => upd(i, { requiredFields: toggle(c.requiredFields, f) })} /> {f}</label>)}</div>
              <div>Reconciliation rules{RULES.map(([r, l]) => <label key={r} className="block"><input type="checkbox" checked={c.rules.includes(r)} onChange={() => upd(i, { rules: toggle(c.rules, r) })} /> {l}</label>)}<label className="mt-1 block"><input type="checkbox" checked={c.requireEvidence} onChange={(e) => upd(i, { requireEvidence: e.target.checked })} /> Require photo of form</label></div>
            </div>
          )}
        </div>
      ))}
      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
        <button className="btn-outline" onClick={onCancel}>Cancel</button>
        <button className="btn-accent" onClick={() => onSave(cfg.filter((c) => c.enabled))}>Save positions</button>
      </div>
    </div>
  );
}
