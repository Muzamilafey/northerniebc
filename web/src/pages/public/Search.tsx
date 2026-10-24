import { Link, useSearchParams } from 'react-router-dom';
import { Empty, Loading, PageHeader } from '../../components/ui';
import { humanize, POSITION_LABELS } from '../../lib/format';
import { useApi } from '../../lib/useApi';

type R = { _id: string; name?: string; code?: string; slug?: string; fullName?: string; party?: string; position?: string; reference?: string; findingKey?: string; entity?: string; documentTitle?: string; url?: string; electionId?: string };

export default function Search() {
  const [p, setP] = useSearchParams();
  const q = p.get('q') ?? '';
  const { data, loading } = useApi<Record<string, R[] | string>>(q.length >= 2 ? '/public/search' : null, { q });
  const groups: [string, string, (r: R) => JSX.Element][] = [
    ['counties', 'Counties', (r) => <Link className="link" to={`/counties/${r.slug}`}>{r.name}</Link>],
    ['constituencies', 'Constituencies', (r) => <Link className="link" to={`/results?electionId=${r.electionId}&constituencyId=${r._id}`}>{r.name}</Link>],
    ['wards', 'Wards', (r) => <Link className="link" to={`/results?electionId=${r.electionId}&wardId=${r._id}`}>{r.name}</Link>],
    ['stations', 'Polling stations', (r) => <Link className="link" to={`/results/stations/${r._id}`}>{r.code} — {r.name}</Link>],
    ['candidates', 'Candidates', (r) => <span>{r.fullName} ({r.party ?? 'Independent'}, {POSITION_LABELS[r.position ?? '']})</span>],
    ['projects', 'Projects', (r) => <Link className="link" to={`/projects/${encodeURIComponent(r.reference ?? '')}`}>{r.name}</Link>],
    ['departments', 'Departments', (r) => <Link className="link" to={`/budgets/departments/${r._id}`}>{r.name}</Link>],
    ['auditFindings', 'Audit findings', (r) => <Link className="link" to={`/accountability/findings/${encodeURIComponent(r.findingKey ?? '')}`}>{r.entity} ({r.findingKey})</Link>],
    ['sources', 'Reports & sources', (r) => (r.url ? <a className="link" href={r.url} target="_blank" rel="noreferrer">{r.name}</a> : <span>{r.name}</span>)]
  ];
  const any = data && groups.some(([k]) => Array.isArray(data[k]) && (data[k] as R[]).length);
  const years = (data?.financialYears as unknown as string[]) ?? [];
  return (
    <div>
      <PageHeader title="Search" />
      <input className="input mb-4 max-w-xl" defaultValue={q} placeholder="Search candidates, places, projects, findings…" onKeyDown={(e) => e.key === 'Enter' && setP({ q: (e.target as HTMLInputElement).value })} aria-label="Search" autoFocus />
      {loading && <Loading />}
      {data && !any && !years.length && <Empty title={`No public records match “${q}”`} />}
      <div className="grid gap-4 md:grid-cols-2">
        {groups.map(([k, label, render]) => Array.isArray(data?.[k]) && (data![k] as R[]).length > 0 && (
          <section key={k} className="card"><h2 className="font-bold">{label}</h2><ul className="mt-2 space-y-1 text-sm">{(data![k] as R[]).map((r) => <li key={r._id}>{render(r)}</li>)}</ul></section>
        ))}
        {years.length > 0 && <section className="card"><h2 className="font-bold">Financial years</h2><ul className="mt-2 text-sm">{years.map((y) => <li key={y}><Link className="link" to={`/budgets?financialYear=${encodeURIComponent(y)}`}>{humanize(y)}</Link></li>)}</ul></section>}
      </div>
    </div>
  );
}
