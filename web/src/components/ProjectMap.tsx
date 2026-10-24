import 'leaflet/dist/leaflet.css';
import { CircleMarker, MapContainer, Popup, TileLayer } from 'react-leaflet';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/useApi';
import { Empty, Loading } from './ui';

const COLORS: Record<string, string> = { PLANNED: '#6b7280', ONGOING: '#1d4ed8', COMPLETED: '#15803d', DELAYED: '#b45309', SUSPENDED: '#b91c1c', UNVERIFIED: '#6b7280' };

export default function ProjectMap(props: { countyId?: string; status?: string; sector?: string }) {
  const { data, loading } = useApi<{ items: { reference: string; name: string; status: string; lat: number; lng: number }[] }>('/public/projects/map', props);
  if (loading) return <Loading />;
  if (!data?.items.length) return <Empty title="No projects with verified GPS coordinates">Only verified locations are mapped.</Empty>;
  return (
    <div className="h-[32rem] overflow-hidden rounded-xl border">
      <MapContainer center={[1.8, 39.5]} zoom={6} className="h-full w-full" scrollWheelZoom={false}>
        <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {data.items.map((p) => (
          <CircleMarker key={p.reference} center={[p.lat, p.lng]} radius={7} pathOptions={{ color: COLORS[p.status] ?? '#111', fillOpacity: 0.8 }}>
            <Popup><Link to={`/projects/${encodeURIComponent(p.reference)}`}>{p.name}</Link><br />{p.status}</Popup>
          </CircleMarker>
        ))}
      </MapContainer>
    </div>
  );
}
