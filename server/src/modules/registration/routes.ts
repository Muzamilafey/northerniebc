import { Router } from 'express';
import { z } from 'zod';
import { env, isProd } from '../../config/env.js';
import { withTransaction } from '../../db/mongo.js';
import { recordAudit, recordAuditStandalone } from '../../lib/audit.js';
import { blindIndex, decrypt, encrypt, randomToken, sha256 } from '../../lib/crypto.js';
import { badRequest, notFound, serviceUnavailable, unprocessable } from '../../lib/errors.js';
import { shortCode } from '../../lib/ids.js';
import { parse } from '../../lib/http.js';
import { ipHash, limiter } from '../../middleware/security.js';
import { AgentRegistration, User } from '../../models/index.js';
import { checkPinById, KraError, kraConfigured, maskName } from '../../integrations/kra.js';
import { hashPassword, passwordProblems } from '../auth/password.js';
import { enqueueEmail, getTransport } from '../notifications/service.js';
import { settingBool } from '../settings/service.js';
import { kenyanPhone } from '../users/routes.js';

const LINK_TTL_MS = 24 * 3600_000;
const GENERIC = 'If the details can be verified, a confirmation link has been sent to that email address. It expires in 24 hours.';

export const registrationOpen = () => settingBool('AGENT_SELF_REGISTRATION') && kraConfigured();

/**
 * Open agent self-registration. The applicant gives only their national ID number and email;
 * their name and KRA PIN come from the KRA PIN Checker and are locked. To avoid turning this into
 * a public ID-to-name lookup, responses never contain the name or PIN; the emailed link shows
 * only a masked name, and lookups are tightly rate-limited per IP and per ID number.
 * Registered agents still need administrator approval before they can count.
 */
