import { useState, type FormEvent } from 'react';
import { api } from '../../lib/api';
import { Empty, ErrorBox, Field, PageHeader, Pager, Segmented, StatusBadge, Success } from '../../components/ui';
import { Icon } from '../../components/icons';
import { fmtDate, humanize } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import { Modal, ModalActions, useDialog } from '../../components/Dialog';

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
      <div className="card flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Segmented label="Record type" value={kind} onChange={(k) => { setKind(k); setPage(1); }} options={KINDS.map((k) => ({ value: k, label: humanize(k) }))} />
        <select className="input lg:max-w-[14rem]" aria-label="Status" value={ws} onChange={(e) => setWs(e.target.value)}><option value="">All statuses</option>{['IMPORTED', 'VALIDATED', 'REVIEWED', 'PUBLISHED'].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</select>
      </div>
      {correcting && (
        <Modal title="Draft a correction" description={describe(correcting)} icon={false} size="lg" onClose={() => setCorrecting(null)}>
        <form className="space-y-4" onSubmit={correct}>
          <Field label="Changes (JSON)" hint='e.g. {"value": 12500000000} for a budget figure (KES), {"amountKes": 1000} for disbursements, {"status": "DELAYED", "amountPaidKes": 2000000} for projects, {"latestKnownStatus": "…"} for findings'><textarea name="changes" className="input font-mono" defaultValue="{}" /></Field>
          <Field label="Reason (cite the source)"><textarea name="reason" className="input" required minLength={10} /></Field>
          <ModalActions onCancel={() => setCorrecting(null)} confirmLabel="Draft correction" />
        </form>
        </Modal>
      )}
      {list.data?.items.length === 0 && <Empty title={`No ${humanize(kind).toLowerCase()} records yet`}>Records arrive through Data imports and move through review before publication.</Empty>}
      {!!list.data?.items.length && <div className="card"><div className="table-wrap">
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
                <div className="flex justify-end gap-2">
                  {NEXT[r.workflowStatus] && <button className="btn-outline btn-sm" onClick={() => advance(r)}>Mark {humanize(NEXT[r.workflowStatus]!).toLowerCase()}</button>}
                  {r.workflowStatus === 'PUBLISHED' && r.isCurrent && <button className="btn-outline btn-sm" onClick={() => setCorrecting(r)}>Correct</button>}
                </div>
              </td>
            </tr>
          ))}</tbody>
        </table>
        </div>
        <Pager page={page} total={list.data.total} limit={list.data.limit} onPage={setPage} />
      </div>}
    </div>
  );
}

export function Sources() {
  const dialog = useDialog();
  const list = useApi<{ items: { _id: string; name: string; documentTitle?: string; url?: string; kind: string; verificationStatus: string; publicationDate?: string; fileId?: string }[] }>('/admin/sources', { limit: 200 });
  const [err, setErr] = useState<string>();
  const [adding, setAdding] = useState(false);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = Object.fromEntries([...f.entries()].filter(([, v]) => v !== ''));
    try {
      await api('/admin/sources', { body });
      setAdding(false);
      void list.reload();
    } catch (x) {
      setErr((x as Error).message);
    }
  }
  return (
    <div className="space-y-4">
      <PageHeader title="Source registry" subtitle="Register each official document before importing figures from it. A second person reviews sources before they are listed publicly." actions={<button className="btn-accent" onClick={() => { setErr(undefined); setAdding(true); }}><Icon name="plus" className="h-4 w-4" /> Register source</button>} />
      {err && !adding && <ErrorBox error={err} />}
      {adding && (
        <Modal title="Register a source document" description="The official publication the figures come from." icon={false} size="lg" onClose={() => setAdding(false)}>
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={create}>
        <Field label="Source name"><input name="name" className="input" required /></Field>
        <Field label="Document title"><input name="documentTitle" className="input" /></Field>
        <Field label="URL"><input name="url" type="url" className="input" /></Field>
        <Field label="Publisher"><input name="publisher" className="input" /></Field>
        <Field label="Publication date"><input name="publicationDate" type="date" className="input" /></Field>
        <Field label="Kind"><select name="kind" className="input">{['BUDGET_DOCUMENT', 'COB_REPORT', 'AUDIT_REPORT', 'TREASURY_RELEASE', 'ELECTION_PUBLICATION', 'GAZETTE', 'INSPECTION', 'PORTAL', 'OTHER'].map((k) => <option key={k} value={k}>{humanize(k)}</option>)}</select></Field>
        <Field label="Financial year"><input name="financialYear" className="input" placeholder="2023/24" /></Field>
        {err && <div className="sm:col-span-2"><ErrorBox error={err} /></div>}
        <div className="sm:col-span-2"><ModalActions onCancel={() => setAdding(false)} confirmLabel="Register source" tone="accent" /></div>
      </form>
        </Modal>
      )}
      {list.data?.items.length === 0 && <Empty title="No sources registered yet" action={<button className="btn-accent" onClick={() => setAdding(true)}><Icon name="plus" className="h-4 w-4" /> Register the first source</button>}>Register a budget, Controller of Budget or audit report before importing figures from it.</Empty>}
      {!!list.data?.items.length && <div className="card"><div className="table-wrap">
        <table className="table"><thead><tr><th>Source</th><th>Kind</th><th>Published</th><th>Status</th><th>Document</th><th /></tr></thead>
          <tbody>{list.data?.items.map((s) => (
            <tr key={s._id}>
              <td>{s.name}<p className="text-xs text-gray-500">{s.documentTitle} {s.url && <a className="link" href={s.url} target="_blank" rel="noreferrer">link</a>}</p></td>
              <td>{humanize(s.kind)}</td>
              <td>{fmtDate(s.publicationDate)}</td>
              <td><span className={`badge ${s.verificationStatus === 'REVIEWED' ? 'bg-green-100 text-green-800' : s.verificationStatus === 'REJECTED' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-900'}`}>{humanize(s.verificationStatus)}</span></td>
              <td>{s.fileId ? 'Attached' : <input type="file" className="text-xs" accept=".pdf,.csv,.xlsx,image/*" onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; const form = new FormData(); form.append('file', file); try { await api(`/admin/sources/${s._id}/document`, { form }); void list.reload(); } catch (x) { setErr((x as Error).message); } }} />}</td>
              <td>{s.verificationStatus === 'UNREVIEWED' && <button className="link text-xs" onClick={async () => { const note = await dialog.prompt({ title: `Mark “${s.name}” as reviewed?`, message: 'Confirm you checked this source against the original publication. A second person’s review is what makes it citable.', label: 'Review note', type: 'textarea', minLength: 3, maxLength: 2000, placeholder: 'What you checked, e.g. matches the PDF on cob.go.ke', confirmLabel: 'Mark reviewed' }); if (!note) return; try { await api(`/admin/sources/${s._id}/review`, { body: { decision: 'REVIEWED', note } }); void list.reload(); } catch (x) { setErr((x as Error).message); } }}>Mark reviewed</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div></div>}
    </div>
  );
}
