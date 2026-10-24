import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Empty, ErrorBox, Field, Loading, PageHeader, StatusBadge, Success } from '../../components/ui';
import { Icon } from '../../components/icons';
import { fmtDateTime, humanize } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import { Modal, ModalActions, useDialog } from '../../components/Dialog';

interface Job { _id: string; kind: string; status: string; originalName?: string; rowCount: number; validCount: number; errorCount: number; duplicateCount: number; conflictCount: number; createdAt: string; createdBy?: { fullName: string }; reviewedBy?: { fullName: string }; reviewNote?: string; sourceId?: { name: string; documentTitle?: string }; publishSummary?: { applied: number } }

export default function Imports() {
  const { data: templates } = useApi<Record<string, { columns: string[]; requiresElection: boolean; requiresSource: boolean }>>('/admin/imports/templates');
  const { data: elections } = useApi<{ items: { _id: string; name: string }[] }>('/admin/elections');
  const { data: sources } = useApi<{ items: { _id: string; name: string; documentTitle?: string }[] }>('/admin/sources', { limit: 200 });
  const jobs = useApi<{ items: Job[] }>('/admin/imports');
  const [kind, setKind] = useState('BUDGET_FIGURES');
  const [err, setErr] = useState<string>();
  const [ok, setOk] = useState<string>();
  const t = templates?.[kind];
  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    for (const [k, v] of [...form.entries()]) if (v === '') form.delete(k);
    setErr(undefined);
    try {
      const r = await api<{ job: Job; missingColumns: string[] }>('/admin/imports', { form });
      setOk(`Uploaded ${r.job.rowCount} rows.${r.missingColumns.length ? ` Missing columns: ${r.missingColumns.join(', ')}` : ''} Next: open it and validate.`);
      setUploading(false);
      void jobs.reload();
    } catch (x) {
      setErr((x as Error).message);
    }
  }
  const [uploading, setUploading] = useState(false);
  const STEPS = [['Upload', 'CSV or Excel file'], ['Validate', 'Rows are checked'], ['Review', 'A second person confirms'], ['Publish', 'Valid rows go public']];
  return (
    <div className="space-y-6">
      <PageHeader
        title="Data imports"
        subtitle="Bring in registers, budgets, projects and findings from official documents. Published data is never silently overwritten."
        actions={<button className="btn-accent" onClick={() => { setErr(undefined); setUploading(true); }}><Icon name="upload" className="h-4 w-4" /> New import</button>}
      />
      <ol className="grid gap-3 sm:grid-cols-4" aria-label="Import steps">
        {STEPS.map(([t, d], i) => (
          <li key={t} className="card flex items-center gap-3 py-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-navy-900 text-sm font-bold text-white" aria-hidden="true">{i + 1}</span>
            <div><p className="text-sm font-semibold text-navy-900">{t}</p><p className="text-xs text-gray-500">{d}</p></div>
          </li>
        ))}
      </ol>
      {ok && <Success>{ok}</Success>}
      {err && !uploading && <ErrorBox error={err} />}
      {jobs.data?.items.length === 0 && <Empty title="No imports yet" action={<button className="btn-accent" onClick={() => setUploading(true)}><Icon name="upload" className="h-4 w-4" /> Start the first import</button>}>Register the source document first, then upload the file prepared from it.</Empty>}
      {!!jobs.data?.items.length && (
        <section className="card">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Type</th><th>File</th><th>Status</th><th className="text-right">Rows</th><th>Valid · invalid · duplicate · conflict</th><th>Uploaded</th><th><span className="sr-only">Open</span></th></tr></thead>
              <tbody>{jobs.data.items.map((j) => (
                <tr key={j._id}>
                  <td className="font-medium">{humanize(j.kind)}</td>
                  <td className="max-w-[14rem] truncate text-gray-600" title={j.originalName}>{j.originalName}</td>
                  <td><StatusBadge status={j.status} /></td>
                  <td className="text-right tabular-nums">{j.rowCount}</td>
                  <td className="whitespace-nowrap tabular-nums"><span className="text-green-700">{j.validCount}</span> · <span className="text-red-700">{j.errorCount}</span> · <span className="text-gray-600">{j.duplicateCount}</span> · <span className="text-amber-700">{j.conflictCount}</span></td>
                  <td className="whitespace-nowrap text-xs text-gray-600">{fmtDateTime(j.createdAt)}<br />{j.createdBy?.fullName}</td>
                  <td className="text-right"><Link className="btn-outline btn-sm" to={`/admin/imports/${j._id}`}>Open</Link></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}

      {uploading && (
        <Modal title="New import" description="Choose what you are importing and the official document it comes from." icon={false} size="lg" onClose={() => setUploading(false)}>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => { await upload(e); }}>
            <Field label="Import type"><select name="kind" className="input" value={kind} onChange={(e) => setKind(e.target.value)}>{templates && Object.keys(templates).map((k) => <option key={k} value={k}>{humanize(k)}</option>)}</select></Field>
            {t?.requiresElection && <Field label="Election"><select name="electionId" className="input" required>{elections?.items.map((e) => <option key={e._id} value={e._id}>{e.name}</option>)}</select></Field>}
            <Field label={`Source document${t?.requiresSource ? ' (required)' : ''}`} hint="Not listed? Register it in the Source registry first."><select name="sourceId" className="input" required={t?.requiresSource}><option value="">—</option>{sources?.items.map((s) => <option key={s._id} value={s._id}>{s.name}{s.documentTitle ? ` — ${s.documentTitle}` : ''}</option>)}</select></Field>
            <Field label="File (CSV or XLSX)"><input name="file" type="file" accept=".csv,.xlsx" className="input" required /></Field>
            {t && <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600 sm:col-span-2"><p className="mb-1 font-semibold text-gray-700">Expected columns</p><code className="break-words">{t.columns.join(', ')}</code></div>}
            {err && <div className="sm:col-span-2"><ErrorBox error={err} /></div>}
            <div className="sm:col-span-2"><ModalActions onCancel={() => setUploading(false)} confirmLabel="Upload file" tone="accent" /></div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export function ImportJob() {
  const dialog = useDialog();
  const { id } = useParams();
  const job = useApi<{ job: Job; counts: Record<string, number> }>(`/admin/imports/${id}`);
  const [status, setStatus] = useState('');
  const rows = useApi<{ items: { _id: string; rowNumber: number; status: string; messages: string[]; raw: Record<string, string> }[]; total: number }>(`/admin/imports/${id}/rows`, { status, limit: 200 });
  const [err, setErr] = useState<string>();
  const [ok, setOk] = useState<string>();
  const act = async (path: string, body: unknown = {}) => {
    setErr(undefined);
    try {
      const r = await api<{ applied?: number }>(`/admin/imports/${id}/${path}`, { body });
      setOk(path === 'publish' ? `Published ${r.applied} rows.` : 'Done');
      void job.reload();
      void rows.reload();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  if (job.loading) return <Loading />;
  if (!job.data) return <ErrorBox error={job.error ?? 'Not found'} />;
  const j = job.data.job;
  return (
    <div className="space-y-4">
      <PageHeader title={`${humanize(j.kind)} import`} subtitle={`${j.originalName} · ${j.rowCount} rows · source: ${j.sourceId?.name ?? '—'}`} actions={<StatusBadge status={j.status} />} />
      {ok && <Success>{ok}</Success>}
      {err && <ErrorBox error={err} />}
      <div className="card flex flex-wrap gap-2">
        {j.status === 'IMPORTED' && <button className="btn-primary" onClick={() => act('validate')}>Validate rows</button>}
        {j.status === 'VALIDATED' && <button className="btn-primary" onClick={async () => { const note = await dialog.prompt({ title: 'Mark this import as reviewed?', message: 'A second person confirms the validated rows match the source document before anything is published.', label: 'Review note', hint: 'What you checked against the source.', type: 'textarea', minLength: 5, maxLength: 2000, confirmLabel: 'Mark reviewed' }); if (note) void act('review', { note }); }}>Mark reviewed</button>}
        {(j.status === 'REVIEWED' || j.status === 'PUBLISHING') && (
          <>
            <button className="btn-accent" onClick={async () => { if (await dialog.confirm({ title: 'Publish all valid rows?', message: 'Valid rows become public immediately. Rows with errors or conflicts are not published.', confirmLabel: 'Publish', tone: 'accent' })) act('publish', {}); }}>Publish valid rows</button>
            {j.conflictCount > 0 && <button className="btn-outline" onClick={async () => { const reason = await dialog.prompt({ title: `Publish including ${j.conflictCount} corrections?`, message: 'Conflicting rows will supersede the published records. The old records stay in the history.', label: 'Correction reason', hint: 'Cite the source of the correction.', type: 'textarea', minLength: 10, maxLength: 2000, confirmLabel: 'Publish with corrections', tone: 'danger' }); if (reason) void act('publish', { applyConflicts: true, correctionReason: reason }); }}>Publish including {j.conflictCount} corrections</button>}
          </>
        )}
        {!['PUBLISHED', 'PUBLISHING', 'DISCARDED'].includes(j.status) && <button className="btn-outline" onClick={async () => { const reason = await dialog.prompt({ title: 'Discard this import?', message: 'Nothing from it will be published. The file and its validation stay in the audit trail.', label: 'Reason', type: 'textarea', minLength: 5, maxLength: 1000, confirmLabel: 'Discard import', tone: 'danger' }); if (reason) void act('discard', { reason }); }}>Discard</button>}
        {j.reviewNote && <p className="w-full text-sm">Review: {j.reviewNote} — {j.reviewedBy?.fullName}</p>}
      </div>
      <div className="card">
        <div className="mb-2 flex gap-2 text-sm">{['', 'VALID', 'INVALID', 'DUPLICATE', 'CONFLICT', 'SKIPPED'].map((s) => <button key={s} className={status === s ? 'btn-primary px-2 py-1' : 'btn-outline px-2 py-1'} onClick={() => setStatus(s)}>{s || 'All'} {s && job.data!.counts[s] ? `(${job.data!.counts[s]})` : ''}</button>)}</div>
        <div className="overflow-x-auto"><table className="table"><thead><tr><th>Row</th><th>Status</th><th>Messages</th><th>Data</th></tr></thead><tbody>{rows.data?.items.map((r) => <tr key={r._id}><td>{r.rowNumber}</td><td>{r.status}</td><td className="text-xs">{r.messages.join('; ')}</td><td className="max-w-md truncate text-xs">{JSON.stringify(r.raw)}</td></tr>)}</tbody></table></div>
      </div>
    </div>
  );
}
