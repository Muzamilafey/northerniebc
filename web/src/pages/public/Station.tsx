import { useParams } from 'react-router-dom';
import { ErrorBox, Loading, PageHeader, StatusBadge } from '../../components/ui';
import { fmtDateTime, fmtNumber, POSITION_LABELS } from '../../lib/format';
import { useApi } from '../../lib/useApi';

interface StationData {
  station: { code: string; name: string; registeredVoters?: number };
  results: { position: string; status: string; updatedAt?: string; officialMatch?: { matches: boolean } | null; candidates?: { candidateId: string; fullName: string; partyAbbreviation?: string; votes: number }[] }[];
  disclaimer: string;
}

export default function Station() {
  const { stationId } = useParams();
  const { data, error, loading } = useApi<StationData>(`/public/results/stations/${stationId}`);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  return (
    <div>
      <PageHeader title={`${data.station.code} — ${data.station.name}`} subtitle={`Registered voters (station register): ${fmtNumber(data.station.registeredVoters)}`} />
      <div className="grid gap-4 md:grid-cols-2">
        {data.results.map((r) => (
          <section key={r.position} className="card">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-bold">{POSITION_LABELS[r.position]}</h2>
              <StatusBadge status={r.status} />
            </div>
            {r.candidates ? (
              <table className="table mt-2">
                <tbody>
                  {r.candidates.map((c) => (
                    <tr key={c.candidateId}><td>{c.fullName} <span className="text-gray-500">{c.partyAbbreviation}</span></td><td className="text-right tabular-nums">{fmtNumber(c.votes)}</td></tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="mt-2 text-sm text-gray-600">{r.status === 'NO_RESULTS' ? 'No results received.' : 'Awaiting verification before publication.'}</p>
            )}
            {r.officialMatch && <p className="mt-2 text-xs">{r.officialMatch.matches ? 'Matches the official record.' : 'Differs from the official record — under review.'}</p>}
            {r.updatedAt && <p className="mt-1 text-xs text-gray-500">Updated {fmtDateTime(r.updatedAt)}</p>}
          </section>
        ))}
      </div>
      <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{data.disclaimer}</p>
    </div>
  );
}
