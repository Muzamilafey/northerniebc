import { lazy, Suspense, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Empty, ErrorBox, Loading, PageHeader, Pager, SourceRef, StatusBadge, type SourceInfo } from '../../components/ui';
import { fmtDate, fmtDateTime, fmtKes, fmtPct, humanize } from '../../lib/format';
import { useApi } from '../../lib/useApi';

const ProjectMap = lazy(() => import('../../components/ProjectMap'));

const STATUSES = ['PLANNED', 'ONGOING', 'COMPLETED', 'DELAYED', 'SUSPENDED', 'UNVERIFIED'];
const SECTORS = ['ROADS', 'HEALTH', 'WATER', 'BOREHOLE', 'MARKETS', 'SANITATION', 'ELECTRICITY', 'EDUCATION', 'AGRICULTURE', 'OTHER'];

interface Progress { financial: { percent: number | null; basis: string | null; formula: string }; physical: null | { percent: number; basis: string; assessedAt: string }; gapPoints: number | null; exceedsThreshold: boolean }
interface ProjectRow { id: string; reference: string; name: string; status: string; sector: string; approvedBudgetKes: number | null; amountPaidKes: number | null; progress: Progress; discrepancyFlag: null | { reason: string }; department?: { name: string } | null }

export function ProgressBars({ p }: { p: Progress }) {
  return (
    <div className="space-y-1 text-xs">
      <div>
        <div className="flex justify-between"><span>Financial (paid)</span><span>{p.financial.percent == null ? 'n/a' : fmtPct(p.financial.percent)}</span></div>
        <div className="h-1.5 rounded bg-gray-200"><div className="h-1.5 rounded bg-navy-700" style={{ width: `${Math.min(100, p.financial.percent ?? 0)}%` }} /></div>
      </div>
      <div>
        <div className="flex justify-between"><span>Physical {p.physical ? `(${humanize(p.physical.basis)})` : ''}</span><span>{p.physical ? fmtPct(p.physical.percent) : 'Not documented'}</span></div>
        <div className="h-1.5 rounded bg-gray-200"><div className="h-1.5 rounded bg-teal-600" style={{ width: `${p.physical?.percent ?? 0}%` }} /></div>
      </div>
    </div>
  );
}

