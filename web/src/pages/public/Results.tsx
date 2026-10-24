import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Empty, ErrorBox, Loading, PageHeader, PublicImage, StatusBadge } from '../../components/ui';
import { fmtDateTime, fmtNumber, fmtPct, POSITION_LABELS } from '../../lib/format';
import { getSocket } from '../../lib/socket';
import { useApi } from '../../lib/useApi';

interface Election { _id: string; name: string; status: string; positions: { position: string; enabled: boolean }[] }
interface Area { _id: string; name: string; code: string }
interface Tally {
  election: { name: string; status: string; publishProvisional: boolean };
  candidates: { candidateId: string; fullName: string; party?: string; partyAbbreviation?: string; photoFileId?: string | null; partyLogoFileId?: string | null; votes: number; verifiedVotes: number; share: number | null; rank: number }[];
  totals: { totalRecordedVotes: number; verifiedVotes: number; unverifiedVotes: number };
  coverage: { reported: number; registered: number; outstanding: number; percent: number | null };
  awaitingVerificationStations: number;
  overallStatus: string;
  lastUpdated: string | null;
  disclaimer: string;
}

function useSelect(params: URLSearchParams, setParams: (p: URLSearchParams) => void) {
  return (key: string, value: string, clear: string[] = []) => {
    const p = new URLSearchParams(params);
    if (value) p.set(key, value);
    else p.delete(key);
    clear.forEach((c) => p.delete(c));
    setParams(p);
  };
}

