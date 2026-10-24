/**
 * Re-checks uploads that were stored while no malware scanner was reachable (status PENDING or
 * ERROR). With CLAMAV_HOST set they are scanned now; infected files are marked and never served.
 * In development with ALLOW_UNSCANNED_UPLOADS=true they are released as unscanned.
 */
import { env } from '../config/env.js';
import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { StoredFile } from '../models/index.js';
import { clamavScan, readStoredFile } from '../modules/files/storage.js';

await connectMongo();
const files = await StoredFile.find({ scanStatus: { $in: ['PENDING', 'ERROR'] } });
const counts: Record<string, number> = {};
if (!env.CLAMAV_HOST && !env.ALLOW_UNSCANNED_UPLOADS) {
  console.log(`${files.length} file(s) are waiting for a scan, but no scanner is configured. Set CLAMAV_HOST, or ALLOW_UNSCANNED_UPLOADS=true for local testing, and run this again.`);
} else {
  for (const f of files) {
    if (env.CLAMAV_HOST) {
      try {
        const r = await clamavScan(await readStoredFile(f.storageKey));
        f.scanStatus = r.clean ? 'CLEAN' : 'INFECTED';
        f.scanDetail = r.detail.slice(0, 200);
      } catch (err) {
        f.scanStatus = 'ERROR';
        f.scanDetail = (err as Error).message;
      }
    } else f.scanStatus = 'UNSCANNED_DEV';
    await f.save();
    counts[f.scanStatus] = (counts[f.scanStatus] ?? 0) + 1;
  }
  console.log(`Re-checked ${files.length} file(s):`, counts);
}
await disconnectMongo();
