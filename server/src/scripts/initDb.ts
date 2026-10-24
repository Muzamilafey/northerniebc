/**
 * Creates all collections and indexes. Run once after provisioning and after each upgrade
 * (production runs with autoIndex disabled).
 */
import mongoose from 'mongoose';
import { connectMongo, disconnectMongo } from '../db/mongo.js';
import '../models/index.js';

await connectMongo();
for (const name of mongoose.modelNames()) {
  const m = mongoose.model(name);
  await m.createCollection().catch(() => undefined);
  await m.syncIndexes();
  console.log(`indexes synced: ${name}`);
}
await disconnectMongo();
