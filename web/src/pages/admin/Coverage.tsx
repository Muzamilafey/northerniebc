import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, ErrorBox, LiveBadge, Loading, PageHeader, Segmented, Stat } from '../../components/ui';
import { fmtDateTime, fmtNumber, POSITION_LABELS } from '../../lib/format';
import { useApi } from '../../lib/useApi';

interface Agent { id: string; fullName: string; agentCode: string | null; status: string; approved: boolean; lastSeenAt: string | null; active: boolean; phoneMasked: string | null }
interface Row { station: { id: string; code: string; name: string; ward: string | null; registeredVoters: number | null }; agents: Agent[]; reported: boolean }
interface Coverage { generatedAt: string; summary: { stations: number; withoutAgent: number; agentsNotApproved: number; silentAgents: number; reported: number; notReported: number }; rows: Row[]; truncated: boolean }

type Filter = 'all' | 'noAgent' | 'silent' | 'notApproved' | 'notReported';
const usable = (a: Agent) => a.status === 'ACTIVE' && a.approved;

/** Election-day view of which stations are covered by an agent, who has gone quiet, and what is still to report. */
export default function CoveragePage() {
  const { data: el, loading: elLoading } = useApi<{ items: { _id: string; name: string; positions: { position: string; enabled: boolean }[] }[] }>('/admin/elections');
  const { data: counties } = useApi<{ items: { _id: string; name: string }[] }>('/public/counties');
  const [electionId, setElectionId] = useState('');
  const [countyId, setCountyId] = useState('');
  const [position, setPosition] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [paused, setPaused] = useState(false);
  const eid = electionId || el?.items[0]?._id || '';
  const election = el?.items.find((e) => e._id === eid);
  const cov = useApi<Coverage>(eid ? '/verification/coverage' : null, { electionId: eid, countyId: countyId || undefined, position: position || undefined }, { refreshMs: paused ? undefined : 5000 });

  const rows = useMemo(() => {
    const all = cov.data?.rows ?? [];
    const needle = q.trim().toLowerCase();
    return all.filter((r) => {
      if (needle && !`${r.station.code} ${r.station.name} ${r.station.ward ?? ''} ${r.agents.map((a) => `${a.fullName} ${a.agentCode ?? ''}`).join(' ')}`.toLowerCase().includes(needle)) return false;
      if (filter === 'noAgent') return !r.agents.some(usable);
      if (filter === 'silent') return r.agents.some((a) => usable(a) && !a.active);
      if (filter === 'notApproved') return r.agents.some((a) => a.status === 'ACTIVE' && !a.approved);
      if (filter === 'notReported') return !r.reported;
      return true;
    });
  }, [cov.data, filter, q]);

  if (elLoading) return <Loading />;
  if (!el?.items.length) return <Empty title="No elections configured" />;
  const s = cov.data?.summary;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Election-day coverage"
        subtitle="Which polling stations have an approved agent, which agents have gone quiet, and which stations have not reported yet. Updates every 5 seconds."
        actions={cov.data && <div className="flex flex-wrap items-center gap-2"><LiveBadge updatedAt={cov.updatedAt} stale={cov.stale} paused={paused} label="Live · updates every 5 seconds" /><button type="button" className="btn-ghost btn-sm" aria-pressed={paused} onClick={() => setPaused((v) => !v)}>{paused ? 'Resume updates' : 'Pause updates'}</button></div>}
      />
      <div className="card grid gap-3 sm:grid-cols-3">
        <select className="input" aria-label="Election" value={eid} onChange={(e) => { setElectionId(e.target.value); setPosition(''); }}>{el.items.map((e) => <option key={e._id} value={e._id}>{e.name}</option>)}</select>
        <select className="input" aria-label="County" value={countyId} onChange={(e) => setCountyId(e.target.value)}><option value="">All counties in scope</option>{counties?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select>
        <select className="input" aria-label="Reported for position" value={position} onChange={(e) => setPosition(e.target.value)}><option value="">Reported: any position</option>{election?.positions.filter((p) => p.enabled).map((p) => <option key={p.position} value={p.position}>Reported: {POSITION_LABELS[p.position]}</option>)}</select>
      </div>
      {cov.error && <ErrorBox error={cov.error} />}
      {cov.loading && !cov.data && <Loading />}
      {s && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="Polling stations" value={fmtNumber(s.stations)} />
          <Stat label="Without an approved agent" value={<button className="link" onClick={() => setFilter('noAgent')}>{fmtNumber(s.withoutAgent)}</button>} />
          <Stat label="Agents not seen (30 min)" value={<button className="link" onClick={() => setFilter('silent')}>{fmtNumber(s.silentAgents)}</button>} hint="Approved, but no activity for 30 minutes" />
          <Stat label="Agents awaiting approval" value={<button className="link" onClick={() => setFilter('notApproved')}>{fmtNumber(s.agentsNotApproved)}</button>} />
          <Stat label="Reported / not yet" value={`${fmtNumber(s.reported)} / ${fmtNumber(s.notReported)}`} />
        </div>
      )}
      {cov.data && (
        <section className="card">
          <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <Segmented
              label="Show"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All' },
                { value: 'noAgent', label: 'No agent', count: s?.withoutAgent },
                { value: 'silent', label: 'Agent quiet', count: s?.silentAgents },
                { value: 'notApproved', label: 'Awaiting approval', count: s?.agentsNotApproved },
                { value: 'notReported', label: 'Not reported', count: s?.notReported }
              ]}
            />
            <input className="input lg:max-w-xs" type="search" placeholder="Search station, ward or agent" aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {cov.data.truncated && <p className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Showing the first 5,000 stations — choose a county to narrow the list.</p>}
          {rows.length === 0 ? (
            <Empty title="Nothing to show">No stations match this filter.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Station</th><th>Ward</th><th>Agent</th><th>Last seen</th><th>Reported</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {rows.slice(0, 500).map((r) => (
                    <tr key={r.station.id}>
                      <td><p className="font-medium">{r.station.name}</p><p className="text-xs text-gray-500">{r.station.code}{r.station.registeredVoters != null ? ` · ${fmtNumber(r.station.registeredVoters)} voters` : ''}</p></td>
                      <td className="text-gray-600">{r.station.ward ?? '—'}</td>
                      <td>
                        {r.agents.length === 0 ? <span className="badge bg-red-100 text-red-800">No agent</span> : r.agents.map((a) => (
                          <div key={a.id} className="mb-1 last:mb-0">
                            <span className="font-medium">{a.fullName}</span> <span className="text-xs text-gray-500">{a.agentCode}{a.phoneMasked ? ` · ${a.phoneMasked}` : ''}</span>
                            {!a.approved && <span className="badge ml-1 bg-amber-100 text-amber-900">Awaiting approval</span>}
                            {a.status !== 'ACTIVE' && <span className="badge ml-1 bg-gray-200 text-gray-700">{a.status.toLowerCase()}</span>}
                          </div>
                        ))}
                      </td>
                      <td className="whitespace-nowrap text-xs">
                        {r.agents.map((a) => (
                          <div key={a.id} className="mb-1 flex items-center gap-1.5 last:mb-0">
                            <span className={`h-2 w-2 rounded-full ${a.active ? 'bg-green-500' : 'bg-gray-300'}`} aria-hidden="true" />
                            {a.lastSeenAt ? fmtDateTime(a.lastSeenAt) : 'Never signed in'}
                          </div>
                        ))}
                      </td>
                      <td>{r.reported ? <span className="badge bg-green-100 text-green-800">Reported</span> : <span className="badge bg-gray-100 text-gray-600">Not yet</span>}</td>
                      <td className="text-right">{!r.agents.some(usable) && <Link className="btn-outline btn-sm" to="/admin/users">Assign agent</Link>}{r.reported && <Link className="btn-ghost btn-sm" to={`/results/stations/${r.station.id}`}>Results</Link>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > 500 && <p className="p-3 text-center text-sm text-gray-500">Showing 500 of {fmtNumber(rows.length)} — use search or a filter to narrow.</p>}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
