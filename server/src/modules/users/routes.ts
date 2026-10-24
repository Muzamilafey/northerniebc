import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { withTransaction } from '../../db/mongo.js';
import { recordAudit } from '../../lib/audit.js';
import { decryptOptional, encrypt, maskPhone, randomToken } from '../../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { shortCode } from '../../lib/ids.js';
import { escapeRegex, pageParams, parse } from '../../lib/http.js';
import { canAssignRole, inScope, scopeFilter } from '../../lib/permissions.js';
import { requirePermission } from '../../middleware/auth.js';
import { AgentAssignment, Constituency, PollingStation, ROLES, User, Election, County } from '../../models/index.js';
import { hashPassword } from '../auth/password.js';
import { revokeAllSessions } from '../auth/service.js';
import type { AuthUser } from '../../types/express.js';

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const kenyanPhone = z
  .string()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .refine((v) => /^(\+?254|0)(7|1)\d{8}$/.test(v), 'Enter a valid Kenyan mobile number')
  .transform((v) => '254' + v.replace(/^(\+?254|0)/, ''));

export { objectId, kenyanPhone };

const actorOf = (u: AuthUser, ip?: string) => ({ id: u.id, role: u.role, label: u.fullName, ip });

function sanitizeUser(u: Record<string, unknown> & { phoneEnc?: string | null }) {
  const { phoneEnc, passwordHash: _p, resetTokenHash: _r, ...rest } = u as Record<string, unknown> & { phoneEnc?: string | null };
  const mfa = (rest.mfa as { enabled?: boolean } | undefined) ?? {};
  return { ...rest, mfa: { enabled: Boolean(mfa.enabled) }, phoneMasked: maskPhone(decryptOptional(phoneEnc)) };
}

/** Whether `actor` may manage `target` given geographic scope. */
async function canManageUser(actor: AuthUser, target: { _id: unknown; role: string; scope?: { countyIds?: unknown[]; constituencyIds?: unknown[] } | null }) {
  if (actor.role === 'SUPER_ADMIN') return true;
  if (!canAssignRole(actor, target.role as never)) return false;
  if (actor.role === 'REGIONAL_ADMIN') return true;
  if (target.role === 'AGENT') {
    const assignments = await AgentAssignment.find({ userId: target._id, active: true }).lean();
    if (assignments.length === 0) return true; // unassigned agents can be managed by any scoped admin who may create agents
    return assignments.every((a) => inScope(actor, a));
  }
  const counties = (target.scope?.countyIds ?? []).map(String);
  const consts = (target.scope?.constituencyIds ?? []).map(String);
  if (actor.role === 'COUNTY_ADMIN') {
    if (counties.length === 0 && consts.length === 0) return false;
    if (!counties.every((c) => actor.scope.countyIds.includes(c))) return false;
    const cs = await Constituency.find({ _id: { $in: consts } }).lean();
    return cs.every((c) => actor.scope.countyIds.includes(String(c.countyId)));
  }
  return false;
}

const scopeSchema = z.object({ countyIds: z.array(objectId).max(5).default([]), constituencyIds: z.array(objectId).max(50).default([]) });

async function validateScopeForRole(actor: AuthUser, role: string, scope: { countyIds: string[]; constituencyIds: string[] }) {
  if (role === 'COUNTY_ADMIN' && scope.countyIds.length === 0) throw badRequest('County administrators need at least one county');
  if (role === 'CONSTITUENCY_SUPERVISOR' && scope.constituencyIds.length === 0) throw badRequest('Constituency supervisors need at least one constituency');
  if (scope.countyIds.length && (await County.countDocuments({ _id: { $in: scope.countyIds } })) !== scope.countyIds.length) throw badRequest('Unknown county in scope');
  const cs = scope.constituencyIds.length ? await Constituency.find({ _id: { $in: scope.constituencyIds } }).lean() : [];
  if (cs.length !== scope.constituencyIds.length) throw badRequest('Unknown constituency in scope');
  if (actor.role === 'COUNTY_ADMIN') {
    if (!scope.countyIds.every((c) => actor.scope.countyIds.includes(c))) throw forbidden('Scope outside your counties');
    if (!cs.every((c) => actor.scope.countyIds.includes(String(c.countyId)))) throw forbidden('Scope outside your counties');
  }
}

