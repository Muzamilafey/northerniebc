import request from 'supertest';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, setupDb, teardownDb } from './helpers.js';
import { BudgetFigure, CitizenReport, County, DataSource, Project } from '../src/models/index.js';
import { clearCache } from '../src/lib/cache.js';

let app: Express;
let importer: Awaited<ReturnType<typeof as>>;
let reviewer: Awaited<ReturnType<typeof as>>;
let publisher: Awaited<ReturnType<typeof as>>;
let sourceId: string;
let garissa: { _id: unknown };

beforeAll(async () => {
  app = await setupDb();
  importer = await as(app, 'FINANCE_OFFICER');
  reviewer = await as(app, 'VERIFICATION_OFFICER');
  publisher = await as(app, 'REGIONAL_ADMIN');
  garissa = (await County.findOne({ code: '007' }))!;
  const src = await request(app).post('/api/admin/sources').set(importer.auth).send({ name: 'Controller of Budget — County Budget Implementation Review Report (test fixture)', kind: 'COB_REPORT', url: 'https://cob.go.ke/', documentTitle: 'Test fixture document', publicationDate: '2024-09-30' });
  expect(src.status).toBe(201);
  sourceId = src.body.source._id;
});
afterAll(teardownDb);

async function runImport(kind: string, csv: string, opts: { applyConflicts?: boolean; correctionReason?: string } = {}) {
  const up = await request(app).post('/api/admin/imports').set(importer.auth).field('kind', kind).field('sourceId', sourceId).attach('file', Buffer.from(csv), { filename: 'data.csv', contentType: 'text/csv' });
  expect(up.status).toBe(201);
  const id = up.body.job._id;
  const v = await request(app).post(`/api/admin/imports/${id}/validate`).set(importer.auth);
  expect(v.status).toBe(200);
  const selfReview = await request(app).post(`/api/admin/imports/${id}/review`).set(importer.auth).send({ note: 'self review' });
  expect(selfReview.status).toBe(403);
  const rv = await request(app).post(`/api/admin/imports/${id}/review`).set(reviewer.auth).send({ note: 'Checked against source pages' });
  expect(rv.status).toBe(200);
  const pub = await request(app).post(`/api/admin/imports/${id}/publish`).set(publisher.auth).send(opts);
  expect(pub.status).toBe(200);
  return { id, counts: v.body.counts, applied: pub.body.applied };
}

