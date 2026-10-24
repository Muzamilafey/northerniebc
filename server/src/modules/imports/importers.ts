import { Types, type ClientSession } from 'mongoose';
import { isValidFinancialYear } from '../../models/common.js';
import {
  AgentAssignment,
  AuditFinding,
  BUDGET_METRICS,
  BudgetFigure,
  Candidate,
  Constituency,
  Contractor,
  County,
  Department,
  DISBURSEMENT_STAGES,
  Donation,
  FINDING_CATEGORIES,
  OfficialStationResult,
  Party,
  PERCENT_METRICS,
  PHYSICAL_PROGRESS_BASIS,
  PollingStation,
  POSITION_SCOPE,
  POSITIONS,
  Project,
  PROJECT_SECTORS,
  PROJECT_STATUSES,
  ProjectUpdate,
  StationResult,
  TreasuryDisbursement,
  User,
  Ward,
  type Position
} from '../../models/index.js';
import { bool, date, num, str } from './parse.js';
import { sameFigures } from '../results/reconciliation.js';
import type { Permission } from '../../lib/permissions.js';

export interface ImportContext {
  jobId: Types.ObjectId;
  electionId?: Types.ObjectId;
  sourceId?: Types.ObjectId;
  actorId: Types.ObjectId;
  counties: Map<string, { _id: Types.ObjectId; name: string }>;
}

export type RowCheck =
  | { status: 'VALID'; naturalKey: string; normalized: Record<string, unknown> }
  | { status: 'INVALID'; messages: string[] }
  | { status: 'SKIPPED'; naturalKey: string; normalized: Record<string, unknown>; messages: string[] }
  | { status: 'CONFLICT'; naturalKey: string; normalized: Record<string, unknown>; messages: string[]; targetId?: Types.ObjectId };

export interface Importer {
  permission: Permission;
  requiresElection?: boolean;
  requiresSource: boolean;
  columns: string[];
  check(row: Record<string, string>, ctx: ImportContext): Promise<RowCheck>;
  /** Applies one VALID (or accepted CONFLICT) row inside the publish transaction. */
  apply(row: { normalized: Record<string, unknown>; status: string; targetId?: Types.ObjectId | null }, ctx: ImportContext, s: ClientSession, correctionReason?: string): Promise<Types.ObjectId | undefined>;
}

const invalid = (...messages: string[]): RowCheck => ({ status: 'INVALID', messages });
const cents = (kes?: number) => (kes == null ? undefined : Math.round(kes * 100));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function county(row: Record<string, string>, ctx: ImportContext) {
  const code = str(row.county_code)?.padStart(3, '0');
  return code ? ctx.counties.get(code) : undefined;
}

async function ensureDepartment(countyId: Types.ObjectId, name: string | undefined, s: ClientSession) {
  if (!name) return undefined;
  const d = await Department.findOneAndUpdate({ countyId, slug: slug(name) }, { $setOnInsert: { countyId, name, slug: slug(name) } }, { upsert: true, new: true, session: s });
  return d!._id;
}

/** Supersedes the current published record with a new one (used for accepted conflicts). */
async function supersede(model: typeof BudgetFigure | typeof TreasuryDisbursement | typeof Project | typeof AuditFinding, targetId: Types.ObjectId, data: Record<string, unknown>, ctx: ImportContext, s: ClientSession, reason: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = model as any;
  const old = await m.findById(targetId).session(s);
  const [doc] = await m.create([{ ...data, revision: (old.revision ?? 1) + 1, supersedesId: old._id, correctionReason: reason, isCurrent: true }], { session: s });
  old.isCurrent = false;
  old.supersededById = doc._id;
  await old.save({ session: s });
  return doc._id as Types.ObjectId;
}

const published = (ctx: ImportContext) => ({
  workflowStatus: 'PUBLISHED',
  verificationStatus: 'OFFICIAL_SOURCE_REPORTED',
  sourceId: ctx.sourceId,
  importJobId: ctx.jobId,
  publishedAt: new Date(),
  publishedBy: ctx.actorId,
  createdBy: ctx.actorId
});

