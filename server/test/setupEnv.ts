import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const dbName = `nie_test_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
const base = process.env.MONGO_TEST_RS_URI ?? 'mongodb://127.0.0.1:27017';
Object.assign(process.env, {
  NODE_ENV: 'test',
  MONGODB_URI: `${base}/${dbName}?replicaSet=rs0`,
  JWT_ACCESS_SECRET: 'test-secret-that-is-long-enough-for-hs256-signing',
  DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  BLIND_INDEX_KEY: crypto.randomBytes(32).toString('base64'),
  UPLOAD_DIR: path.join(os.tmpdir(), 'nie-test-uploads', dbName),
  ALLOW_UNSCANNED_UPLOADS: 'true',
  LOG_LEVEL: 'silent',
  RUN_WORKERS: 'false',
  CORS_ORIGINS: 'http://localhost:5173',
  OPERATOR_LEGAL_NAME: 'Test Operator Ltd',
  OPERATOR_CONTACT_EMAIL: 'ops@example.org',
  MPESA_CONSUMER_KEY: 'test-key',
  MPESA_CONSUMER_SECRET: 'test-secret',
  MPESA_SHORTCODE: '174379',
  MPESA_PASSKEY: 'test-passkey',
  MPESA_CALLBACK_TOKEN: 'cb-token-0123456789abcdefghijklmnop',
  ...(process.env.SETUP_ENV_OVERRIDES ? JSON.parse(process.env.SETUP_ENV_OVERRIDES) : {})
});
