import type { ClientSession } from 'mongoose';
import { AuditChainHead, AuditEvent } from '../models/system.js';
import { canonicalJson, sha256 } from './crypto.js';
import { withTransaction } from '../db/mongo.js';

export interface Actor {
  id?: string;
  role?: string;
  label?: string;
  ip?: string;
}

export interface AuditInput {
  actor: Actor;
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  meta?: unknown;
}

const GENESIS = '0'.repeat(64);
const HEAD_ID = 'main';

export function hashAuditEvent(e: {
  seq: number;
  at: Date;
  actorId?: unknown;
  actorRole?: string;
  action: string;
  entityType: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  meta?: unknown;
  prevHash: string;
}): string {
  return sha256(
    canonicalJson({
      seq: e.seq,
      at: e.at,
      actorId: e.actorId ? String(e.actorId) : null,
      actorRole: e.actorRole ?? null,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId ?? null,
      before: e.before ?? null,
      after: e.after ?? null,
      meta: e.meta ?? null,
      prevHash: e.prevHash
    })
  );
}

/** Strips values that must not be persisted in audit records (secrets, raw contact data). */
function scrub(value: unknown): unknown {
  if (value == null) return value;
  const json = JSON.parse(JSON.stringify(value)) as unknown;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (/password|secret|token|Enc$|mfa|recovery/i.test(k)) continue;
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(json);
}

/**
 * Appends a hash-chained audit event inside the caller's transaction. Concurrent writers
 * conflict on the chain head, and the transaction helper retries, preserving a linear chain.
 */
export async function recordAudit(session: ClientSession, input: AuditInput): Promise<void> {
  const head = await AuditChainHead.findById(HEAD_ID).session(session).lean();
  const prevHash = head?.hash ?? GENESIS;
  const seq = (head?.seq ?? 0) + 1;
  const at = new Date();
  const doc = {
    seq,
    at,
    actorId: input.actor.id,
    actorRole: input.actor.role,
    actorLabel: input.actor.label,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    before: scrub(input.before),
    after: scrub(input.after),
    meta: scrub(input.meta),
    ip: input.actor.ip,
    prevHash
  };
  const hash = hashAuditEvent(doc);
  if (head) {
    const r = await AuditChainHead.updateOne({ _id: HEAD_ID, seq: head.seq }, { $set: { seq, hash } }, { session });
    if (r.modifiedCount !== 1) throw Object.assign(new Error('Audit chain head moved'), { errorLabels: ['TransientTransactionError'] });
  } else {
    await AuditChainHead.create([{ _id: HEAD_ID, seq, hash }], { session });
  }
  await AuditEvent.create([{ ...doc, hash }], { session });
}

/** Records an audit event in its own transaction (for events with no other write). */
export async function recordAuditStandalone(input: AuditInput): Promise<void> {
  await withTransaction((s) => recordAudit(s, input));
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  firstBrokenSeq?: number;
  reason?: string;
}

export async function verifyAuditChain(): Promise<ChainVerification> {
  let prevHash = GENESIS;
  let expectedSeq = 1;
  let checked = 0;
  const cursor = AuditEvent.find().sort({ seq: 1 }).lean().cursor();
  for await (const e of cursor) {
    if (e.seq !== expectedSeq) return { ok: false, checked, firstBrokenSeq: expectedSeq, reason: 'Missing sequence number' };
    if (e.prevHash !== prevHash) return { ok: false, checked, firstBrokenSeq: e.seq, reason: 'prevHash mismatch' };
    const recomputed = hashAuditEvent({ ...e, entityId: e.entityId ?? undefined, actorRole: e.actorRole ?? undefined });
    if (recomputed !== e.hash) return { ok: false, checked, firstBrokenSeq: e.seq, reason: 'Content hash mismatch' };
    prevHash = e.hash;
    expectedSeq++;
    checked++;
  }
  const head = await AuditChainHead.findById(HEAD_ID).lean();
  if (head && (head.seq !== checked || head.hash !== prevHash)) {
    return { ok: false, checked, reason: 'Chain head does not match last event (possible truncation)' };
  }
  return { ok: true, checked };
}
