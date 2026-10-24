import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { recordAuditStandalone } from '../../lib/audit.js';
import { forbidden } from '../../lib/errors.js';
import { parse } from '../../lib/http.js';
import { can, scopeFilter, type Permission } from '../../lib/permissions.js';
import { optionalAuth, mfaSatisfied } from '../../middleware/auth.js';
import { limiter } from '../../middleware/security.js';
import {
  AuditEvent,
  AuditFinding,
  BudgetFigure,
  CitizenReport,
  County,
  DataSource,
  Donation,
  POSITIONS,
  Project,
  publicFilter,
  ResultSubmission,
  SubmissionRevision,
  TreasuryDisbursement,
  VerificationDecision
} from '../../models/index.js';
import { objectId } from '../users/routes.js';
import { breakdown, tally } from '../results/query.js';
import { donationTotals } from '../donations/routes.js';
import { toCsv, toPdf, toXlsx, type Table } from './render.js';
import { progressOf } from '../projects/routes.js';

const kes = (c?: number | null) => (c == null ? null : c / 100);
const d = (v?: Date | null) => (v ? new Date(v).toISOString().slice(0, 10) : null);

async function sourceSummary(ids: unknown[]) {
  const uniq = [...new Set(ids.filter(Boolean).map(String))];
  if (!uniq.length) return 'None recorded';
  const srcs = await DataSource.find({ _id: { $in: uniq.slice(0, 50) } }).select('name documentTitle url').lean();
  return srcs.map((s) => `${s.name}${s.documentTitle ? ` — ${s.documentTitle}` : ''}${s.url ? ` (${s.url})` : ''}`).join('; ');
}

type Builder = { permission?: Permission; build(q: Record<string, string>, req: Request): Promise<Table> };

const counties = async () => new Map((await County.find().lean()).map((c) => [String(c._id), c.name]));

