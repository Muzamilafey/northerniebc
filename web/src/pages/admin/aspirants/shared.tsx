import { NavLink } from 'react-router-dom';
import { useApi } from '../../../lib/useApi';

export interface Party { _id: string; name: string; abbreviation: string; logoFileId?: string; active: boolean }
export interface Candidate {
  _id: string;
  fullName: string;
  position: string;
  party?: string;
  partyAbbreviation?: string;
  independent: boolean;
  partyId?: { _id: string; name?: string; abbreviation?: string; logoFileId?: string } | null;
  photoFileId?: string;
  scopeType: string;
  scopeRefId?: string;
  areaName?: string | null;
  ballotOrder?: number;
  sourceReference?: string;
  active: boolean;
}
export interface Area { _id: string; name: string; code?: string }
export interface ElectionLite { _id: string; name: string; status: string; positions: { position: string; enabled: boolean }[] }

export type Scope = 'NATIONAL' | 'COUNTY' | 'CONSTITUENCY' | 'WARD';
export const SCOPE_OF: Record<string, Scope> = { PRESIDENT: 'NATIONAL', GOVERNOR: 'COUNTY', SENATOR: 'COUNTY', WOMAN_REP: 'COUNTY', MP: 'CONSTITUENCY', MCA: 'WARD' };
export const SCOPE_HELP: Record<Scope, string> = {
  NATIONAL: 'Contested nationally — no area to choose.',
  COUNTY: 'Contested per county.',
  CONSTITUENCY: 'Contested per constituency.',
  WARD: 'Contested per county assembly ward.'
};

/** County → constituency → ward lists for one election. */
export function useAreas(electionId: string, countyId: string, constituencyId: string) {
  const counties = useApi<{ items: Area[] }>('/public/counties');
  const constituencies = useApi<{ items: Area[] }>(electionId && countyId ? `/public/elections/${electionId}/constituencies` : null, { countyId });
  const wards = useApi<{ items: Area[] }>(electionId && constituencyId ? `/public/elections/${electionId}/wards` : null, { constituencyId });
  return { counties, constituencies, wards };
}

const tab = ({ isActive }: { isActive: boolean }) =>
  `-mb-px border-b-2 px-1 pb-3 text-sm font-semibold transition ${isActive ? 'border-brand-600 text-navy-900' : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-800'}`;

export function CatalogTabs() {
  return (
    <nav aria-label="Aspirants and parties" className="mb-6 flex gap-6 border-b border-gray-200">
      <NavLink to="/admin/aspirants" end className={tab}>Aspirants</NavLink>
      <NavLink to="/admin/aspirants/new" className={tab}>Add aspirant</NavLink>
      <NavLink to="/admin/parties" className={tab}>Parties</NavLink>
    </nav>
  );
}

export function PlusIcon() {
  return <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true"><path d="M10 4a1 1 0 0 1 1 1v4h4a1 1 0 1 1 0 2h-4v4a1 1 0 1 1-2 0v-4H5a1 1 0 1 1 0-2h4V5a1 1 0 0 1 1-1Z" /></svg>;
}