export default function Projects() {
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<'list' | 'map'>('list');
  const q = Object.fromEntries(params.entries());
  const page = Number(params.get('page') ?? 1);
  const { data: counties } = useApi<{ items: { _id: string; name: string }[] }>('/public/counties');
  const { data, error, loading, reload } = useApi<{ items: ProjectRow[]; total: number; limit: number }>('/public/projects', { ...q, page });
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    p.delete('page');
    setParams(p);
  };
  return (
    <div>
      <PageHeader title="Development Projects" subtitle="County-funded projects with payments and physical progress reported separately." actions={<div className="flex gap-2"><button className={view === 'list' ? 'btn-primary' : 'btn-outline'} onClick={() => setView('list')}>List</button><button className={view === 'map' ? 'btn-primary' : 'btn-outline'} onClick={() => setView('map')}>Map</button></div>} />
      <div className="card mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <input className="input" placeholder="Search name or reference" defaultValue={q.q} onKeyDown={(e) => e.key === 'Enter' && set('q', (e.target as HTMLInputElement).value)} aria-label="Search projects" />
        <select className="input" value={q.countyId ?? ''} onChange={(e) => set('countyId', e.target.value)} aria-label="County"><option value="">All counties</option>{counties?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select>
        <select className="input" value={q.status ?? ''} onChange={(e) => set('status', e.target.value)} aria-label="Status"><option value="">All statuses</option>{STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</select>
        <select className="input" value={q.sector ?? ''} onChange={(e) => set('sector', e.target.value)} aria-label="Sector"><option value="">All sectors</option>{SECTORS.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</select>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={q.flagged === 'true'} onChange={(e) => set('flagged', e.target.checked ? 'true' : '')} /> Flagged for investigation</label>
      </div>
      {view === 'map' ? (
        <Suspense fallback={<Loading />}><ProjectMap countyId={q.countyId} status={q.status} sector={q.sector} /></Suspense>
      ) : (
        <>
          {loading && <Loading />}
          {error && <ErrorBox error={error} onRetry={reload} />}
          {data && data.items.length === 0 && <Empty title="No published projects match these filters">Project records appear here once imported from source documents and reviewed.</Empty>}
          <div className="grid gap-3 md:grid-cols-2">
            {data?.items.map((p) => (
              <Link key={p.id} to={`/projects/${encodeURIComponent(p.reference)}`} className="card hover:border-brand-500">
                <div className="flex items-start justify-between gap-2"><div><p className="text-xs text-gray-500">{p.reference} · {humanize(p.sector)}</p><p className="font-semibold text-navy-900">{p.name}</p></div><StatusBadge status={p.status} /></div>
                <p className="my-2 text-sm">Budget {fmtKes(p.approvedBudgetKes)} · Paid {fmtKes(p.amountPaidKes)}</p>
                <ProgressBars p={p.progress} />
                {p.discrepancyFlag && <p className="mt-2 text-xs font-semibold text-red-700">Flagged for investigation: documented gap between payments and delivery</p>}
              </Link>
            ))}
          </div>
          {data && <Pager page={page} total={data.total} limit={data.limit} onPage={(n) => { const p = new URLSearchParams(params); p.set('page', String(n)); setParams(p); }} />}
        </>
      )}
    </div>
  );
}

export function ProjectDetail() {
  const { reference } = useParams();
  const { data, error, loading } = useApi<{
    project: ProjectRow & { description?: string; constituencyName?: string; wardName?: string; revisedBudgetKes: number | null; amountPaidAsOf?: string; contractor?: { name: string }; procurementReference?: string; startDate?: string; plannedCompletionDate?: string; lastInspectionDate?: string; fundingSource?: string; source: SourceInfo; sources: SourceInfo[]; statusSource?: SourceInfo; verificationStatus: string; physicalProgressDetail?: { notes?: string; sourceId?: SourceInfo; assessedBy?: string }; discrepancyFlag: null | { reason: string; flaggedAt: string } };
    history: { _id: string; kind: string; summary: string; at: string; sourceId?: SourceInfo }[];
    revisions: { revision: number; status: string; amountPaidKes: number | null; correctionReason?: string; publishedAt: string; isCurrent: boolean }[];
    note: string;
  }>(`/public/projects/${encodeURIComponent(reference ?? '')}`);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const p = data.project;
  const rows: [string, React.ReactNode][] = [
    ['Reference', p.reference],
    ['Location', [p.constituencyName, p.wardName].filter(Boolean).join(', ') || '—'],
    ['Department', p.department?.name ?? '—'],
    ['Funding source', p.fundingSource ?? '—'],
    ['Approved budget', fmtKes(p.approvedBudgetKes)],
    ['Revised budget', fmtKes(p.revisedBudgetKes)],
    ['Amount paid to date', `${fmtKes(p.amountPaidKes)}${p.amountPaidAsOf ? ` (as of ${fmtDate(p.amountPaidAsOf)})` : ''}`],
    ['Contractor', p.contractor?.name ?? 'Not publicly documented'],
    ['Procurement reference', p.procurementReference ?? 'Not publicly documented'],
    ['Start date', fmtDate(p.startDate)],
    ['Planned completion', fmtDate(p.plannedCompletionDate)],
    ['Last inspection', fmtDate(p.lastInspectionDate)]
  ];
  return (
    <div className="space-y-6">
      <PageHeader title={p.name} subtitle={p.description} actions={<StatusBadge status={p.status} />} />
      {p.discrepancyFlag && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900"><strong>Flagged for investigation.</strong> {p.discrepancyFlag.reason} This flag records a documented discrepancy; it is not a finding of wrongdoing.</div>}
      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card lg:col-span-2"><dl className="grid gap-2 sm:grid-cols-2">{rows.map(([k, v]) => <div key={k}><dt className="text-xs uppercase text-gray-500">{k}</dt><dd className="text-sm">{v}</dd></div>)}</dl><SourceRef source={p.source} className="mt-3 block" /></section>
        <section className="card space-y-3"><h2 className="font-bold">Progress</h2><ProgressBars p={p.progress} /><p className="text-xs text-gray-600">{data.note}</p>{p.progress.physical && <p className="text-xs">Physical progress assessed {fmtDate(p.progress.physical.assessedAt)} by {humanize(p.progress.physical.basis)}{p.physicalProgressDetail?.assessedBy ? ` (${p.physicalProgressDetail.assessedBy})` : ''}.</p>}<StatusBadge status={p.verificationStatus} /></section>
      </div>
      <section className="card"><h2 className="font-bold">Update history</h2><ul className="mt-2 divide-y text-sm">{data.history.map((h) => <li key={h._id} className="py-2"><span className="text-xs text-gray-500">{fmtDateTime(h.at)} · {humanize(h.kind)}</span><p>{h.summary}</p>{h.sourceId && <SourceRef source={h.sourceId} />}</li>)}</ul></section>
      {data.revisions.length > 1 && <section className="card overflow-x-auto"><h2 className="font-bold">Published revisions</h2><table className="table mt-2"><thead><tr><th>Rev.</th><th>Status</th><th>Paid</th><th>Reason</th><th>Published</th></tr></thead><tbody>{data.revisions.map((r) => <tr key={r.revision}><td>{r.revision}{r.isCurrent ? ' (current)' : ''}</td><td>{humanize(r.status)}</td><td>{fmtKes(r.amountPaidKes)}</td><td>{r.correctionReason ?? '—'}</td><td>{fmtDate(r.publishedAt)}</td></tr>)}</tbody></table></section>}
      <p className="text-sm"><Link className="link" to={`/accountability?projectRef=${encodeURIComponent(p.reference)}#report`}>Report an observation about this project</Link></p>
    </div>
  );
}
