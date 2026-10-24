import { Types } from 'mongoose';
import { notFound } from '../../lib/errors.js';
import {
  Candidate,
  Constituency,
  Election,
  PollingStation,
  POSITION_SCOPE,
  ResultSubmission,
  Session,
  AgentAssignment,
  StationResult,
  Ward,
  type Position,
  type PublicResultStatus
} from '../../models/index.js';
import { computeShares, coverage } from './tally.js';

export const VERIFIED_SET: PublicResultStatus[] = ['VERIFIED', 'MATCHED_OFFICIAL', 'OFFICIAL'];

export const PUBLIC_DISCLAIMER =
  'These are independent monitoring figures compiled from polling-station agents. They are not an official declaration by the IEBC. No winner is declared on this platform.';

export interface GeoFilter {
  countyId?: string;
  constituencyId?: string;
  wardId?: string;
  pollingStationId?: string;
}

const oid = (v: string) => new Types.ObjectId(v);

function geoMatch(g: GeoFilter): Record<string, Types.ObjectId> {
  const m: Record<string, Types.ObjectId> = {};
  if (g.countyId) m.countyId = oid(g.countyId);
  if (g.constituencyId) m.constituencyId = oid(g.constituencyId);
  if (g.wardId) m.wardId = oid(g.wardId);
  if (g.pollingStationId) m.pollingStationId = oid(g.pollingStationId);
  return m;
}

/** Visible statuses for the public, honouring the election's provisional-publication setting. */
export function publicStatuses(publishProvisional: boolean): PublicResultStatus[] {
  return publishProvisional ? ['PROVISIONAL', ...VERIFIED_SET] : [...VERIFIED_SET];
}

/** Resolves ancestors of the narrowest geo filter given (station → ward → constituency → county). */
async function resolveAncestors(electionId: string, g: GeoFilter) {
  const out: { countyId?: string; constituencyId?: string; wardId?: string } = { countyId: g.countyId, constituencyId: g.constituencyId, wardId: g.wardId };
  if (g.pollingStationId) {
    const ps = await PollingStation.findOne({ _id: g.pollingStationId, electionId }).lean();
    if (!ps) throw notFound('Polling station not found');
    return { countyId: String(ps.countyId), constituencyId: String(ps.constituencyId), wardId: String(ps.wardId) };
  }
  if (g.wardId) {
    const w = await Ward.findOne({ _id: g.wardId, electionId }).lean();
    if (!w) throw notFound('Ward not found');
    return { countyId: String(w.countyId), constituencyId: String(w.constituencyId), wardId: g.wardId };
  }
  if (g.constituencyId) {
    const c = await Constituency.findOne({ _id: g.constituencyId, electionId }).lean();
    if (!c) throw notFound('Constituency not found');
    out.countyId = String(c.countyId);
  }
  return out;
}

function overallStatus(statuses: string[], reported: number, registered: number, awaiting: number): string {
  if (reported === 0) return awaiting > 0 ? 'AWAITING_VERIFICATION' : 'NO_RESULTS';
  if (statuses.every((s) => s === 'OFFICIAL') && reported === registered) return 'OFFICIAL';
  if (statuses.every((s) => s === 'MATCHED_OFFICIAL' || s === 'OFFICIAL')) return 'MATCHED_OFFICIAL';
  if (statuses.every((s) => VERIFIED_SET.includes(s as PublicResultStatus))) return 'VERIFIED';
  return 'PROVISIONAL';
}

export interface TallyOptions {
  electionId: string;
  position: Position;
  geo: GeoFilter;
  audience: 'public' | 'admin';
  /** Extra mongo filter from the user's scope (admin audience). */
  scope?: Record<string, unknown>;
}

