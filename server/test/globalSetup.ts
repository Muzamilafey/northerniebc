import mongoose from 'mongoose';

const { MongoClient } = mongoose.mongo;

/**
 * Integration tests run against a real MongoDB replica set (transactions require one).
 * Set MONGO_TEST_URI to point at it; by default a local single-node set "rs0" is used and
 * initiated if needed. See docs/TESTING.md.
 */
export default async function setup() {
  const base = process.env.MONGO_TEST_URI ?? 'mongodb://127.0.0.1:27017/?directConnection=true';
  const client = new MongoClient(base, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const admin = client.db('admin');
  try {
    await admin.command({ replSetGetStatus: 1 });
  } catch (err) {
    const msg = (err as Error).message;
    if (/no replset config|NotYetInitialized/i.test(msg)) {
      await admin.command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] } });
      for (let i = 0; i < 30; i++) {
        const s = await admin.command({ isMaster: 1 });
        if (s.ismaster) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    } else throw err;
  }
  await client.close();
}
