import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { withTransaction } from '../../db/mongo.js';
import { recordAudit } from '../../lib/audit.js';
import { canonicalJson, sha256 } from '../../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { AgentAssignment, CountSession, Election, PollingStation, TallyEvent, User, type Position } from '../../models/index.js';
import type { AuthUser } from '../../types/express.js';
import { eligibleCandidates } from '../elections/service.js';
import { intakeState } from '../elections/intake.js';

export interface TallyEventInput {
  seq: number;
  kind: 'INCREMENT' | 'UNDO' | 'SET';
  candidateId: string;
  undoOfSeq?: number;
  value?: number;
  reasonCode?: 'ACCIDENTAL_TAP' | 'WRONG_CANDIDATE' | 'DOUBLE_COUNTED' | 'OTHER';
  reason?: string;
  clientAt?: Date;
}

/** Agents must be vetted (approved by an administrator) before they can count or submit. */
export async function assertVettedAgent(agent: AuthUser) {
  if (agent.role !== 'AGENT') throw forbidden('Only polling-station agents can do this');
  const u = await User.findById(agent.id).select('vetting').lean();
  if (u?.vetting?.status !== 'APPROVED') {
    throw forbidden(u?.vetting?.status === 'REJECTED' ? 'Your agent account was not approved' : 'Your agent account is awaiting approval by an administrator');
  }
}

/** Password re-confirmation window for result submission (the "+" button can never submit). */
export async function assertRecentStepUp(agent: AuthUser) {
  if (!env.REQUIRE_SUBMIT_REAUTH) return;
  const { Session } = await import('../../models/identity.js');
  const s = await Session.findOne({ familyId: agent.sessionId }).select('stepUpUntil').lean();
  if (!s?.stepUpUntil || s.stepUpUntil < new Date()) {
    throw Object.assign(forbidden('Confirm your password to submit this result'), { code: 'STEP_UP_REQUIRED' });
  }
}

const hashEvent = (prevHash: string, e: Record<string, unknown>) => sha256(`${prevHash}|${canonicalJson(e)}`);

/**
 * Records counting taps as they happen. Each event is appended to a per-session hash chain.
 * Events must arrive in sequence (the client resends from the expected seq on a gap), so the log
 * is complete and ordered. Implausibly fast tapping is flagged, or refused when absurd.
 */