export async function tally(o: TallyOptions) {
  const election = await Election.findById(o.electionId).lean();
  if (!election || (o.audience === 'public' && election.status === 'DRAFT')) throw notFound('Election not found');
  const geo = geoMatch(o.geo);
  const base = { electionId: oid(o.electionId), position: o.position, ...geo, ...(o.scope ?? {}) };
  const statuses = o.audience === 'public' ? publicStatuses(election.publishProvisional) : (['AWAITING_VERIFICATION', 'PROVISIONAL', ...VERIFIED_SET] as PublicResultStatus[]);
  const match = { ...base, status: { $in: statuses } };

  const [agg, statusRows, registered, awaiting, lastUpdatedDoc] = await Promise.all([
    StationResult.aggregate<{ _id: Types.ObjectId; votes: number; verifiedVotes: number }>([
      { $match: match },
      { $unwind: '$candidateVotes' },
      {
        $group: {
          _id: '$candidateVotes.candidateId',
          votes: { $sum: '$candidateVotes.votes' },
          verifiedVotes: { $sum: { $cond: [{ $in: ['$status', VERIFIED_SET] }, '$candidateVotes.votes', 0] } }
        }
      }
    ]),
    StationResult.aggregate<{ _id: string; n: number }>([{ $match: match }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    PollingStation.countDocuments({ electionId: oid(o.electionId), active: true, ...geo, ...(o.scope ?? {}) }),
    StationResult.countDocuments({ ...base, status: { $nin: statuses } }),
    StationResult.findOne(match).sort({ updatedAt: -1 }).select('updatedAt').lean()
  ]);

  // Candidate list: the full ballot when the view is within one ballot area, otherwise those with votes.
  const anc = await resolveAncestors(o.electionId, o.geo);
  const scopeType = POSITION_SCOPE[o.position];
  const scopeRef =
    scopeType === 'NATIONAL' ? null : scopeType === 'COUNTY' ? anc.countyId : scopeType === 'CONSTITUENCY' ? anc.constituencyId : anc.wardId;
  const ballotDefined = scopeType === 'NATIONAL' || Boolean(scopeRef);
  const voteIds = agg.map((a) => a._id);
  const candidates = await Candidate.find({
    electionId: o.electionId,
    position: o.position,
    $or: [{ _id: { $in: voteIds } }, ...(ballotDefined ? [{ active: true, scopeRefId: scopeRef ? oid(scopeRef) : null }] : [])]
  })
    .select('fullName party partyAbbreviation photoFileId ballotOrder scopeRefId')
    .lean();
  const byId = new Map(agg.map((a) => [String(a._id), a]));
  const { rows, totalVotes, verifiedVotes } = computeShares(
    candidates.map((c) => ({ candidateId: String(c._id), votes: byId.get(String(c._id))?.votes ?? 0, verifiedVotes: byId.get(String(c._id))?.verifiedVotes ?? 0 }))
  );
  const cmeta = new Map(candidates.map((c) => [String(c._id), c]));
  const reported = statusRows.reduce((a, r) => a + r.n, 0);
  const statusCounts = Object.fromEntries(statusRows.map((r) => [r._id, r.n]));

  return {
    election: { id: String(election._id), name: election.name, status: election.status, publishProvisional: election.publishProvisional },
    position: o.position,
    geo: o.geo,
    candidates: rows.map((r) => ({
      ...r,
      fullName: cmeta.get(r.candidateId)?.fullName,
      party: cmeta.get(r.candidateId)?.party,
      partyAbbreviation: cmeta.get(r.candidateId)?.partyAbbreviation,
      photoFileId: cmeta.get(r.candidateId)?.photoFileId ?? null
    })),
    totals: { totalRecordedVotes: totalVotes, verifiedVotes, unverifiedVotes: totalVotes - verifiedVotes },
    coverage: coverage(reported, registered),
    awaitingVerificationStations: awaiting,
    statusCounts,
    overallStatus: overallStatus(Object.keys(statusCounts), reported, registered, awaiting),
    lastUpdated: lastUpdatedDoc?.updatedAt ?? null,
    winnerDeclared: false,
    disclaimer: PUBLIC_DISCLAIMER,
    generatedAt: new Date()
  };
}

/** Per-area coverage breakdown (constituencies of a county, wards of a constituency, stations of a ward). */
export async function breakdown(o: { electionId: string; position: Position; level: 'county' | 'constituency' | 'ward' | 'station'; parentId?: string; audience: 'public' | 'admin'; scope?: Record<string, unknown> }) {
  const election = await Election.findById(o.electionId).lean();
  if (!election || (o.audience === 'public' && election.status === 'DRAFT')) throw notFound('Election not found');
  const statuses = o.audience === 'public' ? publicStatuses(election.publishProvisional) : (['AWAITING_VERIFICATION', 'PROVISIONAL', ...VERIFIED_SET] as PublicResultStatus[]);
  const groupKey = { county: 'countyId', constituency: 'constituencyId', ward: 'wardId', station: 'pollingStationId' }[o.level];
  const parentKey = { county: null, constituency: 'countyId', ward: 'constituencyId', station: 'wardId' }[o.level];
  const parent = parentKey && o.parentId ? { [parentKey]: oid(o.parentId) } : {};
  const stationGroupKey = o.level === 'station' ? '_id' : groupKey;
  const [registered, reported] = await Promise.all([
    PollingStation.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { electionId: oid(o.electionId), active: true, ...parent, ...(o.scope ?? {}) } },
      { $group: { _id: `$${stationGroupKey}`, n: { $sum: 1 } } }
    ]),
    StationResult.aggregate<{ _id: Types.ObjectId; n: number; votes: number; statuses: string[] }>([
      { $match: { electionId: oid(o.electionId), position: o.position, status: { $in: statuses }, ...parent, ...(o.scope ?? {}) } },
      { $group: { _id: `$${groupKey}`, n: { $sum: 1 }, votes: { $sum: { $sum: '$candidateVotes.votes' } }, statuses: { $addToSet: '$status' } } }
    ])
  ]);
  const rep = new Map(reported.map((r) => [String(r._id), r]));
  return registered.map((r) => {
    const x = rep.get(String(r._id));
    return {
      id: String(r._id),
      ...coverage(x?.n ?? 0, r.n),
      totalVotes: x?.votes ?? 0,
      statuses: x?.statuses ?? []
    };
  });
}

