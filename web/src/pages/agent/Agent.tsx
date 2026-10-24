import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { draftKey, increment, newDraft, queue, setVotes, total, undoLast, type Change, type Draft, type UndoReason } from '../../lib/draft';
import { allDrafts, getDraft, onSync, onTally, saveChange, saveDraft, sendTallies, syncNow, type SyncStatus, type TallyStatus } from '../../lib/offline';
import { ErrorBox, Loading, Logo, PublicImage, StatusBadge, Success } from '../../components/ui';
import { fmtDateTime, fmtNumber, humanize, POSITION_LABELS } from '../../lib/format';
import { getMeta, setMeta } from '../../lib/offline';
import { Modal, ModalActions } from '../../components/Dialog';

interface Ballot {
  position: string;
  label: string;
  formCode: string;
  formTitle: string;
  formReferenceLabel: string;
  requiredFields: string[];
  rules: string[];
  requireEvidence: boolean;
  candidates: { id: string; fullName: string; party?: string; partyAbbreviation?: string; photoFileId?: string | null; partyLogoFileId?: string | null }[];
  submission: null | { submissionId: string; status: string; currentRevision: number; hasConflict: boolean };
}
interface Assignment {
  assignmentId: string;
  election: { id: string; name: string; status: string; acceptingSubmissions: boolean; intake?: { open: boolean; mode: string; opensAt: string | null; closesAt: string | null; message: string } };
  station: { id: string; code: string; name: string; registeredVoters: number | null };
  county?: string;
  constituency?: string;
  ward?: string;
  ballots: Ballot[];
}
interface AssignmentsResp { assignments: Assignment[]; declarationText: string; serverTime: string; vettingStatus: 'PENDING' | 'APPROVED' | 'REJECTED'; requireSubmitReauth: boolean; aiFormReading: boolean }

/** Assignments are cached on the device so counting works offline after the first sign-in. */
async function loadAssignments(): Promise<{ data: AssignmentsResp | null; fromCache: boolean; error?: string }> {
  try {
    const d = await api<AssignmentsResp>('/agent/assignments');
    await setMeta('assignments', d);
    return { data: d, fromCache: false };
  } catch (e) {
    const cached = await getMeta<AssignmentsResp>('assignments');
    return { data: cached ?? null, fromCache: true, error: (e as Error).message };
  }
}

export function useAssignments() {
  const [state, setState] = useState<{ data: AssignmentsResp | null; fromCache: boolean; error?: string; loading: boolean }>({ data: null, fromCache: false, loading: true });
  const reload = useCallback(async () => setState({ ...(await loadAssignments()), loading: false }), []);
  useEffect(() => void reload(), [reload]);
  return { ...state, reload };
}

const STATUS_STYLE: Record<SyncStatus, string> = {
  ONLINE: 'bg-green-100 text-green-800',
  OFFLINE: 'bg-gray-200 text-gray-800',
  SYNCING: 'bg-blue-100 text-blue-800',
  SYNCED: 'bg-green-100 text-green-800',
  SYNC_FAILED: 'bg-red-100 text-red-800'
};

export function SyncBar() {
  const [s, setS] = useState<{ status: SyncStatus; lastSyncAt?: number; pending: number }>({ status: navigator.onLine ? 'ONLINE' : 'OFFLINE', pending: 0 });
  useEffect(() => {
    const off = onSync(setS);
    return () => void off();
  }, []);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" aria-live="polite">
      <span className={`rounded-full px-2 py-0.5 font-bold ${STATUS_STYLE[s.status]}`}>{s.status.replace('_', ' ')}</span>
      {s.pending > 0 && <span>{s.pending} waiting to send</span>}
      <span className="text-gray-500">Last sync: {s.lastSyncAt ? fmtDateTime(new Date(s.lastSyncAt)) : 'never'}</span>
      <button className="btn-outline px-2 py-1 text-xs" onClick={() => void syncNow()}>Sync now</button>
    </div>
  );
}

