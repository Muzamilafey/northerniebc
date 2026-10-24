import { connectMongo, disconnectMongo } from '../db/mongo.js';
import { verifyAuditChain } from '../lib/audit.js';

await connectMongo();
// Read-only: does not seal pending events (run against restored copies too).
const r = await verifyAuditChain();
console.log(JSON.stringify(r, null, 2));
await disconnectMongo();
process.exit(r.ok ? 0 : 2);