const BUILDERS: Record<string, Builder> = {
  results: {
    async build(q) {
      const p = parse(z.object({ electionId: objectId, position: z.enum(POSITIONS), countyId: objectId.optional(), constituencyId: objectId.optional(), wardId: objectId.optional(), pollingStationId: objectId.optional() }).passthrough(), q);
      const t = await tally({ electionId: p.electionId, position: p.position, geo: p, audience: 'public' });
      return {
        title: `Candidate vote totals — ${t.election.name} — ${p.position}`,
        meta: {
          'Generated at': new Date().toISOString(),
          'Reporting period': `Election: ${t.election.name}`,
          Status: `${t.overallStatus} (monitoring figures, not an official declaration)`,
          Completeness: `${t.coverage.reported} of ${t.coverage.registered} polling stations (${t.coverage.percent ?? 0}%)`,
          Sources: 'Polling-station agent submissions verified through the platform workflow',
          Disclaimer: t.disclaimer
        },
        columns: ['Rank', 'Candidate', 'Party', 'Votes', 'Vote share %', 'Verified votes'],
        rows: t.candidates.map((c) => [c.rank, c.fullName ?? '', c.partyAbbreviation ?? c.party ?? '', c.votes, c.share, c.verifiedVotes])
      };
    }
  },
  coverage: {
    async build(q) {
      const p = parse(z.object({ electionId: objectId, position: z.enum(POSITIONS), level: z.enum(['county', 'constituency', 'ward', 'station']), parentId: objectId.optional() }).passthrough(), q);
      const rows = await breakdown({ ...p, audience: 'public' });
      return {
        title: `Polling-station reporting coverage by ${p.level}`,
        meta: { 'Generated at': new Date().toISOString(), Status: 'Publicly visible results only', Completeness: `${rows.reduce((a, r) => a + r.reported, 0)} of ${rows.reduce((a, r) => a + r.registered, 0)} stations reported`, Sources: 'Platform station register and accepted results' },
        columns: ['Area ID', 'Registered stations', 'Reported', 'Outstanding', 'Coverage %', 'Total votes'],
        rows: rows.map((r) => [r.id, r.registered, r.reported, r.outstanding, r.percent, r.totalVotes])
      };
    }
  },
  budgets: {
    async build(q) {
      const p = parse(z.object({ countyId: objectId.optional(), financialYear: z.string().max(10).optional() }).passthrough(), q);
      const f: Record<string, unknown> = { ...publicFilter };
      if (p.countyId) f.countyId = p.countyId;
      if (p.financialYear) f.financialYear = p.financialYear;
      const rows = await BudgetFigure.find(f).populate('departmentId', 'name').lean();
      const cm = await counties();
      return {
        title: 'County budget figures (published)',
        meta: { 'Generated at': new Date().toISOString(), 'Reporting period': p.financialYear ?? 'All financial years', Status: 'Published records only; missing metrics are absent, not zero', Completeness: `${rows.length} figures`, Sources: await sourceSummary(rows.map((r) => r.sourceId)) },
        columns: ['County', 'Financial year', 'Department', 'Metric', 'Value', 'Unit', 'Period', 'Period end', 'Verification', 'Source page', 'Revision'],
        rows: rows.map((r) => [cm.get(String(r.countyId)) ?? '', r.financialYear, (r.departmentId as unknown as { name?: string })?.name ?? 'County total', r.metric, r.value / 100, r.unit === 'BASIS_POINTS' ? '%' : 'KES', r.periodLabel, d(r.periodEnd), r.verificationStatus, r.sourcePage ?? '', r.revision])
      };
    }
  },
  disbursements: {
    async build(q) {
      const p = parse(z.object({ countyId: objectId.optional(), financialYear: z.string().max(10).optional() }).passthrough(), q);
      const f: Record<string, unknown> = { ...publicFilter };
      if (p.countyId) f.countyId = p.countyId;
      if (p.financialYear) f.financialYear = p.financialYear;
      const rows = await TreasuryDisbursement.find(f).sort({ asOfDate: 1 }).lean();
      const cm = await counties();
      return {
        title: 'Treasury disbursement records (published)',
        meta: { 'Generated at': new Date().toISOString(), 'Reporting period': p.financialYear ?? 'All', Status: 'Allocation, schedule, disbursement and receipt are separate stages', Completeness: `${rows.length} records`, Sources: await sourceSummary(rows.map((r) => r.sourceId)) },
        columns: ['County', 'Financial year', 'Stage', 'Funding stream', 'Amount (KES)', 'As of', 'Schedule', 'Official explanation'],
        rows: rows.map((r) => [cm.get(String(r.countyId)) ?? '', r.financialYear, r.stage, r.fundingStream, kes(r.amountCents), d(r.asOfDate), r.scheduleLabel ?? '', r.officialExplanation ?? ''])
      };
    }
  },
  projects: {
    async build(q) {
      const p = parse(z.object({ countyId: objectId.optional() }).passthrough(), q);
      const rows = await Project.find({ ...publicFilter, ...(p.countyId ? { countyId: p.countyId } : {}) }).populate('contractorId', 'name').lean();
      const cm = await counties();
      return {
        title: 'Development projects — payments and progress (published)',
        meta: { 'Generated at': new Date().toISOString(), Status: 'Financial and physical progress are separate measures', Completeness: `${rows.length} projects`, Sources: await sourceSummary(rows.map((r) => r.sourceId)) },
        columns: ['Reference', 'Name', 'County', 'Status', 'Approved budget (KES)', 'Revised budget (KES)', 'Paid (KES)', 'Financial progress %', 'Physical progress %', 'Physical basis', 'Contractor', 'Planned completion', 'Flagged'],
        rows: rows.map((r) => {
          const pr = progressOf(r as never);
          return [r.reference, r.name, cm.get(String(r.countyId)) ?? '', r.status, kes(r.approvedBudgetCents), kes(r.revisedBudgetCents), kes(r.amountPaidCents), pr.financial.percent, pr.physical?.percent ?? null, pr.physical?.basis ?? '', (r.contractorId as unknown as { name?: string })?.name ?? '', d(r.plannedCompletionDate), r.discrepancyFlag?.flagged ? 'Yes' : 'No'];
        })
      };
    }
  },
  'audit-findings': {
    async build(q) {
      const p = parse(z.object({ countyId: objectId.optional(), financialYear: z.string().max(10).optional() }).passthrough(), q);
      const f: Record<string, unknown> = { ...publicFilter };
      if (p.countyId) f.countyId = p.countyId;
      if (p.financialYear) f.financialYear = p.financialYear;
      const rows = await AuditFinding.find(f).lean();
      const cm = await counties();
      return {
        title: 'Audit findings (as worded in source reports)',
        meta: { 'Generated at': new Date().toISOString(), 'Reporting period': p.financialYear ?? 'All', Status: 'Audit queries are not findings of wrongdoing', Completeness: `${rows.length} findings`, Sources: await sourceSummary(rows.map((r) => r.sourceId)) },
        columns: ['Key', 'County', 'Financial year', 'Entity', 'Category', 'Amount questioned (KES)', 'Description', 'Report', 'Page', 'Latest status'],
        rows: rows.map((r) => [r.findingKey, cm.get(String(r.countyId)) ?? '', r.financialYear, r.entity, r.category, kes(r.amountQuestionedCents), r.description, r.reportTitle, r.pageNumber ?? '', r.latestKnownStatus])
      };
    }
  },
  'citizen-reports-summary': {
    async build() {
      const rows = await CitizenReport.aggregate<{ _id: { type: string; status: string }; n: number }>([{ $group: { _id: { type: '$type', status: '$status' }, n: { $sum: 1 } } }]);
      return {
        title: 'Citizen reporting summary (counts only)',
        meta: { 'Generated at': new Date().toISOString(), Status: 'Counts by type and moderation status; no personal data', Completeness: `${rows.reduce((a, r) => a + r.n, 0)} reports`, Sources: 'Public submissions to the platform' },
        columns: ['Type', 'Status', 'Count'],
        rows: rows.map((r) => [r._id.type, r._id.status, r.n])
      };
    }
  },
  'donations-summary': {
    async build() {
      const t = await donationTotals();
      return {
        title: 'Donations — aggregate confirmed totals',
        meta: { 'Generated at': new Date().toISOString(), Status: 'Confirmed payments only (pending and failed excluded)', Completeness: 'All confirmed donations to date', Sources: 'Payment provider confirmations recorded by the platform' },
        columns: ['Currency', 'Confirmed donations', 'Gross', 'Payment fees', 'Refunds', 'Net'],
        rows: t.map((r) => [r.currency, r.count, r.gross, r.paymentFees, r.refunds, r.net])
      };
    }
  },
  // ---- Restricted exports ----
  submissions: {
    permission: 'results.monitor',
    async build(q, req) {
      const p = parse(z.object({ electionId: objectId }).passthrough(), q);
      const subs = await ResultSubmission.find({ electionId: p.electionId, ...scopeFilter(req.user!) }).populate('pollingStationId', 'code name').lean();
      const ids = subs.map((s) => s.submissionId);
      const [revs, decs] = await Promise.all([SubmissionRevision.find({ submissionId: { $in: ids } }).lean(), VerificationDecision.find({ submissionId: { $in: ids } }).lean()]);
      const rows: Table['rows'] = [];
      for (const s of subs) {
        for (const r of revs.filter((x) => x.submissionId === s.submissionId).sort((a, b) => a.revision - b.revision)) {
          rows.push([s.submissionId, (s.pollingStationId as unknown as { code?: string })?.code ?? '', s.position, r.revision, r.serverReceivedAt.toISOString(), r.candidateVotes.reduce((a, c) => a + c.votes, 0), r.payloadHash, r.correctionReason ?? '', decs.filter((x) => x.submissionId === s.submissionId && x.revision === r.revision).map((x) => `${x.decision}: ${x.note}`).join(' | '), s.status]);
        }
      }
      return {
        title: 'Submission and verification history (restricted)',
        meta: { 'Generated at': new Date().toISOString(), Status: 'Restricted — contains unpublished submissions', Completeness: `${subs.length} submissions within your scope`, Sources: 'Agent submissions' },
        columns: ['Submission', 'Station', 'Position', 'Revision', 'Received at', 'Candidate vote sum', 'Payload hash', 'Correction reason', 'Decisions', 'Current status'],
        rows
      };
    }
  },
  donations: {
    permission: 'donations.view',
    async build(q) {
      const p = parse(z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }).passthrough(), q);
      const f: Record<string, unknown> = {};
      if (p.from || p.to) f.createdAt = { ...(p.from ? { $gte: p.from } : {}), ...(p.to ? { $lt: p.to } : {}) };
      const rows = await Donation.find(f).populate('receiptId', 'receiptNumber').sort({ createdAt: 1 }).lean();
      return {
        title: 'Donation records (restricted — no donor contact data)',
        meta: { 'Generated at': new Date().toISOString(), 'Reporting period': `${d(p.from) ?? 'start'} to ${d(p.to) ?? 'now'}`, Status: 'All statuses; only SUCCESSFUL and refunded statuses represent received money', Completeness: `${rows.length} records`, Sources: 'Platform payment records' },
        columns: ['Reference', 'Created', 'Confirmed', 'Status', 'Method', 'Provider mode', 'Amount', 'Currency', 'Fee', 'Refunded', 'Provider receipt', 'Receipt number', 'Needs reconciliation'],
        rows: rows.map((r) => [r.reference, r.createdAt?.toISOString() ?? '', r.confirmedAt?.toISOString() ?? '', r.status, r.method, r.providerMode, r.amountCents / 100, r.currency, kes(r.feeCents), kes(r.refundedCents), r.providerReceipt ?? '', (r.receiptId as unknown as { receiptNumber?: string })?.receiptNumber ?? '', r.needsReconciliation ? 'Yes' : 'No'])
      };
    }
  },
  'audit-log': {
    permission: 'audit.view',
    async build(q) {
      const p = parse(z.object({ from: z.coerce.date().optional() }).passthrough(), q);
      const rows = await AuditEvent.find(p.from ? { at: { $gte: p.from } } : {}).sort({ seq: 1 }).limit(100_000).lean();
      return {
        title: 'Audit log (restricted)',
        meta: { 'Generated at': new Date().toISOString(), Status: 'Hash-chained; verify with the audit:verify script', Completeness: `${rows.length} events`, Sources: 'Platform audit trail' },
        columns: ['Seq', 'At', 'Actor', 'Role', 'Action', 'Entity', 'Entity ID', 'Hash'],
        rows: rows.map((r) => [r.seq, r.at.toISOString(), r.actorLabel ?? String(r.actorId ?? ''), r.actorRole ?? '', r.action, r.entityType, r.entityId ?? '', r.hash])
      };
    }
  }
};

