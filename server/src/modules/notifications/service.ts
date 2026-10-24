import nodemailer from 'nodemailer';
import type { ClientSession, Types } from 'mongoose';
import { env } from '../../config/env.js';
import { setting } from '../settings/service.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import { NotificationJob, StoredFile } from '../../models/system.js';
import { readStoredFile } from '../files/storage.js';

export async function enqueueEmail(
  to: string,
  subject: string,
  text: string,
  attachments: { filename: string; fileId: Types.ObjectId }[] = [],
  session?: ClientSession
) {
  await NotificationJob.create([{ channel: 'EMAIL', toEnc: encrypt(to), subject, text, attachments }], { session });
}

let transport: { url: string; t: nodemailer.Transporter } | undefined;
/** SMTP settings come from the admin Settings page (or .env); the transport is rebuilt when they change. */
export function getTransport() {
  const url = setting('SMTP_URL');
  if (!url) return undefined;
  if (transport?.url !== url) transport = { url, t: nodemailer.createTransport(url) };
  return transport.t;
}

/** Sends pending notification jobs. Without SMTP configured, jobs are marked SKIPPED (never "sent"). */
export async function processNotificationBatch(limit = 20): Promise<number> {
  let n = 0;
  for (let i = 0; i < limit; i++) {
    const job = await NotificationJob.findOneAndUpdate(
      { status: 'PENDING', attempts: { $lt: 5 } },
      { $inc: { attempts: 1 } },
      { sort: { createdAt: 1 }, new: true }
    );
    if (!job) break;
    n++;
    const t = getTransport();
    if (!t) {
      job.status = 'SKIPPED';
      job.lastError = 'SMTP not configured';
      await job.save();
      continue;
    }
    try {
      const attachments = [];
      for (const a of job.attachments) {
        const f = a.fileId ? await StoredFile.findById(a.fileId) : null;
        if (f) attachments.push({ filename: a.filename ?? 'attachment', content: await readStoredFile(f.storageKey), contentType: f.mime });
      }
      await t.sendMail({ from: setting('MAIL_FROM') ?? env.MAIL_FROM, to: decrypt(job.toEnc), subject: job.subject, text: job.text, attachments });
      job.status = 'SENT';
      job.sentAt = new Date();
    } catch (err) {
      job.lastError = (err as Error).message.slice(0, 500);
      if (job.attempts >= 5) job.status = 'FAILED';
      logger.warn({ jobId: String(job._id), err: job.lastError }, 'Email delivery failed');
    }
    await job.save();
  }
  return n;
}
