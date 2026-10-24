import { Types } from 'mongoose';
import { Candidate, POSITION_SCOPE, type Position } from '../../models/election.js';

export interface StationGeo {
  _id: unknown;
  electionId: unknown;
  countyId: unknown;
  constituencyId: unknown;
  wardId: unknown;
}

/** The geographic reference a candidate for `position` must have to appear at `station`. */
export function scopeRefFor(position: Position, station: StationGeo): Types.ObjectId | null {
  switch (POSITION_SCOPE[position]) {
    case 'NATIONAL':
      return null;
    case 'COUNTY':
      return new Types.ObjectId(String(station.countyId));
    case 'CONSTITUENCY':
      return new Types.ObjectId(String(station.constituencyId));
    case 'WARD':
      return new Types.ObjectId(String(station.wardId));
  }
}

/** Active candidates validly on the ballot for this position at this station, in ballot order. */
export async function eligibleCandidates(station: StationGeo, position: Position) {
  const ref = scopeRefFor(position, station);
  return Candidate.find({
    electionId: station.electionId,
    position,
    active: true,
    scopeType: POSITION_SCOPE[position],
    scopeRefId: ref
  })
    .sort({ ballotOrder: 1, fullName: 1 })
    .lean();
}