export const IMPORTERS: Record<string, Importer> = {
  POLLING_STATIONS: {
    permission: 'geography.import',
    requiresElection: true,
    requiresSource: true,
    columns: ['county_code', 'constituency_code', 'constituency_name', 'ward_code', 'ward_name', 'station_code', 'station_name', 'registered_voters', 'lat', 'lng'],
    async check(row, ctx) {
      const c = county(row, ctx);
      const errs: string[] = [];
      if (!c) errs.push('Unknown or missing county_code (must be one of the covered counties)');
      for (const k of ['constituency_code', 'constituency_name', 'ward_code', 'ward_name', 'station_code', 'station_name']) if (!str(row[k])) errs.push(`${k} is required`);
      const rv = num(row.registered_voters);
      if (rv !== undefined && (Number.isNaN(rv) || rv < 0 || !Number.isInteger(rv))) errs.push('registered_voters must be a non-negative whole number');
      const lat = num(row.lat);
      const lng = num(row.lng);
      if ((lat !== undefined) !== (lng !== undefined) || Number.isNaN(lat) || Number.isNaN(lng)) errs.push('lat and lng must both be numbers or both be blank');
      if (errs.length) return invalid(...errs);
      const normalized = { countyId: c!._id, constituencyCode: str(row.constituency_code), constituencyName: str(row.constituency_name), wardCode: str(row.ward_code), wardName: str(row.ward_name), code: str(row.station_code), name: str(row.station_name), registeredVoters: rv, lat, lng };
      const naturalKey = `station:${normalized.code}`;
      const existing = await PollingStation.findOne({ electionId: ctx.electionId, code: normalized.code }).lean();
      if (existing) {
        const same = existing.name === normalized.name && (existing.registeredVoters ?? undefined) === rv;
        return same
          ? { status: 'SKIPPED', naturalKey, normalized, messages: ['Already present with identical data'] }
          : { status: 'CONFLICT', naturalKey, normalized, messages: ['A station with this code exists with different data; the register is not overwritten'], targetId: existing._id };
      }
      return { status: 'VALID', naturalKey, normalized };
    },
    async apply({ normalized: n }, ctx, s) {
      const e = ctx.electionId!;
      const cons = await Constituency.findOneAndUpdate({ electionId: e, code: n.constituencyCode }, { $setOnInsert: { electionId: e, countyId: n.countyId, code: n.constituencyCode, name: n.constituencyName, sourceId: ctx.sourceId } }, { upsert: true, new: true, session: s });
      if (String(cons!.countyId) !== String(n.countyId)) throw new Error(`Constituency ${String(n.constituencyCode)} belongs to a different county`);
      const ward = await Ward.findOneAndUpdate({ electionId: e, code: n.wardCode }, { $setOnInsert: { electionId: e, countyId: n.countyId, constituencyId: cons!._id, code: n.wardCode, name: n.wardName, sourceId: ctx.sourceId } }, { upsert: true, new: true, session: s });
      if (String(ward!.constituencyId) !== String(cons!._id)) throw new Error(`Ward ${String(n.wardCode)} belongs to a different constituency`);
      const [st] = await PollingStation.create(
        [{ electionId: e, countyId: n.countyId, constituencyId: cons!._id, wardId: ward!._id, code: n.code, name: n.name, registeredVoters: n.registeredVoters, location: n.lat != null ? { lat: n.lat, lng: n.lng, verified: true } : undefined, sourceId: ctx.sourceId }],
        { session: s }
      );
      return st!._id;
    }
  },

  CANDIDATES: {
    permission: 'candidates.manage',
    requiresElection: true,
    requiresSource: true,
    columns: ['position', 'full_name', 'party', 'party_abbreviation', 'independent', 'scope_code', 'ballot_order', 'source_reference'],
    async check(row, ctx) {
      const position = str(row.position)?.toUpperCase() as Position | undefined;
      if (!position || !POSITIONS.includes(position)) return invalid(`position must be one of ${POSITIONS.join(', ')}`);
      const fullName = str(row.full_name);
      if (!fullName) return invalid('full_name is required');
      const scopeType = POSITION_SCOPE[position];
      const code = str(row.scope_code);
      let scopeRefId: Types.ObjectId | null = null;
      if (scopeType === 'NATIONAL') {
        if (code) return invalid('Presidential candidates must not have a scope_code');
      } else {
        if (!code) return invalid(`scope_code (${scopeType.toLowerCase()} code) is required`);
        if (scopeType === 'COUNTY') scopeRefId = ctx.counties.get(code.padStart(3, '0'))?._id ?? null;
        else if (scopeType === 'CONSTITUENCY') scopeRefId = (await Constituency.findOne({ electionId: ctx.electionId, code }).lean())?._id ?? null;
        else scopeRefId = (await Ward.findOne({ electionId: ctx.electionId, code }).lean())?._id ?? null;
        if (!scopeRefId) return invalid(`Unknown ${scopeType.toLowerCase()} code ${code} (import the polling-station register first)`);
      }
      const ballotOrder = num(row.ballot_order);
      if (Number.isNaN(ballotOrder)) return invalid('ballot_order must be a number');
      // Link to a registered party (by abbreviation) so its logo shows; otherwise keep the ballot name only.
      const abbr = str(row.party_abbreviation)?.toUpperCase();
      const partyDoc = abbr ? await Party.findOne({ abbreviation: abbr }).lean() : null;
      const normalized = { position, fullName, party: partyDoc?.name ?? str(row.party), partyAbbreviation: abbr, partyId: partyDoc?._id, independent: bool(row.independent), scopeType, scopeRefId, ballotOrder, sourceReference: str(row.source_reference) };
      const naturalKey = `cand:${position}:${String(scopeRefId)}:${fullName.toLowerCase()}`;
      const existing = await Candidate.findOne({ electionId: ctx.electionId, position, scopeRefId, fullName }).lean();
      if (existing) {
        return existing.party === normalized.party
          ? { status: 'SKIPPED', naturalKey, normalized, messages: ['Candidate already registered'] }
          : { status: 'CONFLICT', naturalKey, normalized, messages: ['Candidate exists with a different party'], targetId: existing._id };
      }
      return { status: 'VALID', naturalKey, normalized };
    },
    async apply({ normalized }, ctx, s) {
      const [c] = await Candidate.create([{ ...normalized, electionId: ctx.electionId, sourceId: ctx.sourceId }], { session: s });
      return c!._id;
    }
  },

  AGENT_ASSIGNMENTS: {
    permission: 'agents.manage',
    requiresElection: true,
    requiresSource: false,
    columns: ['agent_code', 'station_code'],
    async check(row, ctx) {
      const agent = await User.findOne({ agentCode: str(row.agent_code)?.toUpperCase(), role: 'AGENT', status: 'ACTIVE' }).lean();
      if (!agent) return invalid('Unknown or inactive agent_code');
      const st = await PollingStation.findOne({ electionId: ctx.electionId, code: str(row.station_code) }).lean();
      if (!st) return invalid('Unknown station_code for this election');
      const normalized = { userId: agent._id, pollingStationId: st._id, countyId: st.countyId, constituencyId: st.constituencyId, wardId: st.wardId };
      const naturalKey = `assign:${String(agent._id)}:${String(st._id)}`;
      if (await AgentAssignment.exists({ userId: agent._id, electionId: ctx.electionId, pollingStationId: st._id, active: true })) return { status: 'SKIPPED', naturalKey, normalized, messages: ['Already assigned'] };
      return { status: 'VALID', naturalKey, normalized };
    },
    async apply({ normalized }, ctx, s) {
      const [a] = await AgentAssignment.create([{ ...normalized, electionId: ctx.electionId, assignedBy: ctx.actorId }], { session: s });
      return a!._id;
    }
  },

  BUDGET_FIGURES: {
    permission: 'finance.import',
    requiresSource: true,
    columns: ['county_code', 'financial_year', 'department', 'metric', 'value', 'period_label', 'period_start', 'period_end', 'publication_date', 'funding_source', 'constituency', 'ward', 'project_reference', 'source_page'],
    async check(row, ctx) {
      const c = county(row, ctx);
      const errs: string[] = [];
      if (!c) errs.push('Unknown county_code');
      const fy = str(row.financial_year);
      if (!fy || !isValidFinancialYear(fy)) errs.push('financial_year must look like 2023/24');
      const metric = str(row.metric)?.toUpperCase();
      if (!metric || !BUDGET_METRICS.includes(metric as never)) errs.push(`metric must be one of ${BUDGET_METRICS.join(', ')}`);
      const value = num(row.value);
      if (value === undefined || Number.isNaN(value)) errs.push('value is required and must be numeric (blank values are not imported as zero)');
      const periodEnd = date(row.period_end);
      if (!periodEnd) errs.push('period_end is required (YYYY-MM-DD)');
      if (!str(row.period_label)) errs.push('period_label is required, e.g. "FY 2023/24 Q4" or "Approved estimates"');
      if (date(row.period_start) === null || date(row.publication_date) === null) errs.push('Invalid date');
      if (errs.length) return invalid(...errs);
      let projectId: Types.ObjectId | undefined;
      if (str(row.project_reference)) {
        const p = await Project.findOne({ reference: str(row.project_reference), isCurrent: true }).lean();
        if (!p) return invalid('Unknown project_reference');
        projectId = p._id;
      }
      const deptName = str(row.department);
      const dept = deptName ? await Department.findOne({ countyId: c!._id, slug: slug(deptName) }).lean() : null;
      const isPct = PERCENT_METRICS.includes(metric as never);
      const normalized = {
        countyId: c!._id,
        financialYear: fy,
        departmentName: deptName,
        metric,
        value: Math.round(value! * 100),
        unit: isPct ? 'BASIS_POINTS' : 'KES_CENTS',
        periodLabel: str(row.period_label),
        periodStart: date(row.period_start) ?? undefined,
        periodEnd,
        publicationDate: date(row.publication_date) ?? undefined,
        fundingSource: str(row.funding_source),
        constituencyName: str(row.constituency),
        wardName: str(row.ward),
        projectId,
        sourcePage: str(row.source_page)
      };
      const naturalKey = ['bf', String(c!._id), fy, deptName?.toLowerCase() ?? '', metric, periodEnd!.toISOString().slice(0, 10), normalized.fundingSource ?? '', String(projectId ?? ''), normalized.constituencyName ?? '', normalized.wardName ?? ''].join('|');
      const existing = await BudgetFigure.findOne({
        countyId: c!._id,
        financialYear: fy,
        departmentId: dept?._id ?? null,
        metric,
        periodEnd,
        fundingSource: normalized.fundingSource ?? null,
        projectId: projectId ?? null,
        constituencyName: normalized.constituencyName ?? null,
        wardName: normalized.wardName ?? null,
        isCurrent: true,
        workflowStatus: 'PUBLISHED'
      }).lean();
      if (existing) {
        if (existing.value === normalized.value) return { status: 'SKIPPED', naturalKey, normalized, messages: ['Identical figure already published'] };
        return { status: 'CONFLICT', naturalKey, normalized, messages: [`Published figure differs (${existing.value / 100} vs ${normalized.value / 100}); publish only as a documented correction`], targetId: existing._id };
      }
      return { status: 'VALID', naturalKey, normalized };
    },
    async apply({ normalized: n, status, targetId }, ctx, s, reason) {
      const { departmentName, ...rest } = n as Record<string, unknown> & { departmentName?: string };
      const departmentId = await ensureDepartment(n.countyId as Types.ObjectId, departmentName, s);
      const data = { ...rest, departmentId, ...published(ctx) };
      if (status === 'CONFLICT') return supersede(BudgetFigure, targetId!, data, ctx, s, reason!);
      const [d] = await BudgetFigure.create([data], { session: s });
      return d!._id;
    }
  },

  TREASURY_DISBURSEMENTS: {
    permission: 'finance.import',
    requiresSource: true,
    columns: ['county_code', 'financial_year', 'stage', 'funding_stream', 'amount_kes', 'as_of_date', 'schedule_label', 'official_explanation', 'publication_date', 'source_page'],
    async check(row, ctx) {
      const c = county(row, ctx);
      const errs: string[] = [];
      if (!c) errs.push('Unknown county_code');
      const fy = str(row.financial_year);
      if (!fy || !isValidFinancialYear(fy)) errs.push('financial_year must look like 2023/24');
      const stage = str(row.stage)?.toUpperCase();
      if (!stage || !DISBURSEMENT_STAGES.includes(stage as never)) errs.push(`stage must be one of ${DISBURSEMENT_STAGES.join(', ')}`);
      const amt = num(row.amount_kes);
      if (amt === undefined || Number.isNaN(amt) || amt < 0) errs.push('amount_kes is required and must be a non-negative number');
      const asOf = date(row.as_of_date);
      if (!asOf) errs.push('as_of_date is required');
      if (errs.length) return invalid(...errs);
      const normalized = { countyId: c!._id, financialYear: fy, stage, fundingStream: str(row.funding_stream) ?? 'EQUITABLE_SHARE', amountCents: cents(amt), asOfDate: asOf, scheduleLabel: str(row.schedule_label), officialExplanation: str(row.official_explanation), publicationDate: date(row.publication_date) ?? undefined, sourcePage: str(row.source_page) };
      const naturalKey = ['td', String(c!._id), fy, stage, normalized.fundingStream, asOf!.toISOString().slice(0, 10)].join('|');
      const existing = await TreasuryDisbursement.findOne({ countyId: c!._id, financialYear: fy, stage, fundingStream: normalized.fundingStream, asOfDate: asOf, isCurrent: true, workflowStatus: 'PUBLISHED' }).lean();
      if (existing) {
        if (existing.amountCents === normalized.amountCents) return { status: 'SKIPPED', naturalKey, normalized, messages: ['Identical record already published'] };
        return { status: 'CONFLICT', naturalKey, normalized, messages: ['Published amount differs; publish only as a documented correction'], targetId: existing._id };
      }
      return { status: 'VALID', naturalKey, normalized };
    },
    async apply({ normalized, status, targetId }, ctx, s, reason) {
      const data = { ...normalized, ...published(ctx) };
      if (status === 'CONFLICT') return supersede(TreasuryDisbursement, targetId!, data, ctx, s, reason!);
      const [d] = await TreasuryDisbursement.create([data], { session: s });
      return d!._id;
    }
  },

  PROJECTS: {
    permission: 'projects.manage',
    requiresSource: true,
    columns: ['reference', 'name', 'county_code', 'constituency', 'ward', 'sector', 'department', 'funding_source', 'financial_year', 'approved_budget_kes', 'revised_budget_kes', 'amount_paid_kes', 'amount_paid_as_of', 'contractor', 'procurement_reference', 'start_date', 'planned_completion_date', 'status', 'lat', 'lng', 'location_verified', 'physical_progress_percent', 'physical_progress_basis', 'physical_progress_date', 'description'],
    async check(row, ctx) {
      const c = county(row, ctx);
      const errs: string[] = [];
      if (!c) errs.push('Unknown county_code');
      const reference = str(row.reference);
      if (!reference) errs.push('reference is required');
      if (!str(row.name)) errs.push('name is required');
      const status = (str(row.status)?.toUpperCase() ?? 'UNVERIFIED') as (typeof PROJECT_STATUSES)[number];
      if (!PROJECT_STATUSES.includes(status)) errs.push(`status must be one of ${PROJECT_STATUSES.join(', ')}`);
      const sector = (str(row.sector)?.toUpperCase() ?? 'OTHER') as (typeof PROJECT_SECTORS)[number];
      if (!PROJECT_SECTORS.includes(sector)) errs.push(`sector must be one of ${PROJECT_SECTORS.join(', ')}`);
      const nums = ['approved_budget_kes', 'revised_budget_kes', 'amount_paid_kes', 'lat', 'lng', 'physical_progress_percent'].map((k) => [k, num(row[k])] as const);
      for (const [k, v] of nums) if (Number.isNaN(v)) errs.push(`${k} must be numeric`);
      const pp = num(row.physical_progress_percent);
      const basis = str(row.physical_progress_basis)?.toUpperCase();
      const ppDate = date(row.physical_progress_date);
      if (pp !== undefined && (!basis || !PHYSICAL_PROGRESS_BASIS.includes(basis as never) || !ppDate)) errs.push('physical progress needs physical_progress_basis (INSPECTION/OFFICIAL_REPORT/OBSERVATION) and physical_progress_date');
      if (pp !== undefined && (pp < 0 || pp > 100)) errs.push('physical_progress_percent must be 0–100');
      const fy = str(row.financial_year);
      if (fy && !isValidFinancialYear(fy)) errs.push('financial_year must look like 2023/24');
      if (errs.length) return invalid(...errs);
      const lat = num(row.lat);
      const lng = num(row.lng);
      const normalized = {
        reference,
        name: str(row.name),
        description: str(row.description),
        countyId: c!._id,
        constituencyName: str(row.constituency),
        wardName: str(row.ward),
        sector,
        departmentName: str(row.department),
        fundingSource: str(row.funding_source),
        financialYear: fy,
        approvedBudgetCents: cents(num(row.approved_budget_kes)),
        revisedBudgetCents: cents(num(row.revised_budget_kes)),
        amountPaidCents: cents(num(row.amount_paid_kes)),
        amountPaidAsOf: date(row.amount_paid_as_of) ?? undefined,
        contractorName: str(row.contractor),
        procurementReference: str(row.procurement_reference),
        startDate: date(row.start_date) ?? undefined,
        plannedCompletionDate: date(row.planned_completion_date) ?? undefined,
        status,
        location: lat != null && lng != null ? { lat, lng, verified: bool(row.location_verified) } : undefined,
        physicalProgress: pp !== undefined ? { percent: pp, basis, assessedAt: ppDate, sourceId: ctx.sourceId } : undefined,
        lastInspectionDate: basis === 'INSPECTION' ? ppDate : undefined
      };
      const naturalKey = `proj:${reference}`;
      const existing = await Project.findOne({ reference, isCurrent: true, workflowStatus: 'PUBLISHED' }).lean();
      if (existing) {
        const same = existing.status === status && existing.amountPaidCents === normalized.amountPaidCents && existing.physicalProgress?.percent === normalized.physicalProgress?.percent;
        return same ? { status: 'SKIPPED', naturalKey, normalized, messages: ['No change from published record'] } : { status: 'CONFLICT', naturalKey, normalized, messages: ['Differs from the published record; publish as a documented update'], targetId: existing._id };
      }
      return { status: 'VALID', naturalKey, normalized };
    },
    async apply({ normalized: n, status, targetId }, ctx, s, reason) {
      const { departmentName, contractorName, ...rest } = n as Record<string, unknown> & { departmentName?: string; contractorName?: string };
      const departmentId = await ensureDepartment(n.countyId as Types.ObjectId, departmentName, s);
      let contractorId;
      if (contractorName) contractorId = (await Contractor.findOneAndUpdate({ name: contractorName }, { $setOnInsert: { name: contractorName } }, { upsert: true, new: true, session: s, collation: { locale: 'en', strength: 2 } }))!._id;
      const data = { ...rest, departmentId, contractorId, ...published(ctx) };
      const id = status === 'CONFLICT' ? await supersede(Project, targetId!, data, ctx, s, reason!) : (await Project.create([data], { session: s }))[0]!._id;
      await ProjectUpdate.create([{ projectReference: n.reference, projectId: id, kind: status === 'CONFLICT' ? 'CORRECTION' : 'PUBLISHED', summary: status === 'CONFLICT' ? reason : 'Imported from source document', after: { status: n.status, amountPaidCents: n.amountPaidCents, physicalProgress: n.physicalProgress }, sourceId: ctx.sourceId, actorId: ctx.actorId }], { session: s });
      return id;
    }
  },

  AUDIT_FINDINGS: {
    permission: 'finance.import',
    requiresSource: true,
    columns: ['finding_key', 'county_code', 'financial_year', 'entity', 'department', 'category', 'amount_questioned_kes', 'description', 'report_title', 'page_number', 'report_publication_date', 'management_response', 'auditor_recommendation', 'recovery_or_investigation_status', 'latest_known_status', 'source_url'],
    async check(row, ctx) {
      const c = county(row, ctx);
      const errs: string[] = [];
      if (!c) errs.push('Unknown county_code');
      const key = str(row.finding_key);
      if (!key) errs.push('finding_key is required');
      const fy = str(row.financial_year);
      if (!fy || !isValidFinancialYear(fy)) errs.push('financial_year must look like 2023/24');
      const category = str(row.category)?.toUpperCase();
      if (!category || !FINDING_CATEGORIES.includes(category as never)) errs.push(`category must be one of ${FINDING_CATEGORIES.join(', ')}`);
      if ((category === 'CONFIRMED_LOSS' || category === 'ALLEGATION_UNDER_INVESTIGATION') && !str(row.recovery_or_investigation_status)) errs.push('This category requires recovery_or_investigation_status wording from the competent authority');
      for (const k of ['entity', 'description', 'report_title']) if (!str(row[k])) errs.push(`${k} is required`);
      const amt = num(row.amount_questioned_kes);
      if (Number.isNaN(amt) || (amt !== undefined && amt < 0)) errs.push('amount_questioned_kes must be a non-negative number or blank');
      if (errs.length) return invalid(...errs);
      const normalized = {
        findingKey: key,
        countyId: c!._id,
        financialYear: fy,
        entity: str(row.entity),
        departmentName: str(row.department),
        category,
        amountQuestionedCents: cents(amt),
        description: str(row.description),
        reportTitle: str(row.report_title),
        pageNumber: str(row.page_number),
        reportPublicationDate: date(row.report_publication_date) ?? undefined,
        managementResponse: str(row.management_response),
        auditorRecommendation: str(row.auditor_recommendation),
        recoveryOrInvestigationStatus: str(row.recovery_or_investigation_status),
        latestKnownStatus: str(row.latest_known_status) ?? 'As reported',
        sourceUrl: str(row.source_url)
      };
      const naturalKey = `af:${key}`;
      const existing = await AuditFinding.findOne({ findingKey: key, isCurrent: true, workflowStatus: 'PUBLISHED' }).lean();
      if (existing) {
        const same = existing.description === normalized.description && existing.latestKnownStatus === normalized.latestKnownStatus && existing.amountQuestionedCents === normalized.amountQuestionedCents;
        return same ? { status: 'SKIPPED', naturalKey, normalized, messages: ['Identical finding already published'] } : { status: 'CONFLICT', naturalKey, normalized, messages: ['Differs from the published finding; publish as a documented status update'], targetId: existing._id };
      }
      return { status: 'VALID', naturalKey, normalized };
    },
    async apply({ normalized: n, status, targetId }, ctx, s, reason) {
      const { departmentName, ...rest } = n as Record<string, unknown> & { departmentName?: string };
      const departmentId = await ensureDepartment(n.countyId as Types.ObjectId, departmentName, s);
      const data = { ...rest, departmentId, latestStatusDate: new Date(), ...published(ctx) };
      if (status === 'CONFLICT') return supersede(AuditFinding, targetId!, data, ctx, s, reason!);
      const [d] = await AuditFinding.create([data], { session: s });
      return d!._id;
    }
  },

  OFFICIAL_RESULTS: {
    permission: 'results.official',
    requiresElection: true,
    requiresSource: true,
    columns: ['station_code', 'position', 'candidate_full_name', 'votes', 'final_declared'],
    async check(row, ctx) {
      const st = await PollingStation.findOne({ electionId: ctx.electionId, code: str(row.station_code) }).lean();
      if (!st) return invalid('Unknown station_code');
      const position = str(row.position)?.toUpperCase() as Position;
      if (!POSITIONS.includes(position)) return invalid('Unknown position');
      const cand = await Candidate.findOne({ electionId: ctx.electionId, position, fullName: str(row.candidate_full_name) }).lean();
      if (!cand) return invalid('Unknown candidate for this election and position');
      const votes = num(row.votes);
      if (votes === undefined || Number.isNaN(votes) || votes < 0 || !Number.isInteger(votes)) return invalid('votes must be a non-negative whole number');
      const normalized = { pollingStationId: st._id, position, candidateId: cand._id, votes, finalDeclared: bool(row.final_declared) };
      return { status: 'VALID', naturalKey: `off:${String(st._id)}:${position}:${String(cand._id)}`, normalized };
    },
    async apply({ normalized: n }, ctx, s) {
      const filter = { electionId: ctx.electionId, pollingStationId: n.pollingStationId, position: n.position };
      const doc = await OfficialStationResult.findOneAndUpdate(filter, { $setOnInsert: { ...filter, candidateVotes: [], sourceId: ctx.sourceId, importJobId: ctx.jobId } }, { upsert: true, new: true, session: s });
      doc!.candidateVotes = doc!.candidateVotes.filter((c) => String(c.candidateId) !== String(n.candidateId)) as never;
      doc!.candidateVotes.push({ candidateId: n.candidateId, votes: n.votes } as never);
      doc!.isFinalDeclared = Boolean(n.finalDeclared);
      doc!.sourceId = ctx.sourceId as never;
      await doc!.save({ session: s });
      return doc!._id;
    }
  },

  PAYMENT_RECONCILIATION: {
    permission: 'donations.reconcile',
    requiresSource: false,
    columns: ['provider_receipt', 'amount', 'currency', 'date', 'reference'],
    async check(row) {
      const receipt = str(row.provider_receipt);
      const amount = num(row.amount);
      if (!receipt || amount === undefined || Number.isNaN(amount)) return invalid('provider_receipt and amount are required');
      const currency = str(row.currency)?.toUpperCase() ?? 'KES';
      const d = await Donation.findOne({ providerReceipt: receipt }).lean();
      const normalized = { providerReceipt: receipt, amountCents: Math.round(amount * 100), currency, reference: str(row.reference) };
      const naturalKey = `rec:${receipt}`;
      if (!d) return { status: 'CONFLICT', naturalKey, normalized, messages: ['Provider transaction has no matching confirmed donation — investigate (possible missed callback)'] };
      if (d.amountCents !== normalized.amountCents || d.currency !== currency) return { status: 'CONFLICT', naturalKey, normalized, messages: [`Amount mismatch: platform ${d.currency} ${d.amountCents / 100}`], targetId: d._id };
      return { status: 'SKIPPED', naturalKey, normalized, messages: [`Matches donation ${d.reference}`] };
    },
    async apply() {
      // Reconciliation imports are reports only; status changes go through manual reconciliation approvals.
      return undefined;
    }
  }
};

