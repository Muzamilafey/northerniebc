import { useEffect } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { DataUnavailable, Empty, ErrorBox, Loading, PageHeader, SourceRef, StatusBadge, type SourceInfo } from '../../components/ui';
import { fmtDate, fmtKes, fmtKesShort, fmtPct, humanize } from '../../lib/format';
import { useApi } from '../../lib/useApi';

type Metric = { available: false } | { available: true; id: string; value: number; unit: 'KES' | 'PERCENT'; periodLabel: string; periodEnd: string; verificationStatus: string; source: SourceInfo; sourcePage?: string; revision: number; correctionReason?: string };
interface Summary {
  county: { name: string };
  financialYear: string;
  metrics: Record<string, Metric>;
  derived: Record<string, { label: string; formula: string; value: number | null; available: boolean; note?: string }>;
  dataAvailable: boolean;
  message?: string;
}

const GROUPS: [string, string[]][] = [
  ['Budget', ['APPROVED_BUDGET', 'REVISED_BUDGET', 'DEVELOPMENT_BUDGET', 'RECURRENT_BUDGET']],
  ['Revenue sources', ['EQUITABLE_SHARE', 'CONDITIONAL_GRANTS', 'OWN_SOURCE_REVENUE', 'FUNDS_RECEIVED']],
  ['Spending', ['ACTUAL_EXPENDITURE', 'DEVELOPMENT_EXPENDITURE', 'RECURRENT_EXPENDITURE', 'DEVELOPMENT_IMPLEMENTATION_RATE']],
  ['Obligations', ['PENDING_BILLS', 'OUTSTANDING_COMMITMENTS', 'UNSPENT_BALANCE']]
];

export function MetricCard({ name, m }: { name: string; m?: Metric }) {
  return (
    <div className="card">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{humanize(name)}</p>
      {!m || !m.available ? (
        <p className="mt-1 text-sm text-gray-500">Not available</p>
      ) : (
        <>
          <p className="mt-1 text-xl font-bold text-navy-900">{m.unit === 'PERCENT' ? fmtPct(m.value) : fmtKes(m.value)}</p>
          <p className="text-xs text-gray-600">{m.periodLabel} (to {fmtDate(m.periodEnd)})</p>
          <div className="mt-1 flex flex-wrap items-center gap-2"><StatusBadge status={m.verificationStatus} />{m.revision > 1 && <span className="text-xs text-gray-500">Corrected (rev. {m.revision})</span>}</div>
          <SourceRef source={m.source} page={m.sourcePage} className="mt-1 block" />
        </>
      )}
    </div>
  );
}

