import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { badRequest } from '../../lib/errors.js';
import { sha256 } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import { StoredFile } from '../../models/system.js';

const root = path.resolve(env.UPLOAD_DIR);

export const ALLOWED_MIME = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  document: ['application/pdf'],
  spreadsheet: ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
} as const;

/** Detects the real file type from magic bytes; the client-declared type is not trusted. */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    // ZIP container: accept only if it looks like an xlsx workbook.
    if (buf.includes(Buffer.from('xl/'))) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    return null;
  }
  // CSV: printable UTF-8 text without NUL bytes.
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  if (sample.length > 0 && !sample.includes(0) && /^[\x09\x0a\x0d\x20-\x7e -￿]*$/u.test(sample.toString('utf8'))) return 'text/csv';
  return null;
}

/** Streams the file to a clamd daemon using the INSTREAM protocol. */
export function clamavScan(buf: Buffer): Promise<{ clean: boolean; detail: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: env.CLAMAV_HOST!, port: env.CLAMAV_PORT });
    let response = '';
    sock.setTimeout(30000, () => sock.destroy(new Error('ClamAV timeout')));
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      for (let i = 0; i < buf.length; i += 64 * 1024) {
        const chunk = buf.subarray(i, i + 64 * 1024);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        sock.write(len);
        sock.write(chunk);
      }
      sock.write(Buffer.alloc(4));
    });
    sock.on('data', (d) => (response += d.toString()));
    sock.on('end', () => {
      const r = response.replace(/\0/g, '').trim();
      resolve({ clean: r.endsWith('OK') && !r.includes('FOUND'), detail: r });
    });
    sock.on('error', reject);
  });
}

export interface SaveOptions {
  purpose: 'RESULT_EVIDENCE' | 'CITIZEN_REPORT' | 'IMPORT' | 'SOURCE_DOCUMENT' | 'PROJECT_EVIDENCE' | 'CANDIDATE_PHOTO' | 'PARTY_LOGO' | 'COUNTY_LOGO' | 'RECEIPT' | 'RECONCILIATION_EVIDENCE';
  allowed: readonly string[];
  originalName?: string;
  uploadedBy?: string;
  uploaderIpHash?: string;
  visibility?: 'PRIVATE' | 'PUBLIC';
  /** Internally generated files (receipts) skip the scanner. */
  trusted?: boolean;
}

export async function saveFile(buf: Buffer, opts: SaveOptions) {
  if (buf.length === 0) throw badRequest('Empty file');
  if (buf.length > env.MAX_UPLOAD_BYTES) throw badRequest('File too large');
  const mime = opts.trusted ? 'application/pdf' : sniffMime(buf);
  if (!mime || !opts.allowed.includes(mime)) throw badRequest('File type not allowed');

  let scanStatus: 'PENDING' | 'CLEAN' | 'INFECTED' | 'ERROR' | 'UNSCANNED_DEV' = 'PENDING';
  let scanDetail: string | undefined;
  if (opts.trusted) scanStatus = 'CLEAN';
  else if (env.CLAMAV_HOST) {
    try {
      const r = await clamavScan(buf);
      scanStatus = r.clean ? 'CLEAN' : 'INFECTED';
      scanDetail = r.detail.slice(0, 200);
    } catch (err) {
      scanStatus = 'ERROR';
      scanDetail = (err as Error).message;
      logger.error({ err: scanDetail }, 'Malware scan failed');
    }
  } else if (env.ALLOW_UNSCANNED_UPLOADS) scanStatus = 'UNSCANNED_DEV';
  if (scanStatus === 'INFECTED') throw badRequest('File rejected by malware scanner');

  const storageKey = `${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}`;
  const full = path.join(root, storageKey);
  await fs.mkdir(path.dirname(full), { recursive: true, mode: 0o750 });
  await fs.writeFile(full, buf, { mode: 0o640 });
  return StoredFile.create({
    originalName: opts.originalName?.replace(/[^\w.\- ]/g, '_').slice(0, 200),
    storageKey,
    mime,
    size: buf.length,
    sha256: sha256(buf),
    purpose: opts.purpose,
    visibility: opts.visibility ?? 'PRIVATE',
    scanStatus,
    scanDetail,
    uploadedBy: opts.uploadedBy,
    uploaderIpHash: opts.uploaderIpHash
  });
}

export async function readStoredFile(storageKey: string): Promise<Buffer> {
  const full = path.resolve(root, storageKey);
  if (!full.startsWith(root + path.sep)) throw badRequest('Invalid storage key');
  return fs.readFile(full);
}

/** Files may be served only once scanned clean (or explicitly allowed in development). */
export const isServable = (scanStatus: string) => scanStatus === 'CLEAN' || scanStatus === 'UNSCANNED_DEV';