describe('county budgets', () => {
  it('lists all five counties', async () => {
    const r = await request(app).get('/api/public/counties');
    expect(r.body.items.map((c: { name: string }) => c.name)).toEqual(['Garissa', 'Isiolo', 'Mandera', 'Marsabit', 'Wajir']);
  });

  it('shows an honest data-unavailable state rather than zeros', async () => {
    const r = await request(app).get('/api/public/budgets/summary').query({ countyId: String(garissa._id), financialYear: '2023/24' });
    expect(r.status).toBe(200);
    expect(r.body.dataAvailable).toBe(false);
    expect(r.body.metrics.APPROVED_BUDGET).toEqual({ available: false });
    expect(r.body.derived.budgetUtilisation.value).toBeNull();
  });

  it('validates financial years and rejects blank values instead of storing zero', async () => {
    const csv = ['county_code,financial_year,department,metric,value,period_label,period_end', '007,2023/25,,APPROVED_BUDGET,100,Approved,2024-06-30', '007,2023/24,,ACTUAL_EXPENDITURE,,Q4,2024-06-30', '007,2023/24,,APPROVED_BUDGET,1000000,Approved,2024-06-30', '007,2023/24,,APPROVED_BUDGET,1000000,Approved,2024-06-30'].join('\n');
    const up = await request(app).post('/api/admin/imports').set(importer.auth).field('kind', 'BUDGET_FIGURES').field('sourceId', sourceId).attach('file', Buffer.from(csv), { filename: 'b.csv', contentType: 'text/csv' });
    const v = await request(app).post(`/api/admin/imports/${up.body.job._id}/validate`).set(importer.auth);
    expect(v.body.counts).toMatchObject({ INVALID: 2, VALID: 1, DUPLICATE: 1 });
  });

  it('publishes figures through review, linked to their source, keeping release/receipt/spend distinct', async () => {
    const csv = [
      'county_code,financial_year,department,metric,value,period_label,period_end,source_page',
      '007,2023/24,,APPROVED_BUDGET,12000000000,Approved estimates,2024-06-30,12',
      '007,2023/24,,ACTUAL_EXPENDITURE,9000000000,FY 2023/24 Q4 cumulative,2024-06-30,44',
      '007,2023/24,Health Services,APPROVED_BUDGET,3000000000,Approved estimates,2024-06-30,13'
    ].join('\n');
    const r = await runImport('BUDGET_FIGURES', csv);
    expect(r.applied).toBe(3);
    clearCache();
    const s = await request(app).get('/api/public/budgets/summary').query({ countyId: String(garissa._id), financialYear: '2023/24' });
    expect(s.body.metrics.APPROVED_BUDGET.value).toBe(12_000_000_000);
    expect(s.body.metrics.APPROVED_BUDGET.source.name).toContain('Controller of Budget');
    expect(s.body.metrics.APPROVED_BUDGET.sourcePage).toBe('12');
    expect(s.body.metrics.FUNDS_RECEIVED).toEqual({ available: false });
    expect(s.body.derived.budgetUtilisation.value).toBe(75);
    expect(s.body.derived.budgetUtilisation.inputs).toHaveLength(2);

    const disb = ['county_code,financial_year,stage,amount_kes,as_of_date', '007,2023/24,ALLOCATION,10000000000,2024-06-30', '007,2023/24,SCHEDULED,8000000000,2024-03-31', '007,2023/24,DISBURSED,6000000000,2024-03-31'].join('\n');
    await runImport('TREASURY_DISBURSEMENTS', disb);
    const d = await request(app).get('/api/public/disbursements').query({ countyId: String(garissa._id), financialYear: '2023/24' });
    const item = d.body.items[0];
    expect(item.stages.ALLOCATION.amountKes).toBe(10_000_000_000);
    expect(item.stages.DISBURSED.amountKes).toBe(6_000_000_000);
    expect(item.stages.RECEIVED).toBeNull();
    expect(item.outstandingAgainstSchedule.amountKes).toBe(2_000_000_000);
  });

  it('corrections preserve previously published values', async () => {
    const csv = ['county_code,financial_year,department,metric,value,period_label,period_end', '007,2023/24,,APPROVED_BUDGET,12500000000,Approved estimates,2024-06-30'].join('\n');
    const up = await request(app).post('/api/admin/imports').set(importer.auth).field('kind', 'BUDGET_FIGURES').field('sourceId', sourceId).attach('file', Buffer.from(csv), { filename: 'c.csv', contentType: 'text/csv' });
    const v = await request(app).post(`/api/admin/imports/${up.body.job._id}/validate`).set(importer.auth);
    expect(v.body.counts.CONFLICT).toBe(1);
    await request(app).post(`/api/admin/imports/${up.body.job._id}/review`).set(reviewer.auth).send({ note: 'Supplementary estimates gazetted' });
    const noReason = await request(app).post(`/api/admin/imports/${up.body.job._id}/publish`).set(publisher.auth).send({ applyConflicts: true });
    expect(noReason.status).toBe(400);
    const pub = await request(app).post(`/api/admin/imports/${up.body.job._id}/publish`).set(publisher.auth).send({ applyConflicts: true, correctionReason: 'Corrected per revised printed estimates p.12' });
    expect(pub.status).toBe(200);
    const all = await BudgetFigure.find({ countyId: garissa._id, metric: 'APPROVED_BUDGET', departmentId: null }).sort({ revision: 1 }).lean();
    expect(all.map((f) => [f.value / 100, f.isCurrent])).toEqual([[12_000_000_000, false], [12_500_000_000, true]]);
    expect(String(all[1]!.supersedesId)).toBe(String(all[0]!._id));
    clearCache();
    const s = await request(app).get('/api/public/budgets/summary').query({ countyId: String(garissa._id), financialYear: '2023/24' });
    expect(s.body.metrics.APPROVED_BUDGET.value).toBe(12_500_000_000);
    expect(s.body.metrics.APPROVED_BUDGET.revision).toBe(2);
  });

  it('aggregated public figures reconcile with underlying records', async () => {
    const figs = await request(app).get('/api/public/budgets/figures').query({ countyId: String(garissa._id), financialYear: '2023/24', limit: 200 });
    const db = await BudgetFigure.find({ countyId: garissa._id, financialYear: '2023/24', workflowStatus: 'PUBLISHED', isCurrent: true }).lean();
    expect(figs.body.total).toBe(db.length);
    const sumApi = figs.body.items.reduce((a: number, f: { value: number }) => a + f.value, 0);
    const sumDb = db.reduce((a, f) => a + f.value / 100, 0);
    expect(sumApi).toBeCloseTo(sumDb, 2);
  });

  it('a manually-entered record requires a source, review by another person, then publication', async () => {
    const f = await request(app).post('/api/admin/figures').set(importer.auth).send({ countyId: String(garissa._id), financialYear: '2022/23', metric: 'PENDING_BILLS', value: 500000000, periodLabel: 'As at 30 June 2023', periodEnd: '2023-06-30', sourceId });
    expect(f.status).toBe(201);
    const id = f.body.record._id;
    expect((await request(app).post(`/api/admin/records/BUDGET_FIGURE/${id}/advance`).set(importer.auth).send({ to: 'PUBLISHED' })).status).toBe(409);
    expect((await request(app).post(`/api/admin/records/BUDGET_FIGURE/${id}/advance`).set(importer.auth).send({ to: 'VALIDATED' })).status).toBe(200);
    expect((await request(app).post(`/api/admin/records/BUDGET_FIGURE/${id}/advance`).set(importer.auth).send({ to: 'REVIEWED' })).status).toBe(403);
    expect((await request(app).post(`/api/admin/records/BUDGET_FIGURE/${id}/advance`).set(reviewer.auth).send({ to: 'REVIEWED' })).status).toBe(200);
    expect((await request(app).post(`/api/admin/records/BUDGET_FIGURE/${id}/advance`).set(reviewer.auth).send({ to: 'PUBLISHED' })).status).toBe(403);
    expect((await request(app).post(`/api/admin/records/BUDGET_FIGURE/${id}/advance`).set(publisher.auth).send({ to: 'PUBLISHED' })).status).toBe(200);
  });
});

