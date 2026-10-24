import { useState } from 'react';
import { download } from '../../lib/api';
import { ErrorBox, PageHeader, SourceRef, type SourceInfo } from '../../components/ui';
import { fmtDate, humanize } from '../../lib/format';
import { useApi } from '../../lib/useApi';

const EXPORTS: [string, string, string][] = [
  ['budgets', 'County budget figures', 'Published budget, revenue, expenditure and obligation figures with source references.'],
  ['disbursements', 'Treasury disbursement records', 'Allocation, schedule, release and receipt stages.'],
  ['projects', 'Project payments and completion', 'Budget, paid amounts, financial vs. physical progress.'],
  ['audit-findings', 'Audit findings', 'Findings as worded in the source reports.'],
  ['citizen-reports-summary', 'Citizen reporting summary', 'Counts by type and moderation status (no personal data).'],
  ['donations-summary', 'Donations — aggregate totals', 'Confirmed donations, fees, refunds and net receipts.']
];

export default function Reports() {
  const [err, setErr] = useState<string>();
  const { data: sources } = useApi<{ items: (SourceInfo & { _id: string; kind: string; retrievedAt?: string })[] }>('/public/sources', { limit: 100 });
  const { data: elections } = useApi<{ items: { _id: string; name: string; positions: { position: string; enabled: boolean }[] }[] }>('/public/elections');
  const dl = async (kind: string, format: string, q: Record<string, string> = {}) => {
    setErr(undefined);
    try {
      await download(`/exports/${kind}`, { format, ...q });
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="space-y-8">
      <PageHeader title="Reports & Downloads" subtitle="Every export states when it was generated, the reporting period, sources, status and how complete the data is." />
      {err && <ErrorBox error={err} />}
      <div className="grid gap-3 md:grid-cols-2">
        {elections?.items.map((e) => (
          <div key={e._id} className="card">
            <p className="font-semibold">Election results — {e.name}</p>
            <p className="text-sm text-gray-600">Candidate totals and vote shares (public, verified/provisional per publication settings).</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {e.positions.filter((p) => p.enabled).map((p) => (
                <span key={p.position} className="flex gap-1">
                  {['csv', 'xlsx', 'pdf'].map((f) => <button key={f} className="btn-outline px-2 py-1 text-xs" onClick={() => dl('results', f, { electionId: e._id, position: p.position })}>{humanize(p.position)} {f.toUpperCase()}</button>)}
                </span>
              ))}
            </div>
            <div className="mt-2 flex gap-2">{['csv', 'xlsx'].map((f) => <button key={f} className="btn-outline px-2 py-1 text-xs" onClick={() => dl('coverage', f, { electionId: e._id, position: e.positions.find((p) => p.enabled)?.position ?? 'GOVERNOR', level: 'station' })}>Station coverage {f.toUpperCase()}</button>)}</div>
          </div>
        ))}
        {EXPORTS.map(([k, t, d]) => (
          <div key={k} className="card">
            <p className="font-semibold">{t}</p>
            <p className="text-sm text-gray-600">{d}</p>
            <div className="mt-2 flex gap-2">{['csv', 'xlsx', 'pdf'].map((f) => <button key={f} className="btn-outline px-3 py-1 text-xs" onClick={() => dl(k, f)}>{f.toUpperCase()}</button>)}</div>
          </div>
        ))}
      </div>
      <section>
        <h2 className="mb-2 text-xl font-bold text-navy-900">Source registry</h2>
        <p className="mb-3 text-sm text-gray-600">Documents and portals that published figures are drawn from. Not every source provides an API; documents are imported and reviewed by staff.</p>
        <div className="card overflow-x-auto">
          <table className="table">
            <thead><tr><th>Source</th><th>Kind</th><th>Published</th><th>Retrieved</th></tr></thead>
            <tbody>{sources?.items.map((s) => <tr key={s._id}><td><SourceRef source={s} /></td><td>{humanize(s.kind)}</td><td>{fmtDate(s.publicationDate)}</td><td>{fmtDate(s.retrievedAt)}</td></tr>)}</tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
