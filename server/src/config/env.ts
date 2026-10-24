import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:5173'),
  API_BASE_URL: z.string().url().default('http://localhost:4000'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/northern_iebc?replicaSet=rs0'),
  REDIS_URL: z.string().optional(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  PRIVILEGED_REFRESH_TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(12),
  /** base64-encoded 32-byte key used for AES-256-GCM field encryption */
  DATA_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, {
    message: 'DATA_ENCRYPTION_KEY must be a base64-encoded 32-byte key'
  }),
  /** base64-encoded key for HMAC blind indexes (e.g. phone-number lookup) */
  BLIND_INDEX_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length >= 32, {
    message: 'BLIND_INDEX_KEY must be a base64-encoded key of at least 32 bytes'
  }),
  REQUIRE_MFA_FOR_PRIVILEGED: bool(true),
  FOUR_EYES_IMPORTS: bool(true),

  UPLOAD_DIR: z.string().default('./uploads'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),
  /** Only for local development: treat uploads as clean when no scanner is configured. */
  ALLOW_UNSCANNED_UPLOADS: bool(false),

  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('The Northern IEBC <no-reply@localhost>'),

  // Legal operator disclosure — required before donations can be accepted.
  OPERATOR_LEGAL_NAME: z.string().optional(),
  OPERATOR_CONTACT_EMAIL: z.string().optional(),
  OPERATOR_CONTACT_PHONE: z.string().optional(),
  OPERATOR_POSTAL_ADDRESS: z.string().optional(),
  OPERATOR_REGISTRATION: z.string().optional(),
  DONATION_TAX_WORDING: z
    .string()
    .default(
      'This receipt acknowledges a voluntary contribution. No claim of tax deductibility is made.'
    ),
  DONATION_MIN_KES: z.coerce.number().int().positive().default(10),
  DONATION_MAX_KES: z.coerce.number().int().positive().default(150000),
  DONATION_PRESETS_KES: z.string().default('100,250,500,1000,2500,5000'),
  DONATION_PENDING_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(10),

  // M-Pesa Daraja
  MPESA_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  MPESA_CONSUMER_KEY: z.string().optional(),
  MPESA_CONSUMER_SECRET: z.string().optional(),
  MPESA_SHORTCODE: z.string().optional(),
  MPESA_PASSKEY: z.string().optional(),
  MPESA_TRANSACTION_TYPE: z
    .enum(['CustomerPayBillOnline', 'CustomerBuyGoodsOnline'])
    .default('CustomerPayBillOnline'),
  MPESA_PARTY_B: z.string().optional(),
  /** Random secret embedded in the callback path; callbacks with a wrong token are rejected. */
  MPESA_CALLBACK_TOKEN: z.string().optional(),
  MPESA_ALLOWED_CALLBACK_IPS: z.string().optional(),
  MPESA_INITIATOR_NAME: z.string().optional(),
  MPESA_SECURITY_CREDENTIAL: z.string().optional(),
  /** Operator attestation that the production flow was tested end to end. */
  MPESA_VERIFIED_OPERATIONAL: bool(false),

  // Paystack (cards)
  PAYSTACK_SECRET_KEY: z.string().optional(),
  PAYSTACK_VERIFIED_OPERATIONAL: bool(false),

  // PayPal
  PAYPAL_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  PAYPAL_VERIFIED_OPERATIONAL: bool(false),

  TURNSTILE_SECRET_KEY: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  RUN_WORKERS: bool(true)
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    if (env.ALLOW_UNSCANNED_UPLOADS) {
      throw new Error('ALLOW_UNSCANNED_UPLOADS must not be enabled in production');
    }
    if (!env.PUBLIC_BASE_URL.startsWith('https://') || !env.API_BASE_URL.startsWith('https://')) {
      throw new Error('PUBLIC_BASE_URL and API_BASE_URL must use https in production');
    }
  }
  return env;
}

export const env: Env = load();

export const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