describe('projects', () => {
  it('keeps financial and physical progress separate and flags documented discrepancies', async () => {
    const csv = [
      'reference,name,county_code,sector,approved_budget_kes,amount_paid_kes,status,physical_progress_percent,physical_progress_basis,physical_progress_date,lat,lng,location_verified',
      'GRS-WAT-001,Borehole rehabilitation (test fixture),007,BOREHOLE,10000000,10000000,ONGOING,40,INSPECTION,2024-05-01,-0.45,39.64,true',
      'GRS-RD-002,Road works (test fixture),007,ROADS,50000000,5000000,DELAYED,,,,,,'
    ].join('\n');
    await runImport('PROJECTS', csv);
    const r = await request(app).get('/api/public/projects/GRS-WAT-001');
    expect(r.status).toBe(200);
    expect(r.body.project.progress.financial.percent).toBe(100);
    expect(r.body.project.progress.physical.percent).toBe(40);
    expect(r.body.project.progress.physical.basis).toBe('INSPECTION');
    expect(r.body.project.status).toBe('ONGOING'); // fully paid does not make it complete
    expect(r.body.project.progress.exceedsThreshold).toBe(true);
    const r2 = await request(app).get('/api/public/projects/GRS-RD-002');
    expect(r2.body.project.progress.physical).toBeNull();
    const map = await request(app).get('/api/public/projects/map');
    expect(map.body.items.map((p: { reference: string }) => p.reference)).toEqual(['GRS-WAT-001']);

    const pm = await as(app, 'SUPER_ADMIN');
    const disc = await request(app).get('/api/admin/projects-discrepancies').set(pm.auth);
    expect(disc.body.items.map((x: { reference: string }) => x.reference)).toContain('GRS-WAT-001');
    const proj = await Project.findOne({ reference: 'GRS-WAT-001', isCurrent: true });
    const noEvidence = await request(app).post(`/api/admin/projects/${String(proj!._id)}/flag`).set(pm.auth).send({ flagged: true, reason: 'Payments exceed inspected progress' });
    expect(noEvidence.status).toBe(400);
    const flag = await request(app).post(`/api/admin/projects/${String(proj!._id)}/flag`).set(pm.auth).send({ flagged: true, reason: 'Payments exceed inspected progress', evidenceSourceIds: [sourceId] });
    expect(flag.status).toBe(200);
  });

  it('refuses COMPLETED status without documentary basis', async () => {
    const pm = await as(app, 'SUPER_ADMIN');
    const r = await request(app).post('/api/admin/projects').set(pm.auth).send({ reference: 'X-1', name: 'Test project', countyId: String(garissa._id), status: 'COMPLETED', approvedBudgetKes: 100, amountPaidKes: 100, sourceId });
    expect(r.status).toBe(400);
  });
});

