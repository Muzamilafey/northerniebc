import { Link } from 'react-router-dom';
import { DataUnavailable, ErrorBox, Loading, PublicImage, StatusBadge } from '../../components/ui';
import { fmtDate, fmtKesShort, fmtPct, humanize } from '../../lib/format';
import { useApi } from '../../lib/useApi';

interface HomeData {
  counties: { _id: string; name: string; slug: string; code: string; logoFileId?: string | null }[];
  election: { id: string; name: string; status: string; active: boolean; electionDate: string; registeredStations: number; reportedStations: number; coveragePercent: number | null } | null;
  budgets: { countyId: string; county: string; figure: null | { metric: string; valueKes: number; financialYear: string; periodLabel: string; source: never; verificationStatus: string } }[];
  recentProjects: { reference: string; name: string; status: string; publishedAt: string }[];
  latestFindings: { findingKey: string; entity: string; category: string; financialYear: string; amountQuestionedCents?: number }[];
  updates: { _id: string; title: string; body: string; kind: string; publishedAt: string }[];
}

export default function Home() {
  const { data, error, loading, reload } = useApi<HomeData>('/public/home');
  return (
    <div className="space-y-10">
      <section className="overflow-hidden rounded-2xl bg-gradient-to-br from-navy-900 to-navy-700 text-white">
        <div className="grid items-center gap-6 p-6 sm:p-10 md:grid-cols-[1fr_auto]">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wider text-brand-400">tulinde Kura Zetu</p>
            <h1 className="mt-2 text-3xl font-bold sm:text-4xl">Follow the Vote. Follow the Money.</h1>
            <p className="mt-3 max-w-2xl text-white/85">
              Independent election monitoring and public-finance accountability for Garissa, Mandera, Wajir, Isiolo and Marsabit — every important figure linked to its source.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link to="/results" className="btn bg-white text-navy-900 hover:bg-gray-100">Live results</Link>
              <Link to="/budgets" className="btn border border-white/40 text-white hover:bg-white/10">County budgets</Link>
              <Link to="/donate" className="btn-accent">Support the platform</Link>
            </div>
          </div>
          <img src="/brand/logo.svg" alt="" className="mx-auto hidden h-48 w-48 md:block" />
        </div>
      </section>

      {loading && <Loading />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {data && (
        <>
          <section aria-labelledby="results-h" className="card">
            <h2 id="results-h" className="text-xl font-bold text-navy-900">Election results</h2>
            {data.election ? (
              <div className="mt-3 flex flex-wrap items-center gap-4">
                <div>
                  <p className="font-semibold">{data.election.name}</p>
                  <p className="text-sm text-gray-600">{data.election.active ? 'Results are being received.' : `Latest archived election (${fmtDate(data.election.electionDate)}).`}</p>
                </div>
                <div className="text-sm">
                  <p>
                    <strong>{data.election.reportedStations}</strong> of {data.election.registeredStations} polling stations reported ({fmtPct(data.election.coveragePercent ?? 0)})
                  </p>
                  <div className="mt-1 h-2 w-64 max-w-full rounded bg-gray-200"><div className="h-2 rounded bg-brand-600" style={{ width: `${data.election.coveragePercent ?? 0}%` }} /></div>
                </div>
                <Link to={`/results?electionId=${data.election.id}`} className="btn-primary ml-auto">View results</Link>
              </div>
            ) : (
              <p className="mt-2 text-gray-600">No election is active and no archived election has been loaded yet. Results will appear here once an election is configured from the official register.</p>
            )}
          </section>

          <section aria-labelledby="counties-h">
            <h2 id="counties-h" className="mb-3 text-xl font-bold text-navy-900">Counties</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {data.counties.map((c) => {
                const b = data.budgets.find((x) => x.countyId === c._id);
                return (
                  <Link key={c._id} to={`/counties/${c.slug}`} className="card transition hover:border-brand-500 hover:shadow">
                    <div className="flex items-center gap-2">
                      <PublicImage fileId={c.logoFileId} alt={`${c.name} County logo`} size={36} />
                      <div>
                        <p className="text-xs text-gray-500">County {c.code}</p>
                        <p className="text-lg font-bold text-navy-900">{c.name}</p>
                      </div>
                    </div>
                    <p className="mt-2 text-sm">
                      {b?.figure ? (
                        <>
                          {humanize(b.figure.metric)} {b.figure.financialYear}: <strong>{fmtKesShort(b.figure.valueKes)}</strong>
                        </>
                      ) : (
                        <span className="text-gray-500">Budget data not yet published</span>
                      )}
                    </p>
                  </Link>
                );
              })}
            </div>
            {data.budgets.every((b) => !b.figure) && <div className="mt-3"><DataUnavailable what="County budget information" /></div>}
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="card" aria-labelledby="proj-h">
              <h2 id="proj-h" className="text-lg font-bold text-navy-900">Recently updated projects</h2>
              {data.recentProjects.length === 0 ? (
                <p className="mt-2 text-sm text-gray-600">No project records have been published yet.</p>
              ) : (
                <ul className="mt-2 divide-y">
                  {data.recentProjects.map((p) => (
                    <li key={p.reference} className="flex items-center justify-between gap-2 py-2">
                      <Link className="link" to={`/projects/${encodeURIComponent(p.reference)}`}>{p.name}</Link>
                      <StatusBadge status={p.status} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="card" aria-labelledby="find-h">
              <h2 id="find-h" className="text-lg font-bold text-navy-900">Latest audit findings</h2>
              {data.latestFindings.length === 0 ? (
                <p className="mt-2 text-sm text-gray-600">No audit findings have been published yet.</p>
              ) : (
                <ul className="mt-2 divide-y">
                  {data.latestFindings.map((f) => (
                    <li key={f.findingKey} className="py-2 text-sm">
                      <Link className="link" to={`/accountability/findings/${encodeURIComponent(f.findingKey)}`}>{f.entity}</Link>
                      <span className="text-gray-600"> — {humanize(f.category)}, FY {f.financialYear}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-gray-500">Audit queries are reported as worded by the auditor and are not findings of wrongdoing.</p>
            </section>
          </div>

          <section className="grid gap-6 lg:grid-cols-3">
            <div className="card lg:col-span-2">
              <h2 className="text-lg font-bold text-navy-900">Platform updates &amp; methodology</h2>
              {data.updates.length === 0 ? (
                <p className="mt-2 text-sm text-gray-600">No updates yet. Read our <Link className="link" to="/about">methodology</Link>.</p>
              ) : (
                data.updates.map((u) => (
                  <article key={u._id} className="mt-3 border-t pt-3">
                    <p className="text-xs text-gray-500">{humanize(u.kind)} · {fmtDate(u.publishedAt)}</p>
                    <h3 className="font-semibold">{u.title}</h3>
                    <p className="whitespace-pre-line text-sm text-gray-700">{u.body}</p>
                  </article>
                ))
              )}
            </div>
            <div className="card bg-brand-50">
              <h2 className="text-lg font-bold text-navy-900">Keep this platform independent</h2>
              <p className="mt-2 text-sm text-gray-700">Contributions support hosting, data collection, verification, research and public access.</p>
              <Link to="/donate" className="btn-accent mt-3">Donate</Link>
              <p className="mt-3 text-xs"><Link to="/accountability#report" className="link">Spotted an error? Request a correction.</Link></p>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
