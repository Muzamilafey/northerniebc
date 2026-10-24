import { useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Empty, ErrorBox, Field, Loading, PageHeader, Pager, SourceRef, StatusBadge, Success, type SourceInfo } from '../../components/ui';
import { fmtDate, fmtKes, humanize } from '../../lib/format';
import { useApi } from '../../lib/useApi';

interface Finding { id: string; findingKey: string; financialYear: string; entity: string; category: string; categoryLabel: string; amountQuestionedKes: number | null; description: string; reportTitle: string; pageNumber?: string; latestKnownStatus: string; source: SourceInfo; managementResponse?: string; auditorRecommendation?: string; recoveryOrInvestigationStatus?: string; reportPublicationDate?: string; sourceUrl?: string; verificationStatus: string; revision: number; correctionReason?: string }
const CATEGORIES = ['UNSUPPORTED_EXPENDITURE', 'IRREGULAR_EXPENDITURE', 'UNEXPLAINED_DISCREPANCY', 'PENDING_BILLS', 'DELAYED_PROJECT', 'RECOMMENDED_FOR_RECOVERY', 'CONFIRMED_LOSS', 'ALLEGATION_UNDER_INVESTIGATION', 'OTHER'];
const REPORT_TYPES: [string, string][] = [
  ['STALLED_PROJECT', 'Potentially stalled project'],
  ['INCOMPLETE_INFRASTRUCTURE', 'Incomplete infrastructure'],
  ['SPENDING_DELIVERY_DISCREPANCY', 'Reported spending vs. what I observed'],
  ['MISSING_PUBLIC_INFORMATION', 'Missing public information'],
  ['DUPLICATE_OR_ABANDONED_PROJECT', 'Possible duplicate or abandoned project'],
  ['DATA_CORRECTION_REQUEST', 'Correction request for data on this site']
];

