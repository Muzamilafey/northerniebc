import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { draftKey, increment, newDraft, queue, setVotes, total, undo, type Draft } from '../../lib/draft';
import { allDrafts, getDraft, onSync, saveDraft, syncNow, type SyncStatus } from '../../lib/offline';
import { ErrorBox, Loading, Logo, StatusBadge, Success } from '../../components/ui';
import { fmtDateTime, fmtNumber, humanize, POSITION_LABELS } from '../../lib/format';
import { getMeta, setMeta } from '../../lib/offline';

interface Ballot {
  position: string;
  label: string;
  formReferenceLabel: string;
  requiredFields: string[];
  rules: string[];
  requireEvidence: boolean;
  candidates: { id: string; fullName: string; party?: string; partyAbbreviation?: string }[];
  submission: null | { submissionId: string; status: string; currentRevision: number; hasConflict: boolean };
}
interface Assignment {
  assignmentId: string;
  election: { id: string; name: string; status: string; acceptingSubmissions: boolean };
  station: { id: string; code: string; name: string; registeredVoters: number | null };
  county?: string;
  constituency?: string;
  ward?: string;
  ballots: Ballot[];
}
interface AssignmentsResp { assignments: Assignment[]; declarationText: string; serverTime: string }

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
      {data.assignments.length === 0 && <p className="card text-sm">You have no active polling-station assignment. Contact your supervisor.</p>}
      {data.assignments.map((a) => (
        <section key={a.assignmentId} className="card">
          <p className="text-xs text-gray-500">{a.election.name}</p>
          <h1 className="text-lg font-bold text-navy-900">{a.station.code} — {a.station.name}</h1>
          <p className="text-xs text-gray-600">{[a.ward, a.constituency, a.county].filter(Boolean).join(', ')} · Registered voters: {fmtNumber(a.station.registeredVoters)}</p>
          {!a.election.acceptingSubmissions && <p className="mt-2 text-sm text-amber-800">This election is not accepting submissions.</p>}
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
  const lastTap = useRef<Record<string, number>>({});

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

  const update = async (next: Draft) => {
    setD(next);
    await saveDraft(next);
  };

  /** Ignores a second tap on the same button within 250 ms (accidental double taps). */
  const tap = (candidateId: string) => {
    const now = Date.now();
    if (now - (lastTap.current[candidateId] ?? 0) < 250) return;
    lastTap.current[candidateId] = now;
    navigator.vibrate?.(15);
    void update(increment(d!, candidateId));
  };

  if (!data) return <Loading />;
  if (!a || !ballot) return <ErrorBox error="This ballot is not part of your assignment." />;
  if (!d) return <Loading />;
  const locked = d.state === 'QUEUED' || d.state === 'SYNCING';
  const sum = total(d);

  const submit = async () => {
    setMsg({});
    try {
      if (ballot.requireEvidence && d.evidence.length === 0) throw new Error('Attach a photo of the results form');
      const q = queue(d, () => crypto.randomUUID());
      await update(q);
      setMsg({ ok: navigator.onLine ? 'Sending to the server…' : 'Saved on this phone and queued. It will be sent when you are back online. It has NOT reached the server yet.' });
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
        <p className="text-xs text-gray-600">{a.station.code} — {a.station.name}</p>
        <div className="mt-1 flex flex-wrap gap-2 text-xs"><span className="rounded bg-gray-100 px-2 py-0.5">Draft state: {humanize(d.state)}</span>{d.baseRevision != null && <span className="rounded bg-blue-50 px-2 py-0.5">Amending server revision {d.baseRevision}</span>}</div>
      </div>

      {d.state === 'SYNCED' && d.receipt && (
        <Success>
          <strong>Received by server.</strong> Receipt {d.receipt.receiptId}, revision {d.receipt.revision}, {fmtDateTime(d.receipt.serverReceivedAt)}.
          {d.receipt.reconciliationIssues.length > 0 && <ul className="mt-1 list-disc pl-5 text-amber-900">{d.receipt.reconciliationIssues.map((i) => <li key={i.rule}>{i.message}</li>)}</ul>}
          <span className="mt-1 block text-xs">To correct it, edit the figures below; a new revision will be created with your reason.</span>
        </Success>
      )}
      {d.state === 'CONFLICT' && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          <p><strong>Conflict:</strong> {d.lastError}</p>
          <p className="mt-1">The server has revision {String(d.conflictServerRevision)} for this result. Check your history, then choose:</p>
          <button className="btn-danger mt-2" onClick={() => void update({ ...d, state: 'DRAFT', baseRevision: d.conflictServerRevision ?? null, idempotencyKey: undefined, queuedAt: undefined, declarationAccepted: false, correctionReason: undefined })}>Submit my figures as a correction to the server version</button>
          <Link className="btn-outline ml-2 mt-2" to="/agent/history">View server history</Link>
        </div>
      )}
      {d.state === 'FAILED' && <ErrorBox error={`Not accepted by the server: ${d.lastError}. Fix the figures and submit again.`} />}
      {d.state === 'QUEUED' && <p className="rounded bg-amber-50 p-2 text-sm text-amber-900">Queued on this phone — not yet received by the server. {d.lastError ? `Last attempt: ${d.lastError}` : ''}</p>}

      {step === 'count' ? (
        <>
          <ul className="space-y-2">
            {ballot.candidates.map((c) => (
              <li key={c.id} className="card flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{c.fullName}</p>
                  <p className="text-xs text-gray-500">{c.partyAbbreviation ?? c.party ?? 'Independent'}</p>
                  <input
                    aria-label={`Votes for ${c.fullName}`}
                    className="input mt-1 w-28 py-1 text-right tabular-nums"
                    type="number"
                    min={0}
                    inputMode="numeric"
                    disabled={locked}
                    value={d.candidateVotes[c.id] ?? 0}
                    onChange={(e) => { const v = Number(e.target.value); if (Number.isInteger(v) && v >= 0) void update(setVotes(d, c.id, v)); }}
                  />
                </div>
                <span className="w-16 text-right text-2xl font-bold tabular-nums">{fmtNumber(d.candidateVotes[c.id] ?? 0)}</span>
                <button aria-label={`Add one vote for ${c.fullName}`} className="h-16 w-16 shrink-0 rounded-2xl bg-brand-600 text-3xl font-bold text-white active:scale-95 disabled:opacity-40" disabled={locked} onClick={() => tap(c.id)}>+</button>
              </li>
            ))}
          </ul>
          <div className="card space-y-2">
            <p className="text-sm">Candidate total: <strong>{fmtNumber(sum)}</strong></p>
            {Object.keys(FIELD_LABELS).map((k) => (
              <label key={k} className="flex items-center justify-between gap-2 text-sm">
                <span>{FIELD_LABELS[k]}{ballot.requiredFields.includes(k) && ' *'}</span>
                <input className="input w-32 text-right" type="number" min={0} inputMode="numeric" disabled={locked} value={d.fields[k] ?? ''} onChange={(e) => void update({ ...d, fields: { ...d.fields, [k]: e.target.value === '' ? undefined : Number(e.target.value) }, updatedAt: Date.now() })} />
              </label>
            ))}
            <label className="block text-sm"><span className="label">{ballot.formReferenceLabel}</span><input className="input" disabled={locked} value={d.formReference ?? ''} onChange={(e) => void update({ ...d, formReference: e.target.value })} /></label>
            <label className="block text-sm">
              <span className="label">Photo of the results form {ballot.requireEvidence ? '*' : '(recommended)'}</span>
              <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" disabled={locked} onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 10 * 1024 * 1024) return setMsg({ err: 'File is larger than 10 MB' });
                await update({ ...d, evidence: [...d.evidence, { localId: crypto.randomUUID(), name: f.name, type: f.type, blob: f }] });
              }} />
              <span className="text-xs text-gray-500">{d.evidence.length} file(s) attached{d.evidence.some((x) => !x.fileId) ? ' — will upload when sent' : ''}</span>
            </label>
          </div>
          <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-white p-3">
            <div className="mx-auto flex max-w-2xl gap-2">
              <button className="btn-outline flex-1" disabled={locked || d.history.length === 0} onClick={() => void update(undo(d))}>Undo</button>
              <button className="btn-primary flex-1" disabled={locked} onClick={() => setStep('review')}>Review &amp; submit</button>
            </div>
          </div>
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
            <button className="btn-accent flex-1" disabled={locked || !a.election.acceptingSubmissions} onClick={() => void submit()}>{locked ? 'Sending…' : 'Submit result'}</button>
          </div>
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