export function AgentLayout() {
  const { user, signOut } = useAuth();
  const nav = useNavigate();
  useEffect(() => {
    void sendTallies();
    void syncNow();
    const t = setInterval(() => void syncNow(), 30_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-30 bg-navy-900 px-3 py-2 text-white">
        <div className="mx-auto flex max-w-2xl items-center justify-between">
          <Link to="/agent"><Logo size={32} /></Link>
          <div className="flex items-center gap-2 text-sm">
            <Link to="/agent/history" className="rounded px-2 py-1 hover:bg-white/10">History</Link>
            <button className="rounded px-2 py-1 hover:bg-white/10" onClick={async () => { await signOut(); nav('/login'); }}>Sign out</button>
          </div>
        </div>
      </header>
      <div className="mx-auto max-w-2xl px-3 py-2"><SyncBar /></div>
      <main id="main" className="mx-auto max-w-2xl px-3 pb-24">
        {user && <p className="mb-2 text-xs text-gray-500">{user.fullName} · {user.agentCode}</p>}
        <Outlet />
      </main>
    </div>
  );
}

export function AgentHome() {
  const { data, fromCache, error, loading } = useAssignments();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  useEffect(() => {
    void allDrafts().then((ds) => setDrafts(Object.fromEntries(ds.map((d) => [d.key, d]))));
  }, []);
  if (loading) return <Loading />;
  if (!data) return <ErrorBox error={error ?? 'Could not load assignments'} />;
  return (
    <div className="space-y-4">
      {fromCache && <p className="rounded bg-amber-50 p-2 text-xs text-amber-900">Offline — showing your last downloaded assignments.</p>}
      {data.vettingStatus !== 'APPROVED' && <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{data.vettingStatus === 'REJECTED' ? 'Your agent account was not approved. Contact your supervisor.' : 'Your agent account is awaiting approval. An administrator must confirm your identity and accreditation before you can count or submit results.'}</p>}
      {data.assignments.length === 0 && <p className="card text-sm">You have no active polling-station assignment. Contact your supervisor.</p>}
      {data.assignments.map((a) => (
        <section key={a.assignmentId} className="card">
          <p className="text-xs text-gray-500">{a.election.name}</p>
          <h1 className="text-lg font-bold text-navy-900">{a.station.code} — {a.station.name}</h1>
          <p className="text-xs text-gray-600">{[a.ward, a.constituency, a.county].filter(Boolean).join(', ')} · Registered voters: {fmtNumber(a.station.registeredVoters)}</p>
          <p className={`mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ${a.election.acceptingSubmissions ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-900'}`} role="status">
            <span className={`h-2 w-2 shrink-0 rounded-full ${a.election.acceptingSubmissions ? 'bg-green-600' : 'bg-amber-500'}`} aria-hidden="true" />
            {a.election.intake?.message ?? (a.election.acceptingSubmissions ? 'Receiving results.' : 'This election is not accepting results.')}
          </p>
          <ul className="mt-3 divide-y">
            {a.ballots.map((b) => {
              const d = drafts[draftKey(a.election.id, a.station.id, b.position)];
              return (
                <li key={b.position}>
                  <Link className="flex items-center justify-between gap-2 py-3" to={`/agent/count/${a.election.id}/${a.station.id}/${b.position}`}>
                    <span className="font-semibold">{b.label}</span>
                    <span className="flex items-center gap-2 text-xs">
                      {d && d.state !== 'SYNCED' && <span className="rounded bg-gray-100 px-2 py-0.5">{humanize(d.state)}</span>}
                      {b.submission ? <StatusBadge status={b.submission.status} /> : <span className="text-gray-500">Not submitted</span>}
                      {b.submission?.hasConflict && <span className="text-red-700">Conflict</span>}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

const FIELD_LABELS: Record<string, string> = {
  registeredVoters: 'Registered voters (from form)',
  totalVotesCast: 'Total votes cast',
  rejectedVotes: 'Rejected ballots',
  rejectedObjectedTo: 'Rejection objected to',
  disputedVotes: 'Disputed votes',
  validVotes: 'Total valid votes'
};

export function CountScreen() {
  const { electionId, stationId, position } = useParams() as { electionId: string; stationId: string; position: string };
  const { data } = useAssignments();
  const a = data?.assignments.find((x) => x.election.id === electionId && x.station.id === stationId);
  const ballot = a?.ballots.find((b) => b.position === position);
  const [d, setD] = useState<Draft | null>(null);
  const [step, setStep] = useState<'count' | 'review'>('count');
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [undoOpen, setUndoOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [tally, setTally] = useState<TallyStatus>({ pending: 0, recorded: {} });
  const lastTap = useRef<Record<string, number>>({});

  useEffect(() => {
    const off = onTally(setTally);
    return () => void off();
  }, []);

  useEffect(() => {
    if (!ballot) return;
    void (async () => {
      const key = draftKey(electionId, stationId, position);
      let existing = await getDraft(key);
      if (!existing) existing = newDraft(electionId, stationId, position, ballot.candidates.map((c) => c.id), ballot.submission?.currentRevision ?? null);
      setD(existing);
    })();
  }, [ballot, electionId, stationId, position]);

  useEffect(() => {
    if (!d) return;
    const t = setInterval(async () => {
      const fresh = await getDraft(d.key);
      if (fresh && fresh.state !== d.state) setD(fresh);
    }, 1500);
    return () => clearInterval(t);
  }, [d]);

  const apply = async (c: Change) => {
    setD(c.draft);
    await saveChange(c.draft, c.event);
  };
  const update = async (next: Draft) => {
    setD(next);
    await saveDraft(next);
  };

  /** One tap = one vote, recorded on the server immediately. Double taps within 250 ms are ignored. */
  const tap = (candidateId: string) => {
    const now = Date.now();
    if (now - (lastTap.current[candidateId] ?? 0) < 250) return;
    lastTap.current[candidateId] = now;
    navigator.vibrate?.(15);
    void apply(increment(d!, candidateId));
  };

  if (!data) return <Loading />;
  if (data.vettingStatus !== 'APPROVED') return <ErrorBox error="Your agent account is awaiting approval by an administrator. You cannot count or submit until it is approved." />;
  if (!a || !ballot) return <ErrorBox error="This ballot is not part of your assignment." />;
  if (!d) return <Loading />;
  const locked = d.state === 'QUEUED' || d.state === 'SYNCING';
  const sum = total(d);
  const recorded = d.countSessionId ? tally.recorded[d.countSessionId] : undefined;
  const lastAdd = d.undoable[d.undoable.length - 1];
  const name = (id: string) => ballot.candidates.find((c) => c.id === id)?.fullName ?? id;

  /** Submitting always requires the agent's password (the "+" button can never submit). */
  const queueAndSend = async (password?: string) => {
    setMsg({});
    try {
      if (ballot.requireEvidence && d.evidence.length === 0) throw new Error('Attach a photo of the results form');
      if (password) await api('/agent/confirm-identity', { body: { password } });
      const q = queue(d, () => crypto.randomUUID());
      await update(q);
      setConfirmOpen(false);
      setMsg({ ok: navigator.onLine ? 'Sending to the server…' : 'Saved on this phone and queued. It has NOT reached the server yet; you will be asked for your password again when back online if needed.' });
      await syncNow();
      const after = await getDraft(d.key);
      if (after) setD(after);
    } catch (e) {
      setMsg({ err: (e as Error).message });
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <Link className="link text-sm" to="/agent">← Back</Link>
        <h1 className="text-xl font-bold text-navy-900">{POSITION_LABELS[position]}</h1>
        <p className="text-xs font-semibold text-brand-700">{ballot.formTitle}</p>
        <p className="text-xs text-gray-600">{a.station.code} — {a.station.name}</p>
        <div className="mt-1 flex flex-wrap gap-2 text-xs">
          <span className="rounded bg-gray-100 px-2 py-0.5">Draft: {humanize(d.state)}</span>
          {d.baseRevision != null && <span className="rounded bg-blue-50 px-2 py-0.5">Amending server revision {d.baseRevision}</span>}
          {d.countSessionId && (
            <span className={`rounded px-2 py-0.5 ${tally.pending ? 'bg-amber-100 text-amber-900' : 'bg-green-100 text-green-800'}`} aria-live="polite">
              Live count: {recorded?.lastSeq ?? 0} taps recorded on server{tally.pending ? `, ${tally.pending} waiting` : ''}
            </span>
          )}
        </div>
        {recorded?.flags.includes('FAST_TAPPING') && <p className="mt-1 text-xs text-red-700">Taps are arriving very fast. Count one ballot at a time; fast tapping is flagged for reviewers.</p>}
        {recorded?.flags.includes('EXCEEDS_REGISTERED_VOTERS') && <p className="mt-1 text-xs text-red-700">The count is above the registered voters for this station. Check your count.</p>}
      </div>

      {d.state === 'SYNCED' && d.receipt && (
        <Success>
          <strong>Received by server.</strong> Receipt {d.receipt.receiptId}, revision {d.receipt.revision}, {fmtDateTime(d.receipt.serverReceivedAt)}.
          {d.receipt.reconciliationIssues.length > 0 && <ul className="mt-1 list-disc pl-5 text-amber-900">{d.receipt.reconciliationIssues.map((i) => <li key={i.rule}>{i.message}</li>)}</ul>}
          <span className="mt-1 block text-xs">To correct it, edit the figures below; a new revision will be created with your reason.</span>
        </Success>
      )}
      {d.state === 'AWAITING_CONFIRMATION' && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p>This result is queued on your phone but has <strong>not</strong> been sent. Confirm your password to send it.</p>
          <button className="btn-accent mt-2" onClick={() => setConfirmOpen(true)}>Confirm &amp; send</button>
        </div>
      )}
      {d.state === 'CONFLICT' && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          <p><strong>Conflict:</strong> {d.lastError}</p>
          <p className="mt-1">The server has revision {String(d.conflictServerRevision)} for this result. Check your history, then choose:</p>
          <button className="btn-danger mt-2" onClick={() => void update({ ...d, state: 'DRAFT', baseRevision: d.conflictServerRevision ?? null, idempotencyKey: undefined, queuedAt: undefined, declarationAccepted: false, correctionReason: undefined, countSessionId: undefined })}>Submit my figures as a correction to the server version</button>
          <Link className="btn-outline ml-2 mt-2" to="/agent/history">View server history</Link>
        </div>
      )}
      {d.state === 'FAILED' && <ErrorBox error={`Not accepted by the server: ${d.lastError}. Fix the figures and submit again.`} />}
      {d.state === 'QUEUED' && <p className="rounded bg-amber-50 p-2 text-sm text-amber-900">Queued on this phone — not yet received by the server. {d.lastError ? `Last attempt: ${d.lastError}` : ''}</p>}

      {!a.election.acceptingSubmissions && (
        <p className="flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900" role="status">
          <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
          {a.election.intake?.message ?? 'This election is not accepting results.'} Counting resumes when results open.
        </p>
      )}
      {step === 'count' ? (
        <>
          <ul className="space-y-2">
            {ballot.candidates.map((c) => (
              <li key={c.id} className="card flex items-center gap-3 p-3">
                <PublicImage fileId={c.photoFileId} alt={c.fullName} size={48} rounded="rounded-full" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{c.fullName}</p>
                  <p className="flex items-center gap-1 text-xs text-gray-500"><PublicImage fileId={c.partyLogoFileId} alt="" fallback={c.partyAbbreviation ?? 'IND'} size={16} />{c.partyAbbreviation ?? c.party ?? 'Independent'}</p>
                  <input
                    aria-label={`Votes for ${c.fullName}`}
                    className="input mt-1 w-28 py-1 text-right tabular-nums"
                    type="number"
                    min={0}
                    inputMode="numeric"
                    disabled={locked}
                    value={d.candidateVotes[c.id] ?? 0}
                    onChange={(e) => { const v = Number(e.target.value); if (Number.isInteger(v) && v >= 0) void apply(setVotes(d, c.id, v, 'Entered manually by agent')); }}
                  />
                </div>
                <span className="w-16 text-right text-2xl font-bold tabular-nums">{fmtNumber(d.candidateVotes[c.id] ?? 0)}</span>
                <button aria-label={`Add one vote for ${c.fullName}`} className="h-16 w-16 shrink-0 rounded-2xl bg-brand-600 text-3xl font-bold text-white active:scale-95 disabled:opacity-40" disabled={locked || !a.election.acceptingSubmissions} onClick={() => tap(c.id)}>+</button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-500">Each “+” adds one vote and is recorded on the server straight away. It does not submit the result.</p>

          <div className="card space-y-2">
            <p className="text-sm">Candidate total: <strong>{fmtNumber(sum)}</strong></p>
            {Object.keys(FIELD_LABELS).map((k) => (
              <label key={k} className="flex items-center justify-between gap-2 text-sm">
                <span>{FIELD_LABELS[k]}{ballot.requiredFields.includes(k) && ' *'}</span>
                <input className="input w-32 text-right" type="number" min={0} inputMode="numeric" disabled={locked} value={d.fields[k] ?? ''} onChange={(e) => void update({ ...d, fields: { ...d.fields, [k]: e.target.value === '' ? undefined : Number(e.target.value) }, updatedAt: Date.now() })} />
              </label>
            ))}
            <label className="block text-sm"><span className="label">{ballot.formReferenceLabel} (Form {ballot.formCode})</span><input className="input" disabled={locked} value={d.formReference ?? ''} onChange={(e) => void update({ ...d, formReference: e.target.value })} /></label>
            <FormPhoto d={d} ballot={ballot} electionId={electionId} stationId={stationId} position={position} locked={locked} aiEnabled={data.aiFormReading} onChange={update} onApply={apply} onError={(err) => setMsg({ err })} />
          </div>
          <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-white p-3">
            <div className="mx-auto flex max-w-2xl gap-2">
              <button className="btn-outline flex-1" disabled={locked || !lastAdd} onClick={() => setUndoOpen(true)}>Undo last +1</button>
              <button className="btn-primary flex-1" disabled={locked} onClick={() => setStep('review')}>Review &amp; submit</button>
            </div>
          </div>
          {undoOpen && lastAdd && <UndoDialog candidate={name(lastAdd.candidateId)} onCancel={() => setUndoOpen(false)} onConfirm={(code, reason) => { try { void apply(undoLast(d, code, reason)); setUndoOpen(false); } catch (e) { setMsg({ err: (e as Error).message }); } }} />}
        </>
      ) : (
        <div className="card space-y-3">
          <h2 className="font-bold">Review before submitting</h2>
          <table className="table"><tbody>{ballot.candidates.map((c) => <tr key={c.id}><td>{c.fullName}</td><td className="text-right font-bold tabular-nums">{fmtNumber(d.candidateVotes[c.id])}</td></tr>)}<tr><td>Total</td><td className="text-right font-bold">{fmtNumber(sum)}</td></tr>{Object.entries(d.fields).filter(([, v]) => v != null).map(([k, v]) => <tr key={k}><td>{FIELD_LABELS[k]}</td><td className="text-right">{fmtNumber(v)}</td></tr>)}</tbody></table>
          {d.fields.validVotes != null && d.fields.validVotes !== sum && <p className="rounded bg-amber-50 p-2 text-sm text-amber-900">Candidate total ({sum}) differs from valid votes ({d.fields.validVotes}). Enter figures exactly as on the form — the difference will be flagged for reviewers, not adjusted.</p>}
          {d.baseRevision != null && <label className="block text-sm"><span className="label">Reason for correction *</span><textarea className="input" value={d.correctionReason ?? ''} onChange={(e) => void update({ ...d, correctionReason: e.target.value })} /></label>}
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={d.declarationAccepted} disabled={locked} onChange={(e) => void update({ ...d, declarationAccepted: e.target.checked })} /> {data.declarationText}</label>
          {msg.err && <ErrorBox error={msg.err} />}
          {msg.ok && <p className="rounded bg-blue-50 p-2 text-sm text-blue-900">{msg.ok}</p>}
          <div className="flex gap-2">
            <button className="btn-outline flex-1" onClick={() => setStep('count')}>Back to counting</button>
            <button className="btn-accent flex-1" disabled={locked || !a.election.acceptingSubmissions || !d.declarationAccepted} onClick={() => (data.requireSubmitReauth && navigator.onLine ? setConfirmOpen(true) : void queueAndSend())}>{locked ? 'Sending…' : 'Submit result'}</button>
          </div>
        </div>
      )}
      {msg.err && step === 'count' && <ErrorBox error={msg.err} />}
      {confirmOpen && <PasswordDialog onCancel={() => setConfirmOpen(false)} onConfirm={(pw) => (d.state === 'AWAITING_CONFIRMATION' ? (async () => { await api('/agent/confirm-identity', { body: { password: pw } }); await update({ ...d, state: 'QUEUED' }); setConfirmOpen(false); await syncNow(); const after = await getDraft(d.key); if (after) setD(after); })().catch((e) => setMsg({ err: (e as Error).message })) : queueAndSend(pw))} />}
    </div>
  );
}

const UNDO_REASONS: [UndoReason, string][] = [
  ['ACCIDENTAL_TAP', 'Accidental tap'],
  ['WRONG_CANDIDATE', 'Tapped the wrong candidate'],
  ['DOUBLE_COUNTED', 'Counted the same ballot twice'],
  ['OTHER', 'Other (explain)']
];

function UndoDialog({ candidate, onCancel, onConfirm }: { candidate: string; onCancel: () => void; onConfirm: (code: UndoReason, reason?: string) => void }) {
  const [code, setCode] = useState<UndoReason>('ACCIDENTAL_TAP');
  const [reason, setReason] = useState('');
  return (
    <Modal title={`Undo the last +1 for ${candidate}?`} description="Undos are recorded with your reason and shown to reviewers." tone="danger" onClose={onCancel}>
      <form onSubmit={(e) => { e.preventDefault(); onConfirm(code, reason); }}>
        <fieldset className="space-y-2">
          <legend className="label">Reason</legend>
          {UNDO_REASONS.map(([v, l]) => (
            <label key={v} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm ${code === v ? 'border-navy-600 bg-navy-50' : 'border-gray-200'}`}>
              <input type="radio" name="undo" checked={code === v} onChange={() => setCode(v)} /> {l}
            </label>
          ))}
        </fieldset>
        {code === 'OTHER' && <textarea className="input mt-3" placeholder="Explain what happened" aria-label="Explain" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} />}
        <ModalActions onCancel={onCancel} confirmLabel="Undo +1" tone="danger" />
      </form>
    </Modal>
  );
}

function PasswordDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: (password: string) => void }) {
  const [pw, setPw] = useState('');
  return (
    <Modal title="Confirm it is you" description="Enter your password to submit this result. This stops anyone else from submitting from your phone." tone="accent" onClose={onCancel}>
      <form onSubmit={(e) => { e.preventDefault(); onConfirm(pw); }}>
        <input type="password" className="input" autoComplete="current-password" aria-label="Password" value={pw} onChange={(e) => setPw(e.target.value)} required autoFocus />
        <ModalActions onCancel={onCancel} confirmLabel="Confirm & submit" tone="accent" />
      </form>
    </Modal>
  );
}

interface Extraction {
  status: string;
  formCode: string;
  candidateVotes: { candidateId: string; votes: number | null; confidence: string }[];
  fields: Record<string, { value: number | null; confidence: string }> | null;
  warnings: string[];
  notice: string;
}

/** Form photo upload plus optional AI reading. AI figures are only applied after the agent confirms. */
function FormPhoto(props: { d: Draft; ballot: Ballot; electionId: string; stationId: string; position: string; locked: boolean; aiEnabled: boolean; onChange: (d: Draft) => Promise<void>; onApply: (c: Change) => Promise<void>; onError: (e: string) => void }) {
  const { d, ballot } = props;
  const [busy, setBusy] = useState(false);
  const [ex, setEx] = useState<Extraction | null>(null);
  const [checked, setChecked] = useState(false);

  const read = async () => {
    setBusy(true);
    setEx(null);
    try {
      const evidence = [...d.evidence];
      const last = evidence[evidence.length - 1]!;
      if (!last.fileId && last.blob) {
        const form = new FormData();
        form.append('file', last.blob, last.name);
        const up = await api<{ fileId: string }>('/agent/evidence', { form });
        last.fileId = up.fileId;
        last.blob = undefined;
        await props.onChange({ ...d, evidence });
      }
      setEx(await api<Extraction>('/agent/form-extract', { body: { fileId: last.fileId, electionId: props.electionId, pollingStationId: props.stationId, position: props.position } }));
    } catch (e) {
      props.onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const useAi = async () => {
    if (!ex) return;
    let cur = d;
    for (const c of ex.candidateVotes) {
      if (c.votes == null || cur.candidateVotes[c.candidateId] === c.votes) continue;
      const ch = setVotes(cur, c.candidateId, c.votes, `Transcribed from Form ${ex.formCode} (AI-assisted, checked by agent)`);
      await props.onApply(ch);
      cur = ch.draft;
    }
    const fields = { ...cur.fields };
    for (const [k, v] of Object.entries(ex.fields ?? {})) if (v.value != null) fields[k] = v.value;
    await props.onChange({ ...cur, fields, updatedAt: Date.now() });
    setEx(null);
    setChecked(false);
  };

  return (
    <div className="space-y-2">
      <label className="block text-sm">
        <span className="label">Photo of {ballot.formTitle ?? 'the results form'} {ballot.requireEvidence ? '*' : '(recommended)'}</span>
        <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" disabled={props.locked} onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          if (f.size > 10 * 1024 * 1024) return props.onError('File is larger than 10 MB');
          await props.onChange({ ...d, evidence: [...d.evidence, { localId: crypto.randomUUID(), name: f.name, type: f.type, blob: f }] });
        }} />
        <span className="text-xs text-gray-500">{d.evidence.length} file(s) attached{d.evidence.some((x) => !x.fileId) ? ' — will upload when sent' : ''}</span>
      </label>
      {props.aiEnabled && d.evidence.length > 0 && (
        <button type="button" className="btn-outline w-full" disabled={busy || props.locked || !navigator.onLine} onClick={() => void read()}>{busy ? 'Reading the form…' : `Read the numbers from Form ${ballot.formCode} with AI`}</button>
      )}
      {ex && (
        <div className="rounded-lg border border-brand-400 bg-brand-50 p-3 text-sm">
          <p className="font-semibold">AI reading ({humanize(ex.status)})</p>
          <p className="text-xs text-amber-900">{ex.notice}</p>
          <table className="table mt-2">
            <thead><tr><th>Candidate</th><th className="text-right">Your count</th><th className="text-right">Form (AI)</th></tr></thead>
            <tbody>{ballot.candidates.map((c) => {
              const r = ex.candidateVotes.find((v) => v.candidateId === c.id);
              const differs = r?.votes != null && r.votes !== d.candidateVotes[c.id];
              return <tr key={c.id} className={differs ? 'bg-red-50' : ''}><td>{c.fullName}</td><td className="text-right tabular-nums">{fmtNumber(d.candidateVotes[c.id])}</td><td className="text-right tabular-nums">{r?.votes == null ? 'unreadable' : fmtNumber(r.votes)}{r && r.confidence !== 'high' ? ` (${r.confidence})` : ''}</td></tr>;
            })}</tbody>
          </table>
          {ex.warnings.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-amber-900">{ex.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
          {ex.status === 'COMPLETED' && (
            <>
              <label className="mt-2 flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> I have checked every AI-read number against the paper form.</label>
              <div className="mt-2 flex gap-2"><button type="button" className="btn-primary" disabled={!checked} onClick={() => void useAi()}>Use the form numbers</button><button type="button" className="btn-outline" onClick={() => setEx(null)}>Keep my count</button></div>
            </>
          )}
        </div>
      )}
    </div>
  );
}


export function AgentHistory() {
  const [data, setData] = useState<{ items: { submissionId: string; position: string; status: string; currentRevision: number; hasConflict: boolean; revisions: { revision: number; receiptId: string; serverReceivedAt: string; payloadHash: string; candidateVotes: { candidateId: string; votes: number }[]; correctionReason?: string }[] }[] } | null>(null);
  const [err, setErr] = useState<string>();
  const [local, setLocal] = useState<Draft[]>([]);
  useEffect(() => {
    api<typeof data>('/agent/submissions').then(setData).catch((e) => setErr((e as Error).message));
    void allDrafts().then(setLocal);
  }, []);
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-navy-900">Submission history &amp; receipts</h1>
      {err && <ErrorBox error={`${err} — server history is unavailable offline.`} />}
      {local.filter((d) => d.state !== 'SYNCED').length > 0 && (
        <section className="card">
          <h2 className="font-semibold">On this phone (not yet confirmed by server)</h2>
          <ul className="mt-2 text-sm">{local.filter((d) => d.state !== 'SYNCED').map((d) => <li key={d.key}>{POSITION_LABELS[d.position]} — {humanize(d.state)}{d.lastError ? ` (${d.lastError})` : ''}</li>)}</ul>
        </section>
      )}
      {data?.items.map((s) => (
        <section key={s.submissionId} className="card">
          <div className="flex items-center justify-between"><h2 className="font-semibold">{POSITION_LABELS[s.position]}</h2><StatusBadge status={s.status} /></div>
          {s.hasConflict && <p className="text-xs text-red-700">Another submission for this station differs; reviewers will decide.</p>}
          <ul className="mt-2 divide-y text-xs">
            {s.revisions.map((r) => (
              <li key={r.revision} className="py-2">
                <p><strong>Revision {r.revision}</strong> · Receipt {r.receiptId} · {fmtDateTime(r.serverReceivedAt)}</p>
                <p className="break-all text-gray-500">Integrity hash {r.payloadHash}</p>
                {r.correctionReason && <p>Reason: {r.correctionReason}</p>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
