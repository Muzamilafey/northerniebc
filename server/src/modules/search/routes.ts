import { Router } from 'express';
import { z } from 'zod';
import { escapeRegex, parse } from '../../lib/http.js';
import { AuditFinding, BudgetFigure, Candidate, Constituency, County, DataSource, Department, Election, PollingStation, Project, publicFilter, Ward } from '../../models/index.js';
import { objectId } from '../users/routes.js';

/**
 * Global public search. Only public records are searched, so results are identical for all
 * users and never leak unpublished data. Input is escaped before use in a regular expression.
 */
export function searchRouter() {
  const r = Router();
  r.get('/search', async (req, res) => {
    const q = parse(z.object({ q: z.string().trim().min(2).max(80), electionId: objectId.optional() }).passthrough(), req.query);
    const rx = new RegExp(escapeRegex(q.q), 'i');
    const elections = await Election.find({ status: { $ne: 'DRAFT' } }).sort({ electionDate: -1 }).select('_id name').lean();
    const electionIds = q.electionId ? [q.electionId] : elections.map((e) => e._id);
    const L = 8;
    const [counties, constituencies, wards, stations, candidates, projects, departments, findings, sources, years] = await Promise.all([
      County.find({ name: rx }).limit(L).select('name slug').lean(),
      Constituency.find({ electionId: { $in: electionIds }, $or: [{ name: rx }, { code: q.q }] }).limit(L).select('name code countyId electionId').lean(),
      Ward.find({ electionId: { $in: electionIds }, $or: [{ name: rx }, { code: q.q }] }).limit(L).select('name code constituencyId electionId').lean(),
      PollingStation.find({ electionId: { $in: electionIds }, $or: [{ name: rx }, { code: q.q }] }).limit(L).select('name code wardId electionId').lean(),
      Candidate.find({ electionId: { $in: electionIds }, active: true, $or: [{ fullName: rx }, { party: rx }, { partyAbbreviation: rx }] }).limit(L).select('fullName party position electionId').lean(),
      Project.find({ ...publicFilter, $or: [{ name: rx }, { reference: rx }] }).limit(L).select('name reference status countyId').lean(),
      Department.find({ name: rx, active: true }).limit(L).select('name countyId').lean(),
      AuditFinding.find({ ...publicFilter, $or: [{ description: rx }, { entity: rx }, { findingKey: rx }] }).limit(L).select('findingKey entity financialYear category countyId').lean(),
      DataSource.find({ verificationStatus: 'REVIEWED', $or: [{ name: rx }, { documentTitle: rx }] }).limit(L).select('name documentTitle url publicationDate').lean(),
      /^20\d{2}(\/\d{0,2})?$/.test(q.q) ? BudgetFigure.distinct('financialYear', { ...publicFilter, financialYear: new RegExp(`^${escapeRegex(q.q)}`) }) : Promise.resolve([])
    ]);
    res.json({ query: q.q, counties, constituencies, wards, stations, candidates, projects, departments, auditFindings: findings, sources, financialYears: years });
  });
  return r;
}
