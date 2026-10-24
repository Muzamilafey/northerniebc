import type { ClientSession } from 'mongoose';
import { OutboxEvent } from '../models/system.js';

export type OutboxType =
  | 'results.submission'
  | 'results.station_result_changed'
  | 'results.verification'
  | 'donation.confirmed'
  | 'donation.status_changed'
  | 'finance.published'
  | 'projects.published'
  | 'accountability.published'
  | 'notification.enqueued';

/** Writes an event in the same transaction as the state change it announces. */
export async function enqueueOutbox(session: ClientSession, type: OutboxType, payload: Record<string, unknown>) {
  await OutboxEvent.create([{ type, payload }], { session });
}
