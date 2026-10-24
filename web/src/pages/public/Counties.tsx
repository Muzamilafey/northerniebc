import { Link, useParams } from 'react-router-dom';
import { ErrorBox, Loading, PageHeader, PublicImage } from '../../components/ui';
import { useApi } from '../../lib/useApi';

export function Counties() {
  const { data, error, loading } = useApi<{ items: { _id: string; name: string; slug: string; code: string; region?: string; logoFileId?: string | null }[] }>('/public/counties');
  return (
    <div>
      <PageHeader title="Counties" subtitle="The five counties covered by the platform." />
      {loading && <Loading />}
      {error && <ErrorBox error={error} />}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data?.items.map((c) => (
          <Link key={c._id} to={`/counties/${c.slug}`} className="card flex items-center gap-3 hover:border-brand-500">
            <PublicImage fileId={c.logoFileId} alt={`${c.name} County logo`} size={56} />
            <div>
              <p className="text-xs text-gray-500">County code {c.code} · {c.region}</p>
              <p className="text-xl font-bold text-navy-900">{c.name}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function CountyPage() {
  const { slug } = useParams();
  const { data, error, loading } = useApi<{ county: { _id: string; name: string; code: string; logoFileId?: string | null }; counts: { projects: number; auditFindings: number }; budgetYears: string[] }>(`/public/counties/${slug}`);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const c = data.county;
  return (
    <div>
      {c.logoFileId && <PublicImage fileId={c.logoFileId} alt={`${c.name} County logo`} size={72} />}
      <PageHeader title={`${c.name} County`} subtitle={`County code ${c.code}`} />
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Link className="card hover:border-brand-500" to={`/results?countyId=${c._id}`}><p className="font-bold">Election results</p><p className="text-sm text-gray-600">By constituency, ward and station</p></Link>
        <Link className="card hover:border-brand-500" to={`/budgets?countyId=${c._id}`}><p className="font-bold">Budget &amp; spending</p><p className="text-sm text-gray-600">{data.budgetYears.length ? `Years: ${data.budgetYears.join(', ')}` : 'No budget data published yet'}</p></Link>
        <Link className="card hover:border-brand-500" to={`/projects?countyId=${c._id}`}><p className="font-bold">Development projects</p><p className="text-sm text-gray-600">{data.counts.projects} published</p></Link>
        <Link className="card hover:border-brand-500" to={`/accountability?countyId=${c._id}`}><p className="font-bold">Audit findings</p><p className="text-sm text-gray-600">{data.counts.auditFindings} published</p></Link>
      </div>
    </div>
  );
}