export default function Budgets() {
  const [params, setParams] = useSearchParams();
  const { data: counties } = useApi<{ items: { _id: string; name: string }[] }>('/public/counties');
  const countyId = params.get('countyId') ?? counties?.items[0]?._id ?? '';
  const { data: years } = useApi<{ items: string[] }>(countyId ? '/public/budgets/years' : null, { countyId });
  const fy = params.get('financialYear') ?? years?.items[0] ?? '';
  const departmentId = params.get('departmentId') ?? '';
  const { data: depts } = useApi<{ items: { _id: string; name: string }[] }>(countyId ? '/public/departments' : null, { countyId });
  const { data, error, loading, reload } = useApi<Summary>(countyId && fy ? '/public/budgets/summary' : null, { countyId, financialYear: fy, departmentId });
  const { data: disb } = useApi<{ items: { county: { name: string }; stages: Record<string, null | { amountKes: number; asOfDate: string; source: SourceInfo; explanation?: string }>; outstandingAgainstSchedule: null | { amountKes: number; formula: string; note?: string }; note: string }[] }>(fy ? '/public/disbursements' : null, { countyId, financialYear: fy });
  const { data: compare } = useApi<{ items: { county: { name: string }; figure: null | { value: number } }[] }>(fy ? '/public/budgets/compare' : null, { financialYear: fy, metric: 'APPROVED_BUDGET' });
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p);
  };
  useEffect(() => {
    if (!params.get('countyId') && countyId) set('countyId', countyId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countyId]);

  return (
    <div>
      <PageHeader title="County Budgets" subtitle="Budgets, Treasury releases, receipts and spending — each shown separately, each with its source and reporting period." />
      <div className="card mb-4 grid gap-3 sm:grid-cols-3">
        <label><span className="label">County</span><select className="input" value={countyId} onChange={(e) => setParams(new URLSearchParams({ countyId: e.target.value }))}>{counties?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select></label>
        <label><span className="label">Financial year</span><select className="input" value={fy} onChange={(e) => set('financialYear', e.target.value)} disabled={!years?.items.length}>{years?.items.map((y) => <option key={y}>{y}</option>)}</select></label>
        <label><span className="label">Department</span><select className="input" value={departmentId} onChange={(e) => set('departmentId', e.target.value)}><option value="">County total</option>{depts?.items.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}</select></label>
      </div>
      {departmentId && <p className="mb-3 text-sm"><Link className="link" to={`/budgets/departments/${departmentId}`}>Open the full department page →</Link></p>}

      {!years?.items.length && countyId && <DataUnavailable what="Budget information for this county" />}
      {loading && <Loading />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && (
        <div className="space-y-6">
          {!data.dataAvailable && <DataUnavailable what={`Budget information for ${data.county.name}, FY ${data.financialYear}`} />}
          {GROUPS.map(([g, ms]) => (
            <section key={g}>
              <h2 className="mb-2 text-lg font-bold text-navy-900">{g}</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{ms.map((m) => <MetricCard key={m} name={m} m={data.metrics[m]} />)}</div>
            </section>
          ))}
          <section>
            <h2 className="mb-2 text-lg font-bold text-navy-900">Calculated indicators</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {Object.entries(data.derived).map(([k, d]) => (
                <div key={k} className="card">
                  <p className="text-xs uppercase text-gray-500">{d.label}</p>
                  <p className="text-xl font-bold">{d.available ? fmtPct(d.value) : 'Not available'}</p>
                  <p className="text-xs text-gray-600">Formula: {d.formula}</p>
                  {d.note && <p className="text-xs text-amber-800">{d.note}</p>}
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {fy && disb && (
        <section className="mt-8">
          <h2 className="mb-2 text-lg font-bold text-navy-900">Treasury disbursement tracker — FY {fy}</h2>
          {disb.items.map((it) => (
            <div key={it.county.name} className="card mb-3 overflow-x-auto">
              <p className="font-semibold">{it.county.name}</p>
              <table className="table mt-2">
                <thead><tr><th>Stage</th><th>Amount</th><th>As of</th><th>Source</th></tr></thead>
                <tbody>
                  {(['ALLOCATION', 'SCHEDULED', 'DISBURSED', 'RECEIVED'] as const).map((s) => {
                    const v = it.stages[s];
                    return (
                      <tr key={s}>
                        <td>{{ ALLOCATION: '1. Approved allocation', SCHEDULED: '2. Scheduled for transfer', DISBURSED: '3. Actually released by Treasury', RECEIVED: '4. Received by the county' }[s]}</td>
                        <td className="tabular-nums">{v ? fmtKes(v.amountKes) : <span className="text-gray-500">Not documented</span>}</td>
                        <td>{v ? fmtDate(v.asOfDate) : '—'}</td>
                        <td>{v ? <SourceRef source={v.source} /> : '—'}{v?.explanation && <p className="text-xs">Official explanation: {v.explanation}</p>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {it.outstandingAgainstSchedule && <p className="mt-2 text-sm">Outstanding against schedule: <strong>{fmtKes(it.outstandingAgainstSchedule.amountKes)}</strong> <span className="text-xs text-gray-500">({it.outstandingAgainstSchedule.formula}{it.outstandingAgainstSchedule.note ? `; ${it.outstandingAgainstSchedule.note}` : ''})</span></p>}
              <p className="mt-1 text-xs text-gray-500">{it.note} Spending and commitments are shown in the budget section above.</p>
            </div>
          ))}
        </section>
      )}

      {fy && compare && compare.items.some((c) => c.figure) && (
        <section className="mt-8 card h-80">
          <h2 className="mb-2 font-bold">Approved budgets compared — FY {fy}</h2>
          <ResponsiveContainer width="100%" height="85%">
            <BarChart data={compare.items.filter((c) => c.figure).map((c) => ({ county: c.county.name, value: c.figure!.value }))}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="county" />
              <YAxis tickFormatter={(v: number) => fmtKesShort(v)} width={90} />
              <Tooltip formatter={(v: number) => fmtKes(v)} />
              <Bar dataKey="value" fill="#14304f" />
            </BarChart>
          </ResponsiveContainer>
          <p className="text-xs text-gray-500">Counties without a published figure are omitted, not shown as zero.</p>
        </section>
      )}
    </div>
  );
}

export function DepartmentPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const { data, error, loading } = useApi<{
    department: { name: string };
    financialYear: string | null;
    availableYears: string[];
    metrics: Record<string, Metric> | null;
    derived: Summary['derived'] | null;
    projects: { reference: string; name: string; status: string }[];
    auditFindings: { findingKey: string; financialYear: string; category: string; description: string }[];
    projectAllocations: { id: string; metric: string; value: number; project: { reference: string; name: string }; source: SourceInfo }[];
    explanation: string;
  }>(`/public/departments/${id}`, { financialYear: params.get('financialYear') ?? undefined });
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  return (
    <div className="space-y-6">
      <PageHeader title={data.department.name} subtitle={data.explanation} actions={data.availableYears.length > 0 && <select className="input w-40" value={data.financialYear ?? ''} onChange={(e) => setParams({ financialYear: e.target.value })}>{data.availableYears.map((y) => <option key={y}>{y}</option>)}</select>} />
      {!data.metrics ? <DataUnavailable what="Department budget information" /> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {['APPROVED_BUDGET', 'REVISED_BUDGET', 'ACTUAL_EXPENDITURE', 'DEVELOPMENT_EXPENDITURE', 'RECURRENT_EXPENDITURE', 'PENDING_BILLS'].map((m) => <MetricCard key={m} name={m} m={data.metrics![m]} />)}
          {data.derived && <div className="card"><p className="text-xs uppercase text-gray-500">Budget utilisation</p><p className="text-xl font-bold">{data.derived.budgetUtilisation?.available ? fmtPct(data.derived.budgetUtilisation.value) : 'Not available'}</p><p className="text-xs text-gray-500">{data.derived.budgetUtilisation?.formula}</p></div>}
        </div>
      )}
      <section className="card">
        <h2 className="font-bold">Project-level allocations</h2>
        {data.projectAllocations.length === 0 ? <p className="text-sm text-gray-600">None published.</p> : (
          <ul className="mt-2 space-y-1 text-sm">{data.projectAllocations.map((a) => <li key={a.id}><Link className="link" to={`/projects/${encodeURIComponent(a.project.reference)}`}>{a.project.name}</Link>: {humanize(a.metric)} {fmtKes(a.value)} <SourceRef source={a.source} /></li>)}</ul>
        )}
      </section>
      <div className="grid gap-4 md:grid-cols-2">
        <section className="card"><h2 className="font-bold">Projects</h2>{data.projects.length === 0 ? <p className="text-sm text-gray-600">None published.</p> : <ul className="mt-2 text-sm">{data.projects.map((p) => <li key={p.reference} className="flex justify-between py-1"><Link className="link" to={`/projects/${encodeURIComponent(p.reference)}`}>{p.name}</Link><StatusBadge status={p.status} /></li>)}</ul>}</section>
        <section className="card"><h2 className="font-bold">Audit queries</h2>{data.auditFindings.length === 0 ? <p className="text-sm text-gray-600">None published.</p> : <ul className="mt-2 text-sm">{data.auditFindings.map((f) => <li key={f.findingKey} className="py-1"><Link className="link" to={`/accountability/findings/${encodeURIComponent(f.findingKey)}`}>{humanize(f.category)} (FY {f.financialYear})</Link></li>)}</ul>}</section>
      </div>
      {!data.metrics && !data.projects.length && <Empty title="Nothing published for this department yet" />}
    </div>
  );
}
