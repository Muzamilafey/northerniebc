import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Empty, ErrorBox, Loading, PageHeader, Stat, StatusBadge } from '../../components/ui';
import { fmtDateTime, fmtNumber, fmtPct, POSITION_LABELS } from '../../lib/format';
import { getSocket } from '../../lib/socket';
import { useApi } from '../../lib/useApi';

interface Dash { registeredStations: number; stationsReported: number; stationsNotReported: number; coverage: { percent: number | null }; submissionsAwaitingVerification: number; verifiedStations: number; rejectedSubmissions: number; conflictedSubmissions: number; assignedAgents: number; activeAgents: number; lastDataUpdate: string | null }

export default function Dashboard() {
  const { data: el, loading } = useApi<{ items: { _id: string; name: string; status: string; positions: { position: string; enabled: boolean }[] }[] }>('/admin/elections');
  const [electionId, setElectionId] = useState('');
  const [position, setPosition] = useState('');
  const [countyId, setCountyId] = useState('');
  const { data: counties } = useApi<{ items: { _id: string; name: string }[] }>('/public/counties');
  const eid = electionId || el?.items[0]?._id || '';
  const election = el?.items.find((e) => e._id === eid);
  const pos = position || election?.positions.find((p) => p.enabled)?.position || '';
  const dash = useApi<Dash>(eid ? '/verification/dashboard' : null, { electionId: eid, countyId, position: pos });
  const tally = useApi<{ candidates: { candidateId: string; fullName: string; votes: number; verifiedVotes: number; share: number | null }[]; overallStatus: string }>(eid && pos ? '/verification/tally' : null, { electionId: eid, position: pos, countyId });
  const [feed, setFeed] = useState<{ at: Date; type: string; submissionId?: string }[]>([]);

  useEffect(() => {
    if (!eid) return;
    const s = getSocket();
    s.emit('subscribe', { electionId: eid });
    let t: ReturnType<typeof setTimeout> | undefined;
    const h = (e: { type: string; submissionId?: string }) => {
      setFeed((f) => [{ at: new Date(), ...e }, ...f].slice(0, 20));
      clearTimeout(t);
      t = setTimeout(() => { void dash.reload(); void tally.reload(); }, 1000);
    };
    s.on('admin:results', h);
    return () => { s.off('admin:results', h); clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eid]);

  if (loading) return <Loading />;
  if (!el?.items.length) return <Empty title="No elections configured">A super administrator creates elections under Election setup, then imports the station register and candidate lists.</Empty>;
  const d = dash.data;
  return (
    <div className="space-y-4">
      <PageHeader title="Results monitoring" subtitle="Raw submissions, accepted results and published results are tracked separately. Figures below include unverified data within your scope." />
      <div className="card grid gap-3 sm:grid-cols-3">
        <select className="input" value={eid} onChange={(e) => { setElectionId(e.target.value); setPosition(''); }} aria-label="Election">{el.items.map((e) => <option key={e._id} value={e._id}>{e.name} ({e.status})</option>)}</select>
        <select className="input" value={pos} onChange={(e) => setPosition(e.target.value)} aria-label="Position">{election?.positions.filter((p) => p.enabled).map((p) => <option key={p.position} value={p.position}>{POSITION_LABELS[p.position]}</option>)}</select>
        <select className="input" value={countyId} onChange={(e) => setCountyId(e.target.value)} aria-label="County"><option value="">All counties in scope</option>{counties?.items.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}</select>
      </div>
      {dash.error && <ErrorBox error={dash.error} />}
      {d && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Registered stations" value={fmtNumber(d.registeredStations)} />
          <Stat label="Reported / not reported" value={`${fmtNumber(d.stationsReported)} / ${fmtNumber(d.stationsNotReported)}`} hint={`Coverage ${fmtPct(d.coverage.percent ?? 0)}`} />
          <Stat label="Awaiting verification" value={<Link className="link" to={`/verify?electionId=${eid}`}>{fmtNumber(d.submissionsAwaitingVerification)}</Link>} />
          <Stat label="Verified stations" value={fmtNumber(d.verifiedStations)} />
          <Stat label="Rejected submissions" value={fmtNumber(d.rejectedSubmissions)} />
          <Stat label="Conflicting submissions" value={<Link className="link" to={`/verify?electionId=${eid}&conflict=true`}>{fmtNumber(d.conflictedSubmissions)}</Link>} />
          <Stat label="Active agents (30 min)" value={`${fmtNumber(d.activeAgents)} / ${fmtNumber(d.assignedAgents)}`} hint="With an active session / assigned" />
          <Stat label="Last data update" value={<span className="text-base">{fmtDateTime(d.lastDataUpdate)}</span>} />
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="card h-80 lg:col-span-2">
          <div className="flex items-center justify-between"><h2 className="font-bold">Candidate totals (all accepted, incl. unverified)</h2><StatusBadge status={tally.data?.overallStatus} /></div>
          {tally.data && (
            <ResponsiveContainer width="100%" height="85%">
              <BarChart data={tally.data.candidates.slice(0, 12)}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="fullName" tick={{ fontSize: 11 }} />
                <YAxis />
                <Tooltip />
                <Bar dataKey="verifiedVotes" stackId="a" fill="#0f766e" name="Verified" />
                <Bar dataKey={(c: { votes: number; verifiedVotes: number }) => c.votes - c.verifiedVotes} stackId="a" fill="#eaa363" name="Unverified" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="card">
          <h2 className="font-bold">Live activity</h2>
          {feed.length === 0 ? <p className="text-sm text-gray-500">Waiting for submissions…</p> : <ul className="mt-2 space-y-1 text-xs">{feed.map((f, i) => <li key={i}>{f.at.toLocaleTimeString()} — {f.type.replace('results.', '')} {f.submissionId ? <Link className="link" to={`/verify/submissions/${f.submissionId}`}>open</Link> : null}</li>)}</ul>}
        </div>
      </div>
    </div>
  );
}