export default function Results() {
  const [params, setParams] = useSearchParams();
  const set = useSelect(params, setParams);
  const { data: el, loading: elLoading, error: elError } = useApi<{ items: Election[] }>('/public/elections');
  const electionId = params.get('electionId') ?? el?.items[0]?._id ?? '';
  const election = el?.items.find((e) => e._id === electionId);
  const positions = election?.positions.filter((p) => p.enabled).map((p) => p.position) ?? [];
  const position = params.get('position') ?? positions[0] ?? '';
  const countyId = params.get('countyId') ?? '';
  const constituencyId = params.get('constituencyId') ?? '';
  const wardId = params.get('wardId') ?? '';
  const pollingStationId = params.get('pollingStationId') ?? '';
  const [q, setQ] = useState('');

  const { data: counties } = useApi<{ items: Area[] }>('/public/counties');
  const { data: consts } = useApi<{ items: Area[] }>(electionId && countyId ? `/public/elections/${electionId}/constituencies` : null, { countyId });
  const { data: wards } = useApi<{ items: Area[] }>(electionId && constituencyId ? `/public/elections/${electionId}/wards` : null, { constituencyId });
  const { data: stations } = useApi<{ items: Area[] }>(electionId && wardId ? `/public/elections/${electionId}/stations` : null, { wardId });
  const tallyQuery = useMemo(() => ({ electionId, position, countyId, constituencyId, wardId, pollingStationId }), [electionId, position, countyId, constituencyId, wardId, pollingStationId]);
  const { data: tally, loading, error, reload } = useApi<Tally>(electionId && position ? '/public/results/tally' : null, tallyQuery);

  useEffect(() => {
    if (!electionId) return;
    const s = getSocket();
    s.emit('subscribe', { electionId });
    let t: ReturnType<typeof setTimeout> | undefined;
    const onUpdate = () => {
      clearTimeout(t);
      t = setTimeout(() => void reload(), 1500);
    };
    s.on('results:updated', onUpdate);
    return () => {
      s.off('results:updated', onUpdate);
      clearTimeout(t);
    };
  }, [electionId, reload]);

  const filtered = tally?.candidates.filter((c) => !q || `${c.fullName} ${c.party ?? ''}`.toLowerCase().includes(q.toLowerCase())) ?? [];

  if (elLoading) return <Loading />;
  if (elError) return <ErrorBox error={elError} />;
  if (!el?.items.length)
    return (
      <>
        <PageHeader title="Live Results" />
        <Empty title="No election results are available yet">Results will appear once an election has been configured from the official register and agents begin reporting.</Empty>
      </>
    );

  return (
    <div>
      <PageHeader title="Live Results" subtitle="Independent monitoring results from polling-station agents. Figures are labelled by verification status; no winner is declared here." />
      <div className="card mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <label><span className="label">Election</span>
          <select className="input" value={electionId} onChange={(e) => set('electionId', e.target.value, ['countyId', 'constituencyId', 'wardId', 'pollingStationId', 'position'])}>
            {el.items.map((e) => <option key={e._id} value={e._id}>{e.name}</option>)}
          </select>
        </label>
        <label><span className="label">Position</span>
          <select className="input" value={position} onChange={(e) => set('position', e.target.value)}>
            {positions.map((p) => <option key={p} value={p}>{POSITION_LABELS[p]}</option>)}
          </select>
        </label>
        <label><span className="label">County</span>
          <select className="input" value={countyId} onChange={(e) => set('countyId', e.target.value, ['constituencyId', 'wardId', 'pollingStationId'])}>
            <option value="">All covered counties</option>
            {counties?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
          </select>
        </label>
        <label><span className="label">Constituency</span>
          <select className="input" value={constituencyId} disabled={!countyId} onChange={(e) => set('constituencyId', e.target.value, ['wardId', 'pollingStationId'])}>
            <option value="">All</option>
            {consts?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
          </select>
        </label>
        <label><span className="label">Ward</span>
          <select className="input" value={wardId} disabled={!constituencyId} onChange={(e) => set('wardId', e.target.value, ['pollingStationId'])}>
            <option value="">All</option>
            {wards?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
          </select>
        </label>
        <label><span className="label">Polling station</span>
          <select className="input" value={pollingStationId} disabled={!wardId} onChange={(e) => set('pollingStationId', e.target.value)}>
            <option value="">All</option>
            {stations?.items.map((c) => <option key={c._id} value={c._id}>{c.code} — {c.name}</option>)}
          </select>
        </label>
      </div>

      {loading && !tally && <Loading />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {tally && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge status={tally.overallStatus} />
            <span className="text-sm text-gray-600">Last updated {fmtDateTime(tally.lastUpdated)}</span>
            {pollingStationId && <Link className="link text-sm" to={`/results/stations/${pollingStationId}`}>Station page (all positions)</Link>}
            <button className="btn-outline ml-auto" onClick={() => navigator.clipboard?.writeText(window.location.href)}>Copy share link</button>
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="card"><p className="text-xs uppercase text-gray-500">Reporting coverage</p><p className="text-2xl font-bold">{fmtPct(tally.coverage.percent ?? 0)}</p><p className="text-xs text-gray-500">{tally.coverage.reported} of {tally.coverage.registered} stations</p></div>
            <div className="card"><p className="text-xs uppercase text-gray-500">Outstanding stations</p><p className="text-2xl font-bold">{fmtNumber(tally.coverage.outstanding)}</p><p className="text-xs text-gray-500">{tally.awaitingVerificationStations} awaiting verification</p></div>
            <div className="card"><p className="text-xs uppercase text-gray-500">Total recorded votes</p><p className="text-2xl font-bold">{fmtNumber(tally.totals.totalRecordedVotes)}</p></div>
            <div className="card"><p className="text-xs uppercase text-gray-500">Verified / unverified</p><p className="text-2xl font-bold">{fmtNumber(tally.totals.verifiedVotes)}</p><p className="text-xs text-gray-500">{fmtNumber(tally.totals.unverifiedVotes)} not yet verified</p></div>
          </div>
          <div className="h-2 rounded bg-gray-200" aria-hidden="true"><div className="h-2 rounded bg-brand-600" style={{ width: `${tally.coverage.percent ?? 0}%` }} /></div>

          {tally.candidates.length === 0 ? (
            <Empty title="No candidates to show for this selection">Choose a narrower area (for example a ward for MCA) to see the ballot.</Empty>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="card h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={tally.candidates.slice(0, 10)} layout="vertical" margin={{ left: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" />
                    <YAxis type="category" dataKey="fullName" width={120} tick={{ fontSize: 12 }} />
                    <Tooltip formatter={(v: number) => fmtNumber(v)} />
                    <Bar dataKey="votes" fill="#d17426" name="Votes" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="card overflow-x-auto">
                <input className="input mb-2" placeholder="Search candidates" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search candidates" />
                <table className="table">
                  <thead><tr><th>#</th><th>Candidate</th><th>Party</th><th className="text-right">Votes</th><th className="text-right">Share</th></tr></thead>
                  <tbody>
                    {filtered.map((c) => (
                      <tr key={c.candidateId}>
                        <td>{c.rank}</td>
                        <td className="font-medium"><span className="flex items-center gap-2"><PublicImage fileId={c.photoFileId} alt="" fallback={c.fullName} size={32} rounded="rounded-full" />{c.fullName}</span></td>
                        <td><span className="flex items-center gap-2"><PublicImage fileId={c.partyLogoFileId} alt="" fallback={c.partyAbbreviation ?? 'IND'} size={24} />{c.partyAbbreviation ?? c.party ?? 'Independent'}</span></td>
                        <td className="text-right tabular-nums">{fmtNumber(c.votes)}</td>
                        <td className="text-right tabular-nums">{fmtPct(c.share)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{tally.disclaimer}</p>
        </div>
      )}
    </div>
  );
}
