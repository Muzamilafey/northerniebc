import { Router } from 'express';
import { z } from 'zod';
import { verifyAuditChain } from '../../lib/audit.js';
import { pageParams, parse } from '../../lib/http.js';
import { requirePermission } from '../../middleware/auth.js';
import { AuditEvent } from '../../models/index.js';
import { objectId } from '../users/routes.js';

export function auditLogRouter() {
  const r = Router();
  const view = requirePermission('audit.view');
  r.get('/', view, async (req, res) => {
    const q = parse(z.object({ action: z.string().max(80).optional(), entityType: z.string().max(80).optional(), entityId: z.string().max(80).optional(), actorId: objectId.optional() }).passthrough(), req.query);
    const { page, limit, skip } = pageParams(req.query, 200);
    const filter: Record<string, unknown> = {};
    if (q.action) filter.action = q.action;
    if (q.entityType) filter.entityType = q.entityType;
    if (q.entityId) filter.entityId = q.entityId;
    if (q.actorId) filter.actorId = q.actorId;
    const [items, total] = await Promise.all([AuditEvent.find(filter).sort({ seq: -1 }).skip(skip).limit(limit).lean(), AuditEvent.countDocuments(filter)]);
    res.json({ items, total, page, limit });
  });
  r.get('/verify', view, async (_req, res) => {
    res.json(await verifyAuditChain());
  });
  return r;
}