describe('audit findings', () => {
  it('retains source wording and category and keeps history on status updates', async () => {
    const csv = ['finding_key,county_code,financial_year,entity,category,amount_questioned_kes,description,report_title,page_number,latest_known_status', 'OAG-GRS-2223-01,007,2022/23,County Executive of Garissa,UNSUPPORTED_EXPENDITURE,12345678,"Expenditure of Kshs.12,345,678 was not supported by documents (test fixture wording)",Report of the Auditor-General (test fixture),27,As reported'].join('\n');
    await runImport('AUDIT_FINDINGS', csv);
    const r = await request(app).get('/api/public/audit-findings/OAG-GRS-2223-01');
    expect(r.body.finding.description).toContain('was not supported by documents');
    expect(r.body.finding.categoryLabel).toBe('Unsupported expenditure');
    expect(r.body.wordingNote).toMatch(/not findings of theft/);
    const upd = csv.replace('As reported', 'Matter referred to the county assembly committee (test)');
    await runImport('AUDIT_FINDINGS', upd, { applyConflicts: true, correctionReason: 'Status update from assembly committee report' });
    const r2 = await request(app).get('/api/public/audit-findings/OAG-GRS-2223-01');
    expect(r2.body.finding.latestKnownStatus).toContain('referred');
    expect(r2.body.history).toHaveLength(2);
    expect(r2.body.history[1].latestKnownStatus).toBe('As reported');
  });

  it('requires documented determination wording for confirmed-loss categories', async () => {
    const csv = ['finding_key,county_code,financial_year,entity,category,description,report_title', 'K2,007,2022/23,Entity,CONFIRMED_LOSS,Something happened in the report,Report'].join('\n');
    const up = await request(app).post('/api/admin/imports').set(importer.auth).field('kind', 'AUDIT_FINDINGS').field('sourceId', sourceId).attach('file', Buffer.from(csv), { filename: 'f.csv', contentType: 'text/csv' });
    const v = await request(app).post(`/api/admin/imports/${up.body.job._id}/validate`).set(importer.auth);
    expect(v.body.counts.INVALID).toBe(1);
  });
});