export function usersRouter() {
  const r = Router();
  const canManage = requirePermission('users.manage', 'agents.manage');

  r.get('/users', canManage, async (req, res) => {
    const q = parse(z.object({ role: z.enum(ROLES).optional(), status: z.enum(['ACTIVE', 'SUSPENDED', 'REVOKED']).optional(), q: z.string().max(100).optional() }).passthrough(), req.query);
    const { page, limit, skip } = pageParams(req.query);
    const actor = req.user!;
    const filter: Record<string, unknown> = {};
    if (q.role) filter.role = q.role;
    if (q.status) filter.status = q.status;
    if (q.q) filter.$or = [{ fullName: new RegExp(escapeRegex(q.q), 'i') }, { email: new RegExp(escapeRegex(q.q), 'i') }, { agentCode: q.q.toUpperCase() }];
    if (actor.role === 'COUNTY_ADMIN' || actor.role === 'CONSTITUENCY_SUPERVISOR') {
      const scopeKey = actor.role === 'COUNTY_ADMIN' ? 'countyId' : 'constituencyId';
      const ids = actor.role === 'COUNTY_ADMIN' ? actor.scope.countyIds : actor.scope.constituencyIds;
      const agentIds = await AgentAssignment.distinct('userId', { active: true, [scopeKey]: { $in: ids } });
      const createdIds = await User.distinct('_id', { createdBy: actor.id, role: 'AGENT' });
      filter.$and = [
        {
          $or: [
            { _id: { $in: [...agentIds, ...createdIds] } },
            ...(actor.role === 'COUNTY_ADMIN'
              ? [{ role: 'CONSTITUENCY_SUPERVISOR', 'scope.countyIds': { $in: ids } }]
              : [])
          ]
        }
      ];
    }
    const [items, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      User.countDocuments(filter)
    ]);
    res.json({ items: items.map(sanitizeUser), total, page, limit });
  });

  r.post('/users', canManage, async (req, res) => {
    const actor = req.user!;
    const body = parse(
      z.object({
        fullName: z.string().min(3).max(200),
        email: z.string().email().max(200),
        phone: kenyanPhone.optional(),
        role: z.enum(ROLES),
        scope: scopeSchema.default({ countyIds: [], constituencyIds: [] })
      }),
      req.body
    );
    if (!canAssignRole(actor, body.role)) throw forbidden('You cannot create users with this role');
    await validateScopeForRole(actor, body.role, body.scope);
    if (await User.exists({ email: body.email.toLowerCase() })) throw conflict('A user with this email already exists');
    const temporaryPassword = `${randomToken(9)}-${randomToken(6)}`;
    const passwordHash = await hashPassword(temporaryPassword);
    const user = await withTransaction(async (s) => {
      const [u] = await User.create(
        [
          {
            fullName: body.fullName,
            email: body.email,
            phoneEnc: body.phone ? encrypt(body.phone) : undefined,
            passwordHash,
            role: body.role,
            agentCode: body.role === 'AGENT' ? `AGT-${shortCode(8)}` : undefined,
            scope: body.scope,
            mustChangePassword: true,
            createdBy: actor.id
          }
        ],
        { session: s }
      );
      await recordAudit(s, { actor: actorOf(actor, req.ip), action: 'user.created', entityType: 'User', entityId: String(u!._id), after: { role: body.role, scope: body.scope, email: body.email } });
      return u!;
    });
    res.status(201).json({ user: sanitizeUser(user.toObject()), temporaryPassword, note: 'Share the temporary password through a secure channel. It is shown only once.' });
  });

  r.patch('/users/:id', canManage, async (req, res) => {
    const actor = req.user!;
    const body = parse(
      z.object({ fullName: z.string().min(3).max(200).optional(), phone: kenyanPhone.optional(), role: z.enum(ROLES).optional(), scope: scopeSchema.optional() }),
      req.body
    );
    const target = await User.findById(String(req.params.id));
    if (!target) throw notFound();
    if (String(target._id) === actor.id && (body.role || body.scope)) throw forbidden('You cannot change your own role or scope');
    if (!(await canManageUser(actor, target))) throw forbidden();
    const newRole = body.role ?? target.role;
    if (body.role && !canAssignRole(actor, body.role)) throw forbidden('You cannot assign this role');
    const newScope = body.scope ?? { countyIds: target.scope?.countyIds?.map(String) ?? [], constituencyIds: target.scope?.constituencyIds?.map(String) ?? [] };
    await validateScopeForRole(actor, newRole, newScope);
    const before = { role: target.role, scope: target.scope, fullName: target.fullName };
    await withTransaction(async (s) => {
      if (body.fullName) target.fullName = body.fullName;
      if (body.phone) target.phoneEnc = encrypt(body.phone);
      if (body.role) {
        target.role = body.role;
        if (body.role !== 'AGENT') target.agentCode = undefined;
        else target.agentCode ??= `AGT-${shortCode(8)}`;
      }
      if (body.scope) target.set('scope', body.scope);
      await target.save({ session: s });
      await recordAudit(s, {
        actor: actorOf(actor, req.ip),
        action: body.role && body.role !== before.role ? 'user.role_changed' : 'user.updated',
        entityType: 'User',
        entityId: String(target._id),
        before,
        after: { role: target.role, scope: target.scope, fullName: target.fullName }
      });
    });
    if (body.role || body.scope) await revokeAllSessions(String(target._id), 'role_or_scope_changed');
    res.json({ user: sanitizeUser(target.toObject()) });
  });

  const statusAction = (action: 'suspend' | 'reactivate' | 'revoke') =>
    r.post(`/users/:id/${action}`, canManage, async (req, res) => {
      const actor = req.user!;
      const { reason } = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
      const target = await User.findById(String(req.params.id));
      if (!target) throw notFound();
      if (String(target._id) === actor.id) throw forbidden('You cannot change your own account status');
      if (!(await canManageUser(actor, target))) throw forbidden();
      if (target.status === 'REVOKED') throw conflict('Revoked accounts cannot be changed');
      const before = target.status;
      const status = action === 'suspend' ? 'SUSPENDED' : action === 'reactivate' ? 'ACTIVE' : 'REVOKED';
      await withTransaction(async (s) => {
        target.status = status;
        await target.save({ session: s });
        if (status === 'REVOKED') {
          await AgentAssignment.updateMany({ userId: target._id, active: true }, { $set: { active: false, revokedAt: new Date(), revokedBy: actor.id, revokeReason: 'account_revoked' } }, { session: s });
        }
        await recordAudit(s, { actor: actorOf(actor, req.ip), action: `user.${action}`, entityType: 'User', entityId: String(target._id), before: { status: before }, after: { status }, meta: { reason } });
      });
      if (status !== 'ACTIVE') await revokeAllSessions(String(target._id), `account_${action}`);
      res.json({ status });
    });
  statusAction('suspend');
  statusAction('reactivate');
  statusAction('revoke');

  r.post('/users/:id/revoke-sessions', canManage, async (req, res) => {
    const target = await User.findById(String(req.params.id));
    if (!target) throw notFound();
    if (!(await canManageUser(req.user!, target))) throw forbidden();
    await withTransaction(async (s) => {
      await recordAudit(s, { actor: actorOf(req.user!, req.ip), action: 'user.sessions_revoked', entityType: 'User', entityId: String(target._id) });
    });
    await revokeAllSessions(String(target._id), 'admin_revoked');
    res.status(204).end();
  });

  r.post('/users/:id/reset-password', canManage, async (req, res) => {
    const target = await User.findById(String(req.params.id));
    if (!target) throw notFound();
    if (!(await canManageUser(req.user!, target))) throw forbidden();
    const temporaryPassword = `${randomToken(9)}-${randomToken(6)}`;
    target.passwordHash = await hashPassword(temporaryPassword);
    target.mustChangePassword = true;
    await withTransaction(async (s) => {
      await target.save({ session: s });
      await recordAudit(s, { actor: actorOf(req.user!, req.ip), action: 'user.password_reset_by_admin', entityType: 'User', entityId: String(target._id) });
    });
    await revokeAllSessions(String(target._id), 'admin_password_reset');
    res.json({ temporaryPassword });
  });

  r.post('/users/:id/reset-mfa', requirePermission('users.manage_privileged'), async (req, res) => {
    const target = await User.findById(String(req.params.id));
    if (!target) throw notFound();
    await withTransaction(async (s) => {
      await User.updateOne({ _id: target._id }, { $set: { 'mfa.enabled': false }, $unset: { 'mfa.secretEnc': 1, 'mfa.recoveryCodeHashes': 1 } }, { session: s });
      await recordAudit(s, { actor: actorOf(req.user!, req.ip), action: 'user.mfa_reset', entityType: 'User', entityId: String(target._id) });
    });
    await revokeAllSessions(String(target._id), 'mfa_reset');
    res.status(204).end();
  });

  // ---- Agent assignments ----
  r.get('/assignments', requirePermission('agents.manage', 'results.monitor'), async (req, res) => {
    const q = parse(z.object({ electionId: objectId.optional(), pollingStationId: objectId.optional(), userId: objectId.optional(), active: z.enum(['true', 'false']).optional() }).passthrough(), req.query);
    const actor = req.user!;
    const filter: Record<string, unknown> = {};
    if (q.electionId) filter.electionId = q.electionId;
    if (q.pollingStationId) filter.pollingStationId = q.pollingStationId;
    if (q.userId) filter.userId = q.userId;
    filter.active = q.active !== 'false';
    const { page, limit, skip } = pageParams(req.query, 200);
    const scoped = { ...filter, ...scopeFilter(actor) };
    const [items, total] = await Promise.all([
      AgentAssignment.find(scoped).populate('userId', 'fullName agentCode status lastLoginAt').populate('pollingStationId', 'code name').sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AgentAssignment.countDocuments(scoped)
    ]);
    res.json({ items, total, page, limit });
  });

  r.post('/assignments', requirePermission('agents.manage'), async (req, res) => {
    const actor = req.user!;
    const body = parse(z.object({ userId: objectId, electionId: objectId, pollingStationId: objectId, replaceExisting: z.boolean().default(false) }), req.body);
    const [agent, station, election] = await Promise.all([
      User.findById(body.userId).lean(),
      PollingStation.findById(body.pollingStationId).lean(),
      Election.findById(body.electionId).lean()
    ]);
    if (!agent || agent.role !== 'AGENT') throw badRequest('User is not an agent');
    if (agent.status !== 'ACTIVE') throw badRequest('Agent account is not active');
    if (!station || String(station.electionId) !== body.electionId) throw badRequest('Polling station does not belong to this election');
    if (!election || election.status === 'ARCHIVED') throw badRequest('Election not available');
    if (!inScope(actor, station)) throw forbidden('Station is outside your scope');
    const assignment = await withTransaction(async (s) => {
      if (body.replaceExisting) {
        const prev = await AgentAssignment.find({ userId: body.userId, electionId: body.electionId, active: true }).session(s);
        for (const p of prev) {
          if (!inScope(actor, p)) throw forbidden('Existing assignment is outside your scope');
          p.active = false;
          p.revokedAt = new Date();
          p.revokedBy = new Types.ObjectId(actor.id);
          p.revokeReason = 'reassigned';
          await p.save({ session: s });
          await recordAudit(s, { actor: actorOf(actor, req.ip), action: 'assignment.revoked', entityType: 'AgentAssignment', entityId: String(p._id), meta: { reason: 'reassigned' } });
        }
      }
      const [a] = await AgentAssignment.create(
        [{ userId: body.userId, electionId: body.electionId, pollingStationId: station._id, countyId: station.countyId, constituencyId: station.constituencyId, wardId: station.wardId, assignedBy: actor.id }],
        { session: s }
      );
      await recordAudit(s, { actor: actorOf(actor, req.ip), action: 'assignment.created', entityType: 'AgentAssignment', entityId: String(a!._id), after: { userId: body.userId, pollingStationId: body.pollingStationId, electionId: body.electionId } });
      return a!;
    });
    res.status(201).json({ assignment });
  });

  r.post('/assignments/:id/revoke', requirePermission('agents.manage'), async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
    const a = await AgentAssignment.findById(String(req.params.id));
    if (!a || !a.active) throw notFound();
    if (!inScope(req.user!, a)) throw forbidden();
    await withTransaction(async (s) => {
      a.active = false;
      a.revokedAt = new Date();
      a.revokedBy = new Types.ObjectId(req.user!.id);
      a.revokeReason = reason;
      await a.save({ session: s });
      await recordAudit(s, { actor: actorOf(req.user!, req.ip), action: 'assignment.revoked', entityType: 'AgentAssignment', entityId: String(a._id), meta: { reason } });
    });
    res.status(204).end();
  });

  return r;
}