export function registrationRouter() {
  const r = Router();

  r.get('/config', (_req, res) => {
    res.json({ open: registrationOpen(), selfRegistrationEnabled: settingBool('AGENT_SELF_REGISTRATION'), kraConfigured: kraConfigured() });
  });

  r.post('/start', limiter('agent-registration', { windowMs: 60 * 60_000, limit: env.AGENT_REGISTRATIONS_PER_HOUR }), async (req, res) => {
    if (!registrationOpen()) throw serviceUnavailable('Agent registration is not open');
    const body = parse(
      z.object({
        idNumber: z.string().trim().regex(/^\d{6,9}$/, 'Enter your national ID number (digits only)'),
        email: z.string().trim().email().max(200),
        phone: kenyanPhone.optional(),
        consent: z.literal(true),
        website: z.string().max(0).optional()
      }),
      req.body
    );
    const idx = blindIndex(body.idNumber);
    // Per-ID limit stops repeated lookups of the same person.
    if ((await AgentRegistration.countDocuments({ nationalIdIndex: idx, createdAt: { $gt: new Date(Date.now() - 24 * 3600_000) } })) >= 3) {
      return res.status(202).json({ message: GENERIC });
    }
    const [existingId, existingEmail] = await Promise.all([User.exists({ 'identity.nationalIdIndex': idx }), User.exists({ email: body.email.toLowerCase() })]);
    if (existingId || existingEmail) return res.status(202).json({ message: GENERIC });

    let kra;
    try {
      kra = await checkPinById(body.idNumber, 'KE');
    } catch (e) {
      if (e instanceof KraError && e.kind === 'INVALID_ID') throw unprocessable('This ID number could not be verified with KRA. Check it and try again.');
      throw serviceUnavailable('Identity verification is temporarily unavailable. Try again later.');
    }
    const token = randomToken(32);
    await AgentRegistration.create({
      nationalIdIndex: idx,
      nationalIdEnc: encrypt(body.idNumber),
      kraPinEnc: encrypt(kra.pin),
      kraNameEnc: encrypt(kra.name),
      email: body.email,
      phoneEnc: body.phone ? encrypt(body.phone) : undefined,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + LINK_TTL_MS),
      ipHash: ipHash(req)
    });
    const url = `${env.PUBLIC_BASE_URL}/register/confirm?token=${token}`;
    await enqueueEmail(body.email, 'Confirm your Northern IEBC agent registration', [
      `An agent registration was started for ${maskName(kra.name)} using this email address.`,
      `If this is you, open this link within 24 hours to set your password:`,
      url,
      '',
      'Your account will then be reviewed by an administrator before you can count or submit results.',
      'If you did not request this, ignore this email.'
    ].join('\n'));
    await recordAuditStandalone({ actor: { label: 'public:agent-registration', ip: req.ip }, action: 'agent_registration.started', entityType: 'AgentRegistration', entityId: idx.slice(0, 16), meta: { kraVerified: true } });
    // Development convenience only: without SMTP the link cannot be emailed.
    res.status(202).json({ message: GENERIC, ...(!isProd && !getTransport() ? { devConfirmUrl: url } : {}) });
  });

  r.get('/confirm', async (req, res) => {
    const { token } = parse(z.object({ token: z.string().min(20).max(100) }).passthrough(), req.query);
    const reg = await AgentRegistration.findOne({ tokenHash: sha256(token), status: 'AWAITING_EMAIL', expiresAt: { $gt: new Date() } }).lean();
    if (!reg) throw notFound('This link is invalid or has expired');
    res.json({ maskedName: maskName(decrypt(reg.kraNameEnc)), email: reg.email, note: 'Your name and KRA PIN come from KRA records and cannot be changed.' });
  });

  r.post('/complete', limiter('agent-registration-complete', { windowMs: 60 * 60_000, limit: 20 }), async (req, res) => {
    const body = parse(z.object({ token: z.string().min(20).max(100), password: z.string().min(1).max(256) }), req.body);
    const reg = await AgentRegistration.findOne({ tokenHash: sha256(body.token), status: 'AWAITING_EMAIL', expiresAt: { $gt: new Date() } });
    if (!reg) throw notFound('This link is invalid or has expired');
    const name = decrypt(reg.kraNameEnc);
    const problems = passwordProblems(body.password, [...name.split(' '), reg.email.split('@')[0]!]);
    if (problems.length) throw badRequest('Weak password', problems);
    if (await User.exists({ $or: [{ email: reg.email }, { 'identity.nationalIdIndex': reg.nationalIdIndex }] })) throw badRequest('An account already exists for these details');
    const passwordHash = await hashPassword(body.password);
    const user = await withTransaction(async (s) => {
      const [u] = await User.create(
        [
          {
            fullName: name,
            email: reg.email,
            emailVerified: true,
            phoneEnc: reg.phoneEnc,
            passwordHash,
            role: 'AGENT',
            agentCode: `AGT-${shortCode(8)}`,
            mustChangePassword: false,
            identity: { source: 'KRA_PIN_CHECKER', locked: true, nationalIdEnc: reg.nationalIdEnc, nationalIdIndex: reg.nationalIdIndex, kraPinEnc: reg.kraPinEnc, verifiedAt: reg.createdAt },
            vetting: { status: 'PENDING', identityChecked: false, note: 'Self-registered; name and KRA PIN from KRA PIN Checker' }
          }
        ],
        { session: s }
      );
      reg.status = 'COMPLETED';
      reg.userId = u!._id;
      await reg.save({ session: s });
      await recordAudit(s, { actor: { id: String(u!._id), role: 'AGENT', label: 'self-registration', ip: req.ip }, action: 'agent.self_registered', entityType: 'User', entityId: String(u!._id), after: { identitySource: 'KRA_PIN_CHECKER', vetting: 'PENDING' } });
      return u!;
    });
    res.status(201).json({ agentCode: user.agentCode, message: 'Registration complete. An administrator must approve your account before you can count or submit results. Sign in with your email or agent ID.' });
  });

  return r;
}
