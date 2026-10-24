import { Router } from 'express';
import { z } from 'zod';
import { withTransaction } from '../../db/mongo.js';
import { recordAudit } from '../../lib/audit.js';
import { badRequest } from '../../lib/errors.js';
import { parse } from '../../lib/http.js';
import { requirePermission } from '../../middleware/auth.js';
import { resetKraToken, testKraCredentials } from '../../integrations/kra.js';
import { resetMpesaToken } from '../../payments/mpesa.js';
import { getTransport } from '../notifications/service.js';
import { describeSettings, SETTING_FIELDS, updateSettings, type Section } from './service.js';

/** Integration credentials (super administrators only, MFA required). Secrets are write-only. */
export function settingsRouter() {
  const r = Router();
  const admin = requirePermission('settings.manage');

  r.get('/', admin, async (_req, res) => {
    res.json({ settings: await describeSettings() });
  });

  r.put('/:section', admin, async (req, res) => {
    const section = parse(z.enum(Object.keys(SETTING_FIELDS) as [Section, ...Section[]]), req.params.section);
    const body = parse(z.object({ values: z.record(z.string().max(2000)).default({}), clear: z.array(z.string().max(80)).max(20).default([]) }), req.body);
    let changed: string[];
    try {
      changed = await updateSettings(section, body.values, body.clear, req.user!.id);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    if (section === 'mpesa') resetMpesaToken();
    if (section === 'kra') resetKraToken();
    await withTransaction((s) => recordAudit(s, { actor: { id: req.user!.id, role: req.user!.role, label: req.user!.fullName, ip: req.ip }, action: 'settings.updated', entityType: 'Settings', entityId: section, meta: { fields: changed } }));
    res.json({ settings: await describeSettings(), changed });
  });

  /** Checks the stored credentials against the provider without exposing them. */
  r.post('/:section/test', admin, async (req, res) => {
    const section = parse(z.enum(['mpesa', 'smtp', 'kra']), req.params.section);
    try {
      if (section === 'kra') await testKraCredentials();
      if (section === 'smtp') {
        const t = getTransport();
        if (!t) throw new Error('SMTP is not configured');
        await t.verify();
      }
      if (section === 'mpesa') {
        const { mpesaProvider } = await import('../../payments/mpesa.js');
        if (!mpesaProvider.configured()) throw new Error('M-Pesa is not fully configured (callback token needs 24+ characters)');
        const { testMpesaAuth } = await import('../../payments/mpesa.js');
        await testMpesaAuth();
      }
      res.json({ ok: true, message: 'Connection succeeded' });
    } catch (e) {
      res.json({ ok: false, message: (e as Error).message });
    }
  });

  return r;
}