export default function Accountability() {
  const [params, setParams] = useSearchParams();
  const q = Object.fromEntries(params.entries());
  const page = Number(q.page ?? 1);
  const { data: counties } = useApi<{ items: { _id: string; name: string }[] }>('/public/counties');
  const { data, error, loading } = useApi<{ items: Finding[]; total: number; limit: number; wordingNote: string }>('/public/audit-findings', { countyId: q.countyId, category: q.category, financialYear: q.financialYear, q: q.q, page });
  const { data: reports } = useApi<{ items: { _id: string; reference: string; type: string; title: string; publicSummary: string; status: string; reviewedAt: string; label: string }[] }>('/public/citizen-reports', { countyId: q.countyId });
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); p.delete('page'); setParams(p); };
  return (
    <div className="space-y-8">
      <PageHeader title="Audit & Accountability" subtitle="Findings from official audit reports, worded as in the source, and citizen reports reviewed by moderators." />
      <section>
        <div className="card mb-3 grid gap-3 sm:grid-cols-4">
          <input className="input" placeholder="Search findings" defaultValue={q.q} onKeyDown={(e) => e.key === 'Enter' && set('q', (e.target as HTMLInputElement).value)} aria-label="Search findings" />
          <select className="input" value={q.countyId ?? ''} onChange={(e) => set('countyId', e.target.value)} aria-label="County"><option value="">All counties</option>{counties?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select>
          <select className="input" value={q.category ?? ''} onChange={(e) => set('category', e.target.value)} aria-label="Category"><option value="">All categories</option>{CATEGORIES.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</select>
          <input className="input" placeholder="Financial year e.g. 2022/23" defaultValue={q.financialYear} onKeyDown={(e) => e.key === 'Enter' && set('financialYear', (e.target as HTMLInputElement).value)} aria-label="Financial year" />
        </div>
        {data && <p className="mb-3 rounded-lg bg-navy-50 p-3 text-xs text-gray-700">{data.wordingNote}</p>}
        {loading && <Loading />}
        {error && <ErrorBox error={error} />}
        {data && data.items.length === 0 && <Empty title="No audit findings published for this selection" />}
        <div className="space-y-3">
          {data?.items.map((f) => (
            <article key={f.id} className="card">
              <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500"><span className="rounded bg-gray-100 px-2 py-0.5 font-semibold text-gray-800">{f.categoryLabel}</span><span>FY {f.financialYear}</span><span>{f.entity}</span></div>
              <p className="mt-2 text-sm">“{f.description}”</p>
              <p className="mt-1 text-sm">Amount questioned: <strong>{fmtKes(f.amountQuestionedKes)}</strong> · Latest known status: {f.latestKnownStatus}</p>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2"><SourceRef source={f.source} page={f.pageNumber} /><Link className="link text-sm" to={`/accountability/findings/${encodeURIComponent(f.findingKey)}`}>Details &amp; history</Link></div>
            </article>
          ))}
        </div>
        {data && <Pager page={page} total={data.total} limit={data.limit} onPage={(n) => { const p = new URLSearchParams(params); p.set('page', String(n)); setParams(p); }} />}
      </section>

      <section>
        <h2 className="mb-2 text-xl font-bold text-navy-900">Citizen reports</h2>
        <p className="mb-3 text-sm text-gray-600">Reports from members of the public, summarised by moderators. They are not verified facts or findings.</p>
        {!reports?.items.length ? <Empty title="No reviewed citizen reports yet" /> : (
          <div className="grid gap-3 md:grid-cols-2">{reports.items.map((r) => <article key={r._id} className="card"><p className="text-xs text-gray-500">{r.reference} · {humanize(r.type)} · reviewed {fmtDate(r.reviewedAt)}</p><p className="font-semibold">{r.title}</p><p className="text-sm">{r.publicSummary}</p><p className="mt-1 text-xs text-amber-800">{r.label}</p></article>)}</div>
        )}
      </section>
      <CitizenReportForm counties={counties?.items ?? []} />
    </div>
  );
}

function CitizenReportForm({ counties }: { counties: { _id: string; name: string }[] }) {
  const [state, setState] = useState<{ busy: boolean; error?: string; ref?: string; message?: string }>({ busy: false });
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    for (const [k, v] of [...form.entries()]) if (v === '' || (v instanceof File && v.size === 0)) form.delete(k);
    setState({ busy: true });
    try {
      const r = await api<{ reference: string; message: string }>('/public/citizen-reports', { form });
      setState({ busy: false, ref: r.reference, message: r.message });
      (e.target as HTMLFormElement).reset();
    } catch (err) {
      setState({ busy: false, error: (err as Error).message });
    }
  }
  return (
    <section id="report" className="card">
      <h2 className="text-xl font-bold text-navy-900">Report an issue or request a correction</h2>
      <p className="mt-1 text-sm text-gray-600">Your report is reviewed before anything is published. We never publish your name or contact details, and we do not publish accusations as facts.</p>
      {state.ref ? <div className="mt-3"><Success>{state.message} Reference: <strong>{state.ref}</strong></Success></div> : (
        <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={submit}>
          <Field label="Type of report"><select name="type" className="input" required>{REPORT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="County"><select name="countyId" className="input"><option value="">Not specific</option>{counties.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select></Field>
          <Field label="Title"><input name="title" className="input" required minLength={5} maxLength={200} /></Field>
          <Field label="Location (village, ward, landmark)"><input name="locationText" className="input" maxLength={300} /></Field>
          <div className="sm:col-span-2"><Field label="What did you observe?" hint="Describe what you saw and when. Avoid naming private individuals."><textarea name="description" className="input min-h-[120px]" required minLength={20} maxLength={5000} /></Field></div>
          <Field label="Photos or documents (optional, up to 3)" hint="JPEG, PNG, WebP or PDF, max 10 MB each. Remove location metadata if you wish to stay anonymous."><input type="file" name="files" multiple accept="image/jpeg,image/png,image/webp,application/pdf" className="input" /></Field>
          <Field label="Related link (optional)"><input name="relatedUrl" type="url" className="input" /></Field>
          <Field label="Your name (optional, kept private)"><input name="reporterName" className="input" maxLength={200} /></Field>
          <Field label="Contact for follow-up (optional, kept private)"><input name="reporterContact" className="input" maxLength={200} /></Field>
          <input type="text" name="website" className="hidden" tabIndex={-1} autoComplete="off" aria-hidden="true" />
          <label className="flex items-start gap-2 text-sm sm:col-span-2"><input type="checkbox" name="consentPrivacy" value="true" required className="mt-1" /> I have read the <Link to="/privacy" className="link">privacy notice</Link> and understand my report will be moderated before any summary is published.</label>
          {state.error && <div className="sm:col-span-2"><ErrorBox error={state.error} /></div>}
          <div className="sm:col-span-2"><button className="btn-primary" disabled={state.busy}>{state.busy ? 'Sending…' : 'Submit report'}</button></div>
        </form>
      )}
    </section>
  );
}

export function FindingDetail() {
  const { key } = useParams();
  const { data, error, loading } = useApi<{ finding: Finding; history: { revision: number; latestKnownStatus: string; correctionReason?: string; publishedAt: string; isCurrent: boolean }[]; wordingNote: string }>(`/public/audit-findings/${encodeURIComponent(key ?? '')}`);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const f = data.finding;
  return (
    <div className="space-y-4">
      <PageHeader title={f.categoryLabel} subtitle={`${f.entity} · FY ${f.financialYear}`} actions={<StatusBadge status={f.verificationStatus} />} />
      <section className="card space-y-2 text-sm">
        <p><strong>As stated in the report:</strong> “{f.description}”</p>
        <p><strong>Amount questioned:</strong> {fmtKes(f.amountQuestionedKes)}</p>
        <p><strong>Report:</strong> {f.reportTitle}{f.pageNumber ? `, p. ${f.pageNumber}` : ''} ({fmtDate(f.reportPublicationDate)})</p>
        {f.managementResponse && <p><strong>Management response:</strong> {f.managementResponse}</p>}
        {f.auditorRecommendation && <p><strong>Auditor's recommendation:</strong> {f.auditorRecommendation}</p>}
        {f.recoveryOrInvestigationStatus && <p><strong>Recovery / investigation status:</strong> {f.recoveryOrInvestigationStatus}</p>}
        <p><strong>Latest known status:</strong> {f.latestKnownStatus}</p>
        <SourceRef source={f.source} page={f.pageNumber} />
        {f.sourceUrl && <p><a className="link" href={f.sourceUrl} target="_blank" rel="noopener noreferrer">Open source document</a></p>}
      </section>
      <section className="card overflow-x-auto"><h2 className="font-bold">Status history</h2><table className="table mt-2"><thead><tr><th>Rev.</th><th>Status</th><th>Change reason</th><th>Published</th></tr></thead><tbody>{data.history.map((h) => <tr key={h.revision}><td>{h.revision}{h.isCurrent ? ' (current)' : ''}</td><td>{h.latestKnownStatus}</td><td>{h.correctionReason ?? '—'}</td><td>{fmtDate(h.publishedAt)}</td></tr>)}</tbody></table></section>
      <p className="rounded-lg bg-navy-50 p-3 text-xs">{data.wordingNote}</p>
    </div>
  );
}
