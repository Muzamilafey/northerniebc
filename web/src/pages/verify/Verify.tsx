import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { AuthFile } from '../../components/AuthFile';
import { Empty, ErrorBox, Loading, PageHeader, Pager, StatusBadge, Success } from '../../components/ui';
import { fmtDateTime, fmtNumber, humanize, POSITION_LABELS } from '../../lib/format';
import { useApi } from '../../lib/useApi';

interface SubRow { submissionId: string; position: string; status: string; currentRevision: number; hasConflict: boolean; flags: string[]; lastServerReceivedAt: string; pollingStationId: { code: string; name: string }; agentId: { fullName: string; agentCode: string } }

export default function Queue() {
  const [params, setParams] = useSearchParams();
  const { data: el } = useApi<{ items: { _id: string; name: string }[] }>('/admin/elections');
  const electionId = params.get('electionId') ?? el?.items[0]?._id ?? '';
  const status = params.get('status') ?? 'SUBMITTED';
  const page = Number(params.get('page') ?? 1);
  const list = useApi<{ items: SubRow[]; total: number; limit: number }>(electionId ? '/verification/submissions' : null, { electionId, status, conflict: params.get('conflict') ?? undefined, position: params.get('position') ?? undefined, page });
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); p.delete('page'); setParams(p); };
  return (
    <div className="space-y-4">
      <PageHeader title="Verification queue" subtitle="Compare each submission with its form photo. Conflicts are listed first." />
      <div className="card flex flex-wrap gap-2">
        <select className="input max-w-xs" value={electionId} onChange={(e) => set('electionId', e.target.value)}>{el?.items.map((e) => <option key={e._id} value={e._id}>{e.name}</option>)}</select>
        {['SUBMITTED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED'].map((s) => <button key={s} className={status === s ? 'btn-primary' : 'btn-outline'} onClick={() => set('status', s)}>{humanize(s)}</button>)}
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={params.get('conflict') === 'true'} onChange={(e) => set('conflict', e.target.checked ? 'true' : '')} /> Conflicts only</label>
        <select className="input max-w-xs" value={params.get('position') ?? ''} onChange={(e) => set('position', e.target.value)}><option value="">All positions</option>{Object.entries(POSITION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </div>
      {list.loading && <Loading />}
      {list.error && <ErrorBox error={list.error} />}
      {list.data?.items.length === 0 && <Empty title="Nothing in this queue" />}
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Station</th><th>Position</th><th>Agent</th><th>Rev.</th><th>Flags</th><th>Received</th><th /></tr></thead>
          <tbody>{list.data?.items.map((s) => (
            <tr key={s.submissionId} className={s.hasConflict ? 'bg-red-50' : ''}>
              <td>{s.pollingStationId.code} {s.pollingStationId.name}</td><td>{POSITION_LABELS[s.position]}</td><td className="text-xs">{s.agentId.fullName}<br />{s.agentId.agentCode}</td><td>{s.currentRevision}</td>
              <td className="text-xs">{s.hasConflict && <span className="font-semibold text-red-700">CONFLICT </span>}{s.flags.map(humanize).join(', ')}</td>
              <td className="text-xs">{fmtDateTime(s.lastServerReceivedAt)}</td>
              <td><Link className="link" to={`/verify/submissions/${s.submissionId}`}>Review</Link></td>
            </tr>
          ))}</tbody>
        </table>
        {list.data && <Pager page={page} total={list.data.total} limit={list.data.limit} onPage={(n) => { const p = new URLSearchParams(params); p.set('page', String(n)); setParams(p); }} />}
      </div>
    </div>
  );
}

interface Rev { revision: number; receiptId: string; serverReceivedAt: string; payloadHash: string; candidateVotes: { candidateId: string; votes: number }[]; fields: Record<string, number>; formReference?: string; correctionReason?: string; reconciliationIssues: { rule: string; message: string }[]; evidenceFileIds: { _id: string; originalName?: string; mime: string; scanStatus: string; sha256: string }[] }

export function SubmissionDetail() {
  const { id } = useParams();
  const d = useApi<{
    submission: { submissionId: string; status: string; position: string; currentRevision: number; hasConflict: boolean; pollingStationId: { code: string; name: string; registeredVoters?: number }; agentId: { fullName: string; agentCode: string } };
    revisions: Rev[];
    decisions: { _id: string; decision: string; note: string; at: string; reviewerId: { fullName: string }; secondReviewerId?: { fullName: string }; revision: number }[];
    stationResult: null | { status: string; submissionId: string; revision: number; candidateVotes: { candidateId: string; votes: number }[] };
    comparisons: { submission: { submissionId: string; status: string; agentId: { fullName: string } }; revision: Rev | null; differences: { candidateId: string; a: number | null; b: number | null }[] }[];
    candidates: { _id: string; fullName: string; partyAbbreviation?: string }[];
    approvals: { _id: string; status: string; reason: string }[];
  }>(`/verification/submissions/${id}`);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  if (d.loading) return <Loading />;
  if (!d.data) return <ErrorBox error={d.error ?? 'Not found'} />;
  const { submission: s, revisions, decisions, stationResult, comparisons, candidates, approvals } = d.data;
  const cur = revisions.find((r) => r.revision === s.currentRevision)!;
  const name = (cid: string) => candidates.find((c) => c._id === cid)?.fullName ?? cid;
  const act = async (decision: 'VERIFY' | 'REJECT' | 'START') => {
    setMsg({});
    try {
      if (decision === 'START') await api(`/verification/submissions/${s.submissionId}/start-review`, { body: { note: note || 'Review started' } });
      else {
        const r = await api<{ applied: boolean; approvalId?: string }>(`/verification/submissions/${s.submissionId}/decision`, { body: { revision: s.currentRevision, decision, note } });
        setMsg({ ok: r.applied ? `Decision recorded: ${decision}` : 'This changes a verified result, so a second reviewer must approve it (see Second-review approvals).' });
      }
      void d.reload();
    } catch (x) {
      setMsg({ err: (x as Error).message });
    }
  };
  return (
    <div className="space-y-4">
      <PageHeader title={`${s.pollingStationId.code} ${s.pollingStationId.name} — ${POSITION_LABELS[s.position]}`} subtitle={`Agent ${s.agentId.fullName} (${s.agentId.agentCode}) · revision ${s.currentRevision}`} actions={<StatusBadge status={s.status} />} />
      {s.hasConflict && <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900">Other submissions for this station and position disagree. Compare below and document your decision.</div>}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card">
          <h2 className="font-bold">Current revision {cur.revision}</h2>
          <table className="table mt-2"><tbody>{cur.candidateVotes.map((c) => <tr key={c.candidateId}><td>{name(c.candidateId)}</td><td className="text-right tabular-nums">{fmtNumber(c.votes)}</td></tr>)}<tr><td className="font-semibold">Candidate total</td><td className="text-right font-semibold">{fmtNumber(cur.candidateVotes.reduce((a, c) => a + c.votes, 0))}</td></tr>{Object.entries(cur.fields ?? {}).map(([k, v]) => <tr key={k}><td>{humanize(k)}</td><td className="text-right">{fmtNumber(v)}</td></tr>)}</tbody></table>
          <p className="mt-2 text-xs">Form reference: {cur.formReference ?? '—'} · Receipt {cur.receiptId} · {fmtDateTime(cur.serverReceivedAt)}</p>
          <p className="break-all text-xs text-gray-500">Hash {cur.payloadHash}</p>
          {cur.correctionReason && <p className="mt-1 text-sm">Agent's correction reason: {cur.correctionReason}</p>}
          {cur.reconciliationIssues.length > 0 && <ul className="mt-2 list-disc pl-5 text-sm text-amber-900">{cur.reconciliationIssues.map((i, k) => <li key={k}>{i.message}</li>)}</ul>}
        </section>
        <section className="card space-y-2">
          <h2 className="font-bold">Evidence</h2>
          {cur.evidenceFileIds.length === 0 ? <p className="text-sm text-gray-600">No form photo attached.</p> : cur.evidenceFileIds.map((f) => <div key={f._id}><AuthFile fileId={f._id} name={f.originalName} mime={f.mime} /><p className="break-all text-xs text-gray-500">sha256 {f.sha256} · scan {f.scanStatus}</p></div>)}
        </section>
      </div>
      {comparisons.length > 0 && (
        <section className="card overflow-x-auto">
          <h2 className="font-bold">Other submissions for this station</h2>
          {comparisons.map((c) => (
            <div key={c.submission.submissionId} className="mt-2 border-t pt-2 text-sm">
              <p><Link className="link" to={`/verify/submissions/${c.submission.submissionId}`}>{c.submission.agentId.fullName}</Link> · <StatusBadge status={c.submission.status} /></p>
              {c.differences.length === 0 ? <p className="text-green-700">Identical candidate figures.</p> : <table className="table"><thead><tr><th>Candidate</th><th>This submission</th><th>Other</th><th>Difference</th></tr></thead><tbody>{c.differences.map((x) => <tr key={x.candidateId}><td>{name(x.candidateId)}</td><td>{x.a}</td><td>{x.b}</td><td>{x.a != null && x.b != null ? x.a - x.b : '—'}</td></tr>)}</tbody></table>}
            </div>
          ))}
        </section>
      )}
      <section className="card space-y-2">
        <h2 className="font-bold">Decision</h2>
        <p className="text-sm">Accepted station result: {stationResult ? <>{humanize(stationResult.status)} (from {stationResult.submissionId === s.submissionId ? 'this submission' : 'another submission'}, rev. {stationResult.revision})</> : 'none'}</p>
        <textarea className="input" placeholder="Decision note (required): what you compared and why" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          {s.status === 'SUBMITTED' && <button className="btn-outline" onClick={() => act('START')}>Start review</button>}
          {s.status !== 'VERIFIED' && s.status !== 'REJECTED' && <button className="btn-primary" disabled={note.length < 5} onClick={() => act('VERIFY')}>Verify revision {s.currentRevision}</button>}
          {s.status !== 'REJECTED' && <button className="btn-danger" disabled={note.length < 5} onClick={() => act('REJECT')}>Reject</button>}
        </div>
        {msg.ok && <Success>{msg.ok}</Success>}
        {msg.err && <ErrorBox error={msg.err} />}
        {approvals.filter((a) => a.status === 'PENDING').map((a) => <p key={a._id} className="text-sm text-amber-900">Pending second review: {a.reason}</p>)}
      </section>
      <section className="card">
        <h2 className="font-bold">History</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {decisions.map((x) => <li key={x._id}>{fmtDateTime(x.at)} — <strong>{humanize(x.decision)}</strong> rev. {x.revision} by {x.reviewerId.fullName}{x.secondReviewerId ? `, approved by ${x.secondReviewerId.fullName}` : ''}: {x.note}</li>)}
          {revisions.map((r) => <li key={r.revision} className="text-gray-600">{fmtDateTime(r.serverReceivedAt)} — revision {r.revision} received ({r.receiptId}){r.correctionReason ? `: ${r.correctionReason}` : ''}</li>)}
        </ul>
      </section>
    </div>
  );
}

export function Approvals() {
  const list = useApi<{ items: { _id: string; kind: string; entityId: string; reason: string; payload: Record<string, unknown>; createdAt: string; requestedBy: { fullName: string } }[] }>('/approvals');
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const decide = async (id: string, decision: 'approve' | 'reject') => {
    const note = prompt(`Note for ${decision}:`);
    if (!note) return;
    try {
      const r = await api<{ status: string; message?: string }>(`/approvals/${id}/${decision}`, { body: { note } });
      setMsg({ ok: r.message ?? `Request ${r.status.toLowerCase()}` });
      void list.reload();
    } catch (x) {
      setMsg({ err: (x as Error).message });
    }
  };
  return (
    <div className="space-y-4">
      <PageHeader title="Second-review approvals" subtitle="Critical result corrections, manual payment reconciliations and refunds need approval by a different authorised person." />
      {msg.ok && <Success>{msg.ok}</Success>}
      {msg.err && <ErrorBox error={msg.err} />}
      {list.error && <ErrorBox error={list.error} />}
      {list.data?.items.length === 0 && <Empty title="No pending approvals" />}
      {list.data?.items.map((a) => (
        <div key={a._id} className="card">
          <p className="font-semibold">{humanize(a.kind)}</p>
          <p className="text-sm">Requested by {a.requestedBy.fullName} on {fmtDateTime(a.createdAt)}: {a.reason}</p>
          <pre className="mt-1 overflow-x-auto rounded bg-gray-50 p-2 text-xs">{JSON.stringify(a.payload, null, 2)}</pre>
          {a.kind === 'RESULT_CORRECTION' && <Link className="link text-sm" to={`/verify/submissions/${a.entityId}`}>Open submission</Link>}
          <div className="mt-2 flex gap-2"><button className="btn-primary" onClick={() => decide(a._id, 'approve')}>Approve</button><button className="btn-outline" onClick={() => decide(a._id, 'reject')}>Reject</button></div>
        </div>
      ))}
    </div>
  );
}

export function CitizenModeration() {
  const [status, setStatus] = useState('RECEIVED');
  const list = useApi<{ items: { _id: string; reference: string; type: string; title: string; description: string; status: string; createdAt: string; duplicateOfId?: string; abuseReports: unknown[]; fileIds: string[]; moderationNotes: { note: string }[] }[] }>('/admin/citizen-reports', { status });
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const moderate = async (id: string, st: string) => {
    const note = prompt('Moderation note (internal):');
    if (!note) return;
    const publicSummary = st === 'PUBLISHED' ? prompt('Public summary — no personal data, no unproven accusations:') ?? undefined : undefined;
    try {
      await api(`/admin/citizen-reports/${id}/moderate`, { body: { status: st, note, publicSummary } });
      setMsg({ ok: 'Saved' });
      void list.reload();
    } catch (x) {
      setMsg({ err: (x as Error).message });
    }
  };
  return (
    <div className="space-y-4">
      <PageHeader title="Citizen reports" subtitle="Reports stay unverified and private until reviewed. Reporter identity is revealed only on an audited request." />
      <div className="card flex flex-wrap gap-2">{['RECEIVED', 'UNDER_REVIEW', 'PUBLISHED', 'RESOLVED', 'REJECTED', 'DUPLICATE'].map((s) => <button key={s} className={s === status ? 'btn-primary' : 'btn-outline'} onClick={() => setStatus(s)}>{humanize(s)}</button>)}</div>
      {msg.ok && <Success>{msg.ok}</Success>}
      {msg.err && <ErrorBox error={msg.err} />}
      {list.data?.items.length === 0 && <Empty title="No reports" />}
      {list.data?.items.map((r) => (
        <article key={r._id} className="card">
          <p className="text-xs text-gray-500">{r.reference} · {humanize(r.type)} · {fmtDateTime(r.createdAt)} {r.duplicateOfId && <span className="text-amber-800">· possible duplicate</span>} {r.abuseReports.length > 0 && <span className="text-red-700">· {r.abuseReports.length} abuse report(s)</span>}</p>
          <p className="font-semibold">{r.title}</p>
          <p className="whitespace-pre-line text-sm">{r.description}</p>
          {r.fileIds.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{r.fileIds.map((f) => <AuthFile key={f} fileId={f} />)}</div>}
          <div className="mt-2 flex flex-wrap gap-2 text-sm">{['UNDER_REVIEW', 'PUBLISHED', 'RESOLVED', 'REJECTED'].map((s) => <button key={s} className="btn-outline px-2 py-1" onClick={() => moderate(r._id, s)}>{humanize(s)}</button>)}</div>
        </article>
      ))}
    </div>
  );
}