/** Admin monitoring dashboard counters for an election within the user's scope. */
export async function adminDashboard(electionId: string, geo: GeoFilter, scope: Record<string, unknown>, position?: Position) {
  const e = oid(electionId);
  const g = geoMatch(geo);
  const subMatch = { electionId: e, ...g, ...scope, ...(position ? { position } : {}) };
  const [registered, stationsReported, verifiedStations, subStatus, conflicts, lastSub, assignedAgents] = await Promise.all([
    PollingStation.countDocuments({ electionId: e, active: true, ...g, ...scope }),
    StationResult.distinct('pollingStationId', { electionId: e, ...g, ...scope, ...(position ? { position } : {}) }),
    StationResult.distinct('pollingStationId', { electionId: e, ...g, ...scope, status: { $in: VERIFIED_SET }, ...(position ? { position } : {}) }),
    ResultSubmission.aggregate<{ _id: string; n: number }>([{ $match: subMatch }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    ResultSubmission.countDocuments({ ...subMatch, hasConflict: true, status: { $ne: 'REJECTED' } }),
    ResultSubmission.findOne(subMatch).sort({ lastServerReceivedAt: -1 }).select('lastServerReceivedAt').lean(),
    AgentAssignment.distinct('userId', { electionId: e, active: true, ...g, ...scope })
  ]);
  const activeAgents = await Session.distinct('userId', { userId: { $in: assignedAgents }, revokedAt: null, lastUsedAt: { $gt: new Date(Date.now() - 30 * 60_000) } });
  const s = Object.fromEntries(subStatus.map((x) => [x._id, x.n])) as Record<string, number>;
  return {
    registeredStations: registered,
    stationsReported: stationsReported.length,
    stationsNotReported: Math.max(0, registered - stationsReported.length),
    coverage: coverage(stationsReported.length, registered),
    submissionsAwaitingVerification: (s.SUBMITTED ?? 0) + (s.UNDER_REVIEW ?? 0),
    verifiedStations: verifiedStations.length,
    rejectedSubmissions: s.REJECTED ?? 0,
    conflictedSubmissions: conflicts,
    submissionsByStatus: s,
    assignedAgents: assignedAgents.length,
    activeAgents: activeAgents.length,
    lastDataUpdate: lastSub?.lastServerReceivedAt ?? null,
    generatedAt: new Date()
  };
}