export const EXPORT_KINDS = Object.keys(BUILDERS);

export function exportsRouter() {
  const r = Router();
  r.get('/:kind', limiter('exports', { windowMs: 60_000, limit: 20 }), optionalAuth, async (req: Request, res: Response) => {
    const kind = parse(z.enum(EXPORT_KINDS as [string, ...string[]]), req.params.kind);
    const format = parse(z.enum(['csv', 'xlsx', 'pdf']).default('csv'), req.query.format);
    const b = BUILDERS[kind]!;
    if (b.permission) {
      if (!req.user || !can(req.user, b.permission) || !mfaSatisfied(req.user)) throw forbidden();
    }
    const table = await b.build(req.query as Record<string, string>, req);
    if (b.permission) {
      await recordAuditStandalone({ actor: { id: req.user!.id, role: req.user!.role, label: req.user!.fullName, ip: req.ip }, action: 'export.sensitive_download', entityType: 'Export', entityId: kind, meta: { format, query: req.query, rows: table.rows.length } });
    }
    const name = `northern-iebc-${kind}-${new Date().toISOString().slice(0, 10)}.${format}`;
    const body = format === 'csv' ? toCsv(table) : format === 'xlsx' ? await toXlsx(table) : await toPdf(table);
    res.set({
      'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': b.permission ? 'private, no-store' : 'public, max-age=60'
    });
    res.send(body);
  });
  return r;
}
