import { useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import { ErrorBox, Field, PageHeader, Pager, StatusBadge, Success } from '../../components/ui';
import { fmtDate, humanize } from '../../lib/format';
import { useApi } from '../../lib/useApi';

const KINDS = ['BUDGET_FIGURE', 'DISBURSEMENT', 'PROJECT', 'AUDIT_FINDING'];
const NEXT: Record<string, string> = { IMPORTED: 'VALIDATED', VALIDATED: 'REVIEWED', REVIEWED: 'PUBLISHED' };

interface Rec { _id: string; workflowStatus: string; isCurrent: boolean; revision: number; financialYear?: string; metric?: string; value?: number; stage?: string; amountCents?: number; reference?: string; name?: string; findingKey?: string; category?: string; sourceId?: { name: string }; correctionReason?: string; updatedAt: string }

function describe(r: Rec) {
  if (r.metric) return `${humanize(r.metric)} ${r.financialYear}: ${(r.value! / 100).toLocaleString('en-KE')}`;
  if (r.stage) return `${humanize(r.stage)} ${r.financialYear}: KSh ${(r.amountCents! / 100).toLocaleString('en-KE')}`;
  if (r.reference) return `${r.reference} — ${r.name}`;
  if (r.findingKey) return `${r.findingKey} — ${humanize(r.category)}`;
  return r._id;
}

export default function Records() {
  const [kind, setKind] = useState('BUDGET_FIGURE');
  const [ws, setWs] = useState('');
  const [page, setPage] = useState(1);
  const list = useApi<{ items: Rec[]; total: number; limit: number }>(`/admin/records/${kind}`, { workflowStatus: ws, page });
  const [err, setErr] = useState<string>();
  const [ok, setOk] = useState<string>();
  const [correcting, setCorrecting] = useState<Rec | null>(null);
  const advance = async (r: Rec) => {
    setErr(undefined);
    try {
      await api(`/admin/records/${kind}/${r._id}/advance`, { body: { to: NEXT[r.workflowStatus] } });
      setOk(`Moved to ${NEXT[r.workflowStatus]}`);
      void list.reload();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  async function correct(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const changes = JSON.parse(String(f.get('changes')));
      await api(`/admin/records/${kind}/${correcting!._id}/correct`, { body: { changes, reason: f.get('reason') } });
      setOk('Correction drafted. It must be validated, reviewed and published; the current value stays visible until then.');
      setCorrecting(null);
      void list.reload();
    } catch (x) {
      setErr((x as Error).message);
    }
  }
  return (
    <div className="space-y-4">
      <PageHeader title="Financial & project records" subtitle="Advance records through review and publication, or draft documented corrections. Previous published values are always retained." />
      {ok && <Success>{ok}</Success>}
      {err && <ErrorBox error={err} />}
      <div className="card flex flex-wrap gap-2">
        {KINDS.map((k) => <button key={k} className={k === kind ? 'btn-primary' : 'btn-outline'} onClick={() => { setKind(k); setPage(1); }}>{humanize(k)}</button>)}
        <select className="input max-w-xs" value={ws} onChange={(e) => setWs(e.target.value)}><option value="">All statuses</option>{['IMPORTED', 'VALIDATED', 'REVIEWED', 'PUBLISHED'].map((s) => <option key={s}>{s}</option>)}</select>
      </div>
      {correcting && (
        <form className="card space-y-2" onSubmit={correct}>
          <p className="font-semibold">Correct: {describe(correcting)}</p>
          <Field label="Changes (JSON)" hint='e.g. {"value": 12500000000} for a budget figure (KES), {"amountKes": 1000} for disbursements, {"status": "DELAYED", "amountPaidKes": 2000000} for projects, {"latestKnownStatus": "…"} for findings'><textarea name="changes" className="input font-mono" defaultValue="{}" /></Field>
          <Field label="Reason (cite the source)"><textarea name="reason" className="input" required minLength={10} /></Field>
          <div className="flex gap-2"><button className="btn-primary">Draft correction</button><button type="button" className="btn-outline" onClick={() => setCorrecting(null)}>Cancel</button></div>
        </form>
      )}
      <div className="card overflow-x-auto">
        <table className="table">
          <thead><tr><th>Record</th><th>Status</th><th>Rev.</th><th>Source</th><th>Updated</th><th /></tr></thead>
          <tbody>{list.data?.items.map((r) => (
            <tr key={r._id} className={r.isCurrent ? '' : 'text-gray-400'}>
              <td>{describe(r)}{r.correctionReason && <p className="text-xs">Correction: {r.correctionReason}</p>}</td>
              <td><StatusBadge status={r.workflowStatus} />{!r.isCurrent && r.workflowStatus === 'PUBLISHED' && <span className="ml-1 text-xs">(superseded)</span>}</td>
              <td>{r.revision}</td>
              <td className="text-xs">{r.sourceId?.name ?? '—'}</td>
              <td className="text-xs">{fmtDate(r.updatedAt)}</td>
              <td className="whitespace-nowrap text-xs">
                {NEXT[r.workflowStatus] && <button className="link mr-2" onClick={() => advance(r)}>→ {NEXT[r.workflowStatus]}</button>}
                {r.workflowStatus === 'PUBLISHED' && r.isCurrent && <button className="link" onClick={() => setCorrecting(r)}>Correct</button>}
              </td>
            </tr>
          ))}</tbody>
        </table>
        {list.data && <Pager page={page} total={list.data.total} limit={list.data.limit} onPage={setPage} />}
      </div>
    </div>
  );
}

export function Sources() {
  const list = useApi<{ items: { _id: string; name: string; documentTitle?: string; url?: string; kind: string; verificationStatus: string; publicationDate?: string; fileId?: string }[] }>('/admin/sources', { limit: 200 });
  const [err, setErr] = useState<string>();
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = Object.fromEntries([...f.entries()].filter(([, v]) => v !== ''));
    try {
      await api('/admin/sources', { body });
      (e.target as HTMLFormElement).reset();
      void list.reload();
    } catch (x) {
      setErr((x as Error).message);
    }
  }
  return (
    <div className="space-y-4">
      <PageHeader title="Source registry" subtitle="Register each official document before importing figures from it. A second person reviews sources before they are listed publicly." />
      {err && <ErrorBox error={err} />}
      <form className="card grid gap-3 sm:grid-cols-3" onSubmit={create}>
        <Field label="Source name"><input name="name" className="input" required /></Field>
        <Field label="Document title"><input name="documentTitle" className="input" /></Field>
        <Field label="URL"><input name="url" type="url" className="input" /></Field>
        <Field label="Publisher"><input name="publisher" className="input" /></Field>
        <Field label="Publication date"><input name="publicationDate" type="date" className="input" /></Field>
        <Field label="Kind"><select name="kind" className="input">{['BUDGET_DOCUMENT', 'COB_REPORT', 'AUDIT_REPORT', 'TREASURY_RELEASE', 'ELECTION_PUBLICATION', 'GAZETTE', 'INSPECTION', 'PORTAL', 'OTHER'].map((k) => <option key={k} value={k}>{humanize(k)}</option>)}</select></Field>
        <Field label="Financial year"><input name="financialYear" className="input" placeholder="2023/24" /></Field>
        <div className="flex items-end"><button className="btn-primary">Register source</button></div>
      </form>
      <div className="card overflow-x-auto">
        <table className="table"><thead><tr><th>Source</th><th>Kind</th><th>Published</th><th>Status</th><th>Document</th><th /></tr></thead>
          <tbody>{list.data?.items.map((s) => (
            <tr key={s._id}>
              <td>{s.name}<p className="text-xs text-gray-500">{s.documentTitle} {s.url && <a className="link" href={s.url} target="_blank" rel="noreferrer">link</a>}</p></td>
              <td>{humanize(s.kind)}</td>
              <td>{fmtDate(s.publicationDate)}</td>
              <td>{humanize(s.verificationStatus)}</td>
              <td>{s.fileId ? 'Attached' : <input type="file" className="text-xs" accept=".pdf,.csv,.xlsx,image/*" onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; const form = new FormData(); form.append('file', file); try { await api(`/admin/sources/${s._id}/document`, { form }); void list.reload(); } catch (x) { setErr((x as Error).message); } }} />}</td>
              <td>{s.verificationStatus === 'UNREVIEWED' && <button className="link text-xs" onClick={async () => { const note = prompt('Review note'); if (!note) return; try { await api(`/admin/sources/${s._id}/review`, { body: { decision: 'REVIEWED', note } }); void list.reload(); } catch (x) { setErr((x as Error).message); } }}>Mark reviewed</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}
