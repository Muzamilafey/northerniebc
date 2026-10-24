import { Router } from 'express';
import { z } from 'zod';
import { withTransaction } from '../../db/mongo.js';
import { recordAudit } from '../../lib/audit.js';
import { cached } from '../../lib/cache.js';
import { notFound } from '../../lib/errors.js';
import { parse } from '../../lib/http.js';
import { requirePermission } from '../../middleware/auth.js';
import { AuditFinding, BudgetFigure, County, Election, PlatformUpdate, PollingStation, Project, publicFilter, StationResult } from '../../models/index.js';
import { publicStatuses } from '../results/query.js';
import { percent } from '../../lib/money.js';

export function sitePublicRouter() {
  const r = Router();

  /** Homepage summary — every figure here comes from published records; absent data is reported as absent. */
  r.get('/home', async (_req, res) => {
    res.json(
      await cached('public:home', 15_000, async () => {
        const [counties, active, latestElection, recentProjects, latestFindings, updates, latestBudget] = await Promise.all([
          County.find().sort({ name: 1 }).lean(),
          Election.findOne({ status: 'ACTIVE' }).sort({ electionDate: -1 }).lean(),
          Election.findOne({ status: { $in: ['CLOSED', 'ARCHIVED'] } }).sort({ electionDate: -1 }).lean(),
          Project.find(publicFilter).sort({ publishedAt: -1 }).limit(5).select('reference name status countyId publishedAt').lean(),
          AuditFinding.find(publicFilter).sort({ publishedAt: -1 }).limit(5).select('findingKey entity category financialYear countyId amountQuestionedCents publishedAt').lean(),
          PlatformUpdate.find({ published: true }).sort({ publishedAt: -1 }).limit(5).select('title body kind publishedAt').lean(),
          BudgetFigure.find({ ...publicFilter, metric: { $in: ['APPROVED_BUDGET', 'REVISED_BUDGET'] }, departmentId: null, projectId: null }).sort({ financialYear: -1, periodEnd: -1 }).limit(20).populate('sourceId', 'name documentTitle url').lean()
        ]);
        let electionSummary = null;
        const e = active ?? latestElection;
        if (e) {
          const [registered, reported] = await Promise.all([
            PollingStation.countDocuments({ electionId: e._id, active: true }),
            StationResult.distinct('pollingStationId', { electionId: e._id, status: { $in: publicStatuses(e.publishProvisional) } })
          ]);
          electionSummary = { id: String(e._id), name: e.name, status: e.status, electionDate: e.electionDate, active: Boolean(active), registeredStations: registered, reportedStations: reported.length, coveragePercent: percent(reported.length, registered) };
        }
        const budgetByCounty = counties.map((c) => {
          const f = latestBudget.find((b) => String(b.countyId) === String(c._id));
          return { countyId: String(c._id), county: c.name, figure: f ? { metric: f.metric, valueKes: f.value / 100, financialYear: f.financialYear, periodLabel: f.periodLabel, source: f.sourceId, verificationStatus: f.verificationStatus } : null };
        });
        return { counties, election: electionSummary, budgets: budgetByCounty, recentProjects, latestFindings, updates, generatedAt: new Date() };
      })
    );
  });

  r.get('/counties/:slug', async (req, res) => {
    const c = await County.findOne({ slug: String(req.params.slug) }).lean();
    if (!c) throw notFound();
    const [projects, findings, years] = await Promise.all([
      Project.countDocuments({ ...publicFilter, countyId: c._id }),
      AuditFinding.countDocuments({ ...publicFilter, countyId: c._id }),
      BudgetFigure.distinct('financialYear', { ...publicFilter, countyId: c._id })
    ]);
    res.json({ county: c, counts: { projects, auditFindings: findings }, budgetYears: years.sort().reverse() });
  });

  r.get('/updates', async (_req, res) => {
    res.json({ items: await PlatformUpdate.find({ published: true }).sort({ publishedAt: -1 }).limit(50).lean() });
  });

  return r;
}

export function siteAdminRouter() {
  const r = Router();
  r.post('/updates', requirePermission('audit.view'), async (req, res) => {
    const b = parse(z.object({ title: z.string().min(3).max(200), body: z.string().min(10).max(5000), kind: z.enum(['UPDATE', 'METHODOLOGY', 'CORRECTION']).default('UPDATE'), publish: z.boolean().default(true) }), req.body);
    const u = await withTransaction(async (s) => {
      const [doc] = await PlatformUpdate.create([{ title: b.title, body: b.body, kind: b.kind, published: b.publish, publishedAt: b.publish ? new Date() : undefined, createdBy: req.user!.id }], { session: s });
      await recordAudit(s, { actor: { id: req.user!.id, role: req.user!.role, ip: req.ip }, action: 'platform_update.created', entityType: 'PlatformUpdate', entityId: String(doc!._id), after: b });
      return doc!;
    });
    res.status(201).json({ update: u });
  });
  return r;
}