export async function recordTallyEvents(
  agent: AuthUser,
  input: { clientSessionId: string; electionId: string; pollingStationId: string; position: Position; events: TallyEventInput[] },
  ip?: string
) {
  await assertVettedAgent(agent);
  const assignment = await AgentAssignment.findOne({ userId: agent.id, electionId: input.electionId, pollingStationId: input.pollingStationId, active: true }).lean();
  if (!assignment) throw forbidden('You are not assigned to this polling station');
  const [election, station] = await Promise.all([Election.findById(input.electionId).lean(), PollingStation.findById(input.pollingStationId).lean()]);
  if (!election || election.status !== 'ACTIVE') throw unprocessable('This election is not accepting counts');
  const intake = intakeState(election);
  if (!intake.open) throw unprocessable(intake.message);
  if (!election.positions.some((p) => p.position === input.position && p.enabled)) throw unprocessable('Position not enabled');
  const ballot = new Set((await eligibleCandidates(station!, input.position)).map((c) => String(c._id)));

  return withTransaction(async (s) => {
    let session = await CountSession.findOne({ clientSessionId: input.clientSessionId }).session(s);
    if (!session) {
      [session] = await CountSession.create(
        [{ clientSessionId: input.clientSessionId, electionId: input.electionId, pollingStationId: input.pollingStationId, countyId: station!.countyId, position: input.position, agentId: agent.id, tallies: Object.fromEntries([...ballot].map((id) => [id, 0])) }],
        { session: s }
      );
      await recordAudit(s, { actor: { id: agent.id, role: agent.role, label: agent.fullName, ip }, action: 'count.session_started', entityType: 'CountSession', entityId: input.clientSessionId, meta: { pollingStationId: input.pollingStationId, position: input.position } });
    }
    const sess = session!;
    if (String(sess.agentId) !== agent.id || String(sess.pollingStationId) !== input.pollingStationId || sess.position !== input.position) throw forbidden('Session does not belong to you or this ballot');
    if (sess.status !== 'OPEN') throw conflict('This counting session was already used for a submission; start a new count', { status: sess.status });

    const accepted: number[] = [];
    for (const e of [...input.events].sort((a, b) => a.seq - b.seq)) {
      if (e.seq <= sess.lastSeq) {
        const existing = await TallyEvent.findOne({ sessionId: sess._id, seq: e.seq }).session(s).lean();
        if (existing && (existing.kind !== e.kind || String(existing.candidateId) !== e.candidateId)) throw conflict('Event sequence number reused with different content', { expectedSeq: sess.lastSeq + 1 });
        continue; // duplicate delivery of an already-recorded tap
      }
      if (e.seq !== sess.lastSeq + 1) throw conflict('Missing counting events; resend from the expected sequence number', { expectedSeq: sess.lastSeq + 1 });
      if (!ballot.has(e.candidateId)) throw badRequest('Candidate is not on the ballot for this station');

      const now = new Date();
      const flags: string[] = [];
      const tallies = sess.tallies as unknown as Map<string, number>;
      const current = tallies.get(e.candidateId) ?? 0;
      let undoTarget = null;
      if (e.kind === 'INCREMENT') {
        // Rate check over the last second of server-received taps.
        const recent = await TallyEvent.countDocuments({ sessionId: sess._id, kind: 'INCREMENT', serverAt: { $gt: new Date(now.getTime() - 1000) } }).session(s);
        if (recent + 1 > env.HARD_MAX_TAPS_PER_SECOND) throw Object.assign(unprocessable('Taps are arriving faster than votes can be counted by hand; slow down'), { code: 'TAP_RATE_EXCEEDED' });
        if (recent + 1 > env.MAX_TAPS_PER_SECOND) flags.push('FAST_TAPPING');
        const total = [...tallies.values()].reduce((a, b) => a + b, 0);
        if (station!.registeredVoters != null && total + 1 > station!.registeredVoters) flags.push('EXCEEDS_REGISTERED_VOTERS');
        tallies.set(e.candidateId, current + 1);
        sess.increments += 1;
      } else if (e.kind === 'UNDO') {
        if (!e.reasonCode) throw badRequest('Give a reason for the undo');
        if (e.reasonCode === 'OTHER' && (!e.reason || e.reason.trim().length < 3)) throw badRequest('Explain the reason for the undo');
        undoTarget = await TallyEvent.findOne({ sessionId: sess._id, kind: 'INCREMENT', undone: false }).sort({ seq: -1 }).session(s);
        if (!undoTarget || undoTarget.seq !== e.undoOfSeq) throw conflict('Only the most recent addition can be undone', { latestUndoableSeq: undoTarget?.seq ?? null });
        if (String(undoTarget.candidateId) !== e.candidateId) throw badRequest('Undo must name the same candidate as the addition it reverses');
        tallies.set(e.candidateId, Math.max(0, current - 1));
        undoTarget.undone = true;
        await undoTarget.save({ session: s });
        sess.undos += 1;
      } else {
        if (e.value == null || !Number.isInteger(e.value) || e.value < 0) throw badRequest('Manual entry needs a whole number');
        if (!e.reason || e.reason.trim().length < 3) throw badRequest('Give a reason for the manual entry (e.g. "transcribed from Form 34A")');
        tallies.set(e.candidateId, e.value);
        sess.manualSets += 1;
        flags.push('MANUAL_ENTRY');
      }
      const body = { seq: e.seq, kind: e.kind, candidateId: e.candidateId, undoOfSeq: e.undoOfSeq ?? null, value: e.value ?? null, reasonCode: e.reasonCode ?? null, reason: e.reason ?? null, serverAt: now.toISOString() };
      const hash = hashEvent(sess.lastHash, body);
      await TallyEvent.create([{ sessionId: sess._id, ...body, candidateId: new Types.ObjectId(e.candidateId), clientAt: e.clientAt, serverAt: now, flags, prevHash: sess.lastHash, hash }], { session: s });
      for (const f of flags) if (!sess.flags.includes(f)) sess.flags.push(f);
      sess.lastSeq = e.seq;
      sess.lastHash = hash;
      sess.lastEventAt = now;
      accepted.push(e.seq);
      if (e.kind !== 'INCREMENT') {
        await recordAudit(s, { actor: { id: agent.id, role: agent.role, label: agent.fullName, ip }, action: e.kind === 'UNDO' ? 'count.undo' : 'count.manual_entry', entityType: 'CountSession', entityId: input.clientSessionId, meta: { seq: e.seq, candidateId: e.candidateId, reasonCode: e.reasonCode, reason: e.reason, value: e.value, undoOfSeq: e.undoOfSeq } });
      }
    }
    sess.markModified('tallies');
    await sess.save({ session: s });
    return { clientSessionId: sess.clientSessionId, lastSeq: sess.lastSeq, accepted, tallies: Object.fromEntries(sess.tallies as unknown as Map<string, number>), flags: sess.flags };
  });
}

/** Compares a submission against its counting session; differences become reviewer flags. */
export async function sessionChecks(clientSessionId: string | undefined, agentId: string, candidateVotes: { candidateId: string; votes: number }[]) {
  if (!clientSessionId) return { issues: [{ rule: 'NO_LIVE_COUNT', message: 'No live tap-by-tap count was recorded for this result' }], session: null };
  const sess = await CountSession.findOne({ clientSessionId }).lean();
  if (!sess || String(sess.agentId) !== agentId) throw badRequest('Unknown counting session');
  if (sess.status !== 'OPEN') throw conflict('This counting session was already used for a submission');
  const tallies = sess.tallies as unknown as Record<string, number>;
  const issues: { rule: string; message: string }[] = [];
  const diffs = candidateVotes.filter((c) => (tallies[c.candidateId] ?? 0) !== c.votes);
  if (diffs.length) issues.push({ rule: 'TALLY_LOG_MISMATCH', message: `Submitted figures differ from the live tap count for ${diffs.length} candidate(s)` });
  for (const f of sess.flags ?? []) {
    if (f === 'FAST_TAPPING') issues.push({ rule: 'FAST_TAPPING', message: 'Some taps were faster than plausible for manual counting' });
    if (f === 'EXCEEDS_REGISTERED_VOTERS') issues.push({ rule: 'EXCEEDS_REGISTERED_VOTERS', message: 'The live count went above the station’s registered voters' });
  }
  if ((sess.undos ?? 0) > 0) issues.push({ rule: 'UNDOS_RECORDED', message: `${sess.undos} undo(s) recorded with reasons during counting` });
  return { issues, session: sess };
}

export async function getCountSession(agent: AuthUser, clientSessionId: string) {
  const sess = await CountSession.findOne({ clientSessionId }).lean();
  if (!sess) throw notFound();
  if (String(sess.agentId) !== agent.id) throw forbidden();
  return sess;
}
