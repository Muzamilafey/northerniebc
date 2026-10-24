import { Router } from 'express';
import { z } from 'zod';
import { withTransaction } from '../../db/mongo.js';
import { recordAudit } from '../../lib/audit.js';
import { parse } from '../../lib/http.js';
import { upload } from '../../lib/upload.js';
import { requirePermission } from '../../middleware/auth.js';
import { DataSource, Party } from '../../models/index.js';
import { ORPP_HOSTS, ORPP_LIST_PAGE, annotate, readPartyList } from './registry.js';

export function partiesAdminRouter() {
  const r = Router();
  const manage = requirePermission('candidates.manage');

  /** Step 1: read the register into a preview. Nothing is saved. */
  r.post('/parties/read', manage, upload.single('file'), async (req, res) => {
    const body = parse(z.object({ url: z.string().trim().max(500).optional(), text: z.string().max(100_000).optional() }), req.body ?? {});
    res.json(await readPartyList({ url: body.url || undefined, text: body.text || undefined, pdf: req.file?.buffer }));
  });

  r.get('/parties/registry-info', manage, (_req, res) => {
    res.json({ listPage: ORPP_LIST_PAGE, allowedHosts: ORPP_HOSTS });
  });

  /** Step 2: import the rows the administrator reviewed. Existing parties are never changed. */
  r.post('/parties/import', manage, async (req, res) => {
    const body = parse(
      z.object({
        rows: z.array(z.object({ name: z.string().trim().min(2).max(200), abbreviation: z.string().trim().min(1).max(20) })).min(1).max(300),
        source: z.object({ title: z.string().trim().max(300).nullable().optional(), url: z.string().trim().url().max(500).nullable().optional(), asAt: z.string().trim().max(100).nullable().optional() })
      }),
      req.body
    );
    const checked = await annotate(body.rows);
    const fresh = checked.filter((r) => r.status === 'NEW' && !r.problem);
    const reference = ['ORPP register of political parties', body.source.asAt ? `as at ${body.source.asAt}` : null, body.source.url].filter(Boolean).join(', ').slice(0, 300);
    const created = await withTransaction(async (s) => {
      if (body.source.url && ORPP_HOSTS.includes(new URL(body.source.url).hostname)) {
        await DataSource.updateOne(
          { url: body.source.url },
          { $setOnInsert: { name: body.source.title ?? 'ORPP — Fully Registered Political Parties', publisher: 'Office of the Registrar of Political Parties', url: body.source.url, kind: 'OTHER', retrievedAt: new Date(), verificationStatus: 'UNREVIEWED', notes: body.source.asAt ? `As at ${body.source.asAt}` : undefined } },
          { upsert: true, session: s }
        );
      }
      const docs = fresh.length ? await Party.create(fresh.map((r) => ({ name: r.name, abbreviation: r.abbreviation!, sourceReference: reference })), { session: s, ordered: true }) : [];
      await recordAudit(s, { actor: { id: req.user!.id, role: req.user!.role, label: req.user!.fullName, ip: req.ip }, action: 'parties.imported', entityType: 'Party', after: { count: docs.length, source: reference, abbreviations: docs.map((d) => d.abbreviation) } });
      return docs;
    });
    res.json({ created: created.length, alreadyPresent: checked.filter((r) => r.status === 'EXISTS').length, skipped: checked.filter((r) => r.status === 'NEW' && r.problem).map((r) => ({ name: r.name, problem: r.problem })) });
  });

  return r;
}