/** After publishing official results, compare them with accepted monitoring results. */
export async function matchOfficialResults(electionId: Types.ObjectId, s: ClientSession) {
  const officials = await OfficialStationResult.find({ electionId }).session(s);
  let matched = 0;
  let mismatched = 0;
  for (const o of officials) {
    const sr = await StationResult.findOne({ electionId, pollingStationId: o.pollingStationId, position: o.position }).session(s);
    if (!sr) continue;
    const matches = sameFigures({ candidateVotes: sr.candidateVotes }, { candidateVotes: o.candidateVotes });
    const differences = matches
      ? []
      : o.candidateVotes.map((c) => ({ candidateId: c.candidateId, official: c.votes, monitored: sr.candidateVotes.find((x) => String(x.candidateId) === String(c.candidateId))?.votes ?? null })).filter((d) => d.official !== d.monitored);
    sr.set('officialMatch', { checkedAt: new Date(), matches, sourceId: o.sourceId, differences });
    if (matches && ['VERIFIED', 'MATCHED_OFFICIAL', 'OFFICIAL'].includes(sr.status)) sr.status = o.isFinalDeclared ? 'OFFICIAL' : 'MATCHED_OFFICIAL';
    if (!matches) sr.hasConflict = true;
    await sr.save({ session: s });
    if (matches) matched++;
    else mismatched++;
  }
  return { matched, mismatched };
}

export async function loadCounties() {
  const all = await County.find().lean();
  return new Map(all.map((c) => [c.code, { _id: c._id, name: c.name }]));
}
