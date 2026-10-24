import type { ClientSession } from 'mongoose';
import mongoose from 'mongoose';
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

interface Content {
  at: Date;
  actorId?: unknown;
  actorRole?: string | null;
  actorLabel?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: unknown;
  ip?: string | null;
}

export function contentHashOf(e: Content): string {
  return sha256(
    canonicalJson({
      at: e.at,
      actorId: e.actorId ? String(e.actorId) : null,
      actorRole: e.actorRole ?? null,
      actorLabel: e.actorLabel ?? null,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId ?? null,
      before: e.before ?? null,
      after: e.after ?? null,
      meta: e.meta ?? null,
      ip: e.ip ?? null
    })
  );
}

export const chainHashOf = (contentHash: string, seq: number, prevHash: string) => sha256(`${seq}|${prevHash}|${contentHash}`);

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

/** Writes an audit event inside the caller's transaction (sealed into the chain shortly after). */
export async function recordAudit(session: ClientSession, input: AuditInput): Promise<void> {
  const doc: Content = {
    at: new Date(),
    actorId: input.actor.id,
    actorRole: input.actor.role,
    actorLabel: input.actor.label,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    before: scrub(input.before),
    after: scrub(input.after),
    meta: scrub(input.meta),
    ip: input.actor.ip
  };
  await AuditEvent.create([{ ...doc, contentHash: contentHashOf(doc), sealed: false }], { session });
}

/** Records an audit event in its own transaction (for events with no other write). */
export async function recordAuditStandalone(input: AuditInput): Promise<void> {
  await withTransaction((s) => recordAudit(s, input));
}

/**
 * Seals unsealed events into the hash chain, one at a time, in the order found. Each step is a
 * small transaction that advances the chain head and the event together; concurrent sealers
 * simply conflict and retry, so the chain stays linear.
 */
export async function sealAuditChain(limit = 500): Promise<number> {
  let sealed = 0;
  for (let i = 0; i < limit; i++) {
    const next = await AuditEvent.findOne({ sealed: false }).sort({ _id: 1 }).select('_id contentHash').lean();
    if (!next) break;
    const done = await withTransaction(async (s) => {
      const ev = await AuditEvent.findOne({ _id: next._id, sealed: false }).session(s).select('_id contentHash').lean();
      if (!ev) return false;
      const head = await AuditChainHead.findById(HEAD_ID).session(s).lean();
      const seq = (head?.seq ?? 0) + 1;
      const prevHash = head?.hash ?? GENESIS;
      const hash = chainHashOf(ev.contentHash, seq, prevHash);
      if (head) await AuditChainHead.updateOne({ _id: HEAD_ID, seq: head.seq }, { $set: { seq, hash } }, { session: s });
      else await AuditChainHead.create([{ _id: HEAD_ID, seq, hash }], { session: s });
      await AuditEvent.updateOne({ _id: ev._id, sealed: false }, { $set: { sealed: true, seq, prevHash, hash } }, { session: s });
      return true;
    }).catch((err) => {
      if (err instanceof mongoose.mongo.MongoServerError) return false;
      throw err;
    });
    if (done) sealed++;
  }
  return sealed;
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  unsealed: number;
  firstBrokenSeq?: number;
  reason?: string;
}

/** Recomputes every content hash and the whole chain; also checks the head matches the tail. */
export async function verifyAuditChain(): Promise<ChainVerification> {
  let prevHash = GENESIS;
  let expectedSeq = 1;
  let checked = 0;
  for await (const e of AuditEvent.find({ sealed: true }).sort({ seq: 1 }).lean().cursor()) {
    if (e.seq !== expectedSeq) return { ok: false, checked, unsealed: 0, firstBrokenSeq: expectedSeq, reason: 'Missing sequence number' };
    if (e.prevHash !== prevHash) return { ok: false, checked, unsealed: 0, firstBrokenSeq: e.seq, reason: 'prevHash mismatch' };
    if (contentHashOf(e as unknown as Content) !== e.contentHash) return { ok: false, checked, unsealed: 0, firstBrokenSeq: e.seq, reason: 'Content hash mismatch (event modified)' };
    if (chainHashOf(e.contentHash, e.seq!, e.prevHash!) !== e.hash) return { ok: false, checked, unsealed: 0, firstBrokenSeq: e.seq, reason: 'Chain hash mismatch' };
    prevHash = e.hash!;
    expectedSeq++;
    checked++;
  }
  let unsealed = 0;
  for await (const e of AuditEvent.find({ sealed: false }).lean().cursor()) {
    unsealed++;
    if (contentHashOf(e as unknown as Content) !== e.contentHash) return { ok: false, checked, unsealed, reason: `Unsealed event ${String(e._id)} modified` };
  }
  const head = await AuditChainHead.findById(HEAD_ID).lean();
  if ((head?.seq ?? 0) !== checked || (head && head.hash !== prevHash)) {
    return { ok: false, checked, unsealed, reason: 'Chain head does not match last event (possible truncation)' };
  }
  return { ok: true, checked, unsealed };
}