describe('citizen reports', () => {
  it('are unverified until reviewed and never expose personal data', async () => {
    const r = await request(app).post('/api/public/citizen-reports').field('type', 'STALLED_PROJECT').field('title', 'Borehole not working').field('description', 'The borehole at the market has not worked for three months despite works.').field('countyId', String(garissa._id)).field('reporterName', 'Jane Citizen').field('reporterContact', '+254700000000').field('consentPrivacy', 'true');
    expect(r.status).toBe(201);
    let pub = await request(app).get('/api/public/citizen-reports');
    expect(pub.body.items).toHaveLength(0);
    const dup = await request(app).post('/api/public/citizen-reports').field('type', 'STALLED_PROJECT').field('title', 'Same borehole').field('description', 'The borehole at the market has not worked for three months despite works.').field('countyId', String(garissa._id)).field('consentPrivacy', 'true');
    expect(dup.status).toBe(201);
    const dupDoc = await CitizenReport.findOne({ reference: dup.body.reference });
    expect(dupDoc!.duplicateOfId).toBeTruthy();
    const honeypot = await request(app).post('/api/public/citizen-reports').field('type', 'STALLED_PROJECT').field('title', 'Spam spam').field('description', 'Spam spam spam spam spam spam spam spam').field('consentPrivacy', 'true').field('website', 'http://spam');
    expect(honeypot.status).toBe(400);

    const mod = await as(app, 'VERIFICATION_OFFICER');
    const doc = await CitizenReport.findOne({ reference: r.body.reference });
    const detail = await request(app).get(`/api/admin/citizen-reports/${String(doc!._id)}`).set(mod.auth);
    expect(JSON.stringify(detail.body)).not.toContain('Jane Citizen');
    const noSummary = await request(app).post(`/api/admin/citizen-reports/${String(doc!._id)}/moderate`).set(mod.auth).send({ status: 'PUBLISHED', note: 'ok' });
    expect(noSummary.status).toBe(400);
    const ok = await request(app).post(`/api/admin/citizen-reports/${String(doc!._id)}/moderate`).set(mod.auth).send({ status: 'PUBLISHED', note: 'Site visit pending', publicSummary: 'A resident reports that a market borehole has not been working for about three months.' });
    expect(ok.status).toBe(200);
    pub = await request(app).get('/api/public/citizen-reports');
    expect(pub.body.items).toHaveLength(1);
    expect(pub.body.items[0].label).toMatch(/Citizen-reported/);
    const json = JSON.stringify(pub.body);
    expect(json).not.toContain('Jane');
    expect(json).not.toContain('+254700000000');
    expect(json).not.toContain('borehole at the market has not worked');
  });
});

describe('exports', () => {
  it('public exports include generation time, period, sources, status and completeness', async () => {
    const r = await request(app).get('/api/exports/budgets').query({ format: 'csv', financialYear: '2023/24' });
    expect(r.status).toBe(200);
    const text = r.text;
    for (const k of ['Generated at', 'Reporting period', 'Status', 'Completeness', 'Sources']) expect(text).toContain(`# ${k}:`);
    const x = await request(app).get('/api/exports/projects').query({ format: 'xlsx' });
    expect(x.status).toBe(200);
    const p = await request(app).get('/api/exports/audit-findings').query({ format: 'pdf' });
    expect(p.body.slice(0, 4).toString()).toBe('%PDF');
  });

  it('sensitive exports require authorisation and are logged', async () => {
    expect((await request(app).get('/api/exports/donations')).status).toBe(403);
    const agent = await as(app, 'AGENT');
    expect((await request(app).get('/api/exports/donations').set(agent.auth)).status).toBe(403);
    const fin = await as(app, 'FINANCE_OFFICER');
    const r = await request(app).get('/api/exports/donations').set(fin.auth);
    expect(r.status).toBe(200);
    const { AuditEvent } = await import('../src/models/index.js');
    expect(await AuditEvent.exists({ action: 'export.sensitive_download', actorId: fin.id })).toBeTruthy();
  });
});

describe('search', () => {
  it('finds public records and escapes regex input', async () => {
    const r = await request(app).get('/api/public/search').query({ q: 'Gari' });
    expect(r.body.counties[0].name).toBe('Garissa');
    const p = await request(app).get('/api/public/search').query({ q: 'GRS-WAT' });
    expect(p.body.projects[0].reference).toBe('GRS-WAT-001');
    const evil = await request(app).get('/api/public/search').query({ q: '(a+)+$' });
    expect(evil.status).toBe(200);
  });
});
