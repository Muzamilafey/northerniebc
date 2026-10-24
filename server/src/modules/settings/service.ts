import { env } from '../../config/env.js';
import { decryptOptional, encrypt } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import { SystemConfig } from '../../models/system.js';

/**
 * Integration settings an administrator can manage from the Settings page. Values saved there
 * override the server environment (.env). Secret fields are stored AES-256-GCM encrypted and are
 * never returned to the browser.
 */
export const SETTING_FIELDS = {
  mpesa: {
    MPESA_ENV: { secret: false, values: ['sandbox', 'production'] },
    MPESA_CONSUMER_KEY: { secret: false },
    MPESA_CONSUMER_SECRET: { secret: true },
    MPESA_SHORTCODE: { secret: false },
    MPESA_PASSKEY: { secret: true },
    MPESA_TRANSACTION_TYPE: { secret: false, values: ['CustomerPayBillOnline', 'CustomerBuyGoodsOnline'] },
    MPESA_PARTY_B: { secret: false },
    MPESA_CALLBACK_TOKEN: { secret: true },
    MPESA_ALLOWED_CALLBACK_IPS: { secret: false },
    MPESA_INITIATOR_NAME: { secret: false },
    MPESA_SECURITY_CREDENTIAL: { secret: true },
    MPESA_VERIFIED_OPERATIONAL: { secret: false, values: ['true', 'false'] }
  },
  smtp: {
    SMTP_URL: { secret: true },
    MAIL_FROM: { secret: false }
  },
  kra: {
    KRA_ENV: { secret: false, values: ['sandbox', 'production'] },
    KRA_BASE_URL: { secret: false },
    KRA_CONSUMER_KEY: { secret: false },
    KRA_CONSUMER_SECRET: { secret: true }
  },
  registration: {
    AGENT_SELF_REGISTRATION: { secret: false, values: ['true', 'false'] },
    AGENT_LOGIN: { secret: false, values: ['true', 'false'] }
  },
  ai: {
    AI_PROVIDER: { secret: false, values: ['anthropic', 'groq'] },
    ANTHROPIC_API_KEY: { secret: true },
    FORM_EXTRACTION_MODEL: { secret: false },
    GROQ_API_KEY: { secret: true },
    GROQ_MODEL: { secret: false }
  }
} as const satisfies Record<string, Record<string, { secret: boolean; values?: readonly string[] }>>;

export type Section = keyof typeof SETTING_FIELDS;
type AnyField = { secret: boolean; values?: readonly string[] };
const DOC_ID = 'integrations';

/** Stored as { [field]: plainValue | { enc } } */
let cache: Record<string, string> = {};
let loadedAt = 0;

export async function loadSettings(): Promise<void> {
  const doc = await SystemConfig.findById(DOC_ID).lean();
  const raw = (doc?.value ?? {}) as Record<string, string | { enc: string }>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    try {
      out[k] = typeof v === 'string' ? v : decryptOptional(v.enc) ?? '';
    } catch {
      logger.error({ field: k }, 'Could not decrypt a stored setting (encryption key changed?)');
    }
  }
  cache = out;
  loadedAt = Date.now();
}

/** Effective value: database setting first, then environment. Synchronous (cached). */
export function setting(name: string): string | undefined {
  const v = cache[name];
  if (v !== undefined && v !== '') return v;
  const e = (env as unknown as Record<string, unknown>)[name];
  if (e === undefined || e === null || e === '') return undefined;
  return String(e);
}

export const settingBool = (name: string) => setting(name) === 'true';

/** Agents may sign in unless an administrator has closed agent sign-in (default open). */
export const agentLoginOpen = () => setting('AGENT_LOGIN') !== 'false';
export const AGENT_LOGIN_CLOSED = 'Agent sign-in is closed at the moment. Your coordinator will tell you when it opens.';

export function settingsAge() {
  return Date.now() - loadedAt;
}

/** What the admin page may see: plain values, and only whether each secret is set. */
export async function describeSettings() {
  await loadSettings();
  const out: Record<string, Record<string, { value?: string; set: boolean; source: 'settings' | 'environment' | 'unset'; secret: boolean; values?: readonly string[] }>> = {};
  for (const [section, fields] of Object.entries(SETTING_FIELDS)) {
    out[section] = {};
    for (const [name, meta] of Object.entries(fields) as [string, AnyField][]) {
      const fromDb = cache[name] !== undefined && cache[name] !== '';
      const val = setting(name);
      out[section][name] = {
        secret: meta.secret,
        values: meta.values,
        set: val !== undefined,
        source: fromDb ? 'settings' : val !== undefined ? 'environment' : 'unset',
        ...(meta.secret ? {} : { value: val })
      };
    }
  }
  return out;
}

/**
 * Updates a section. Empty/omitted secret fields are left unchanged; names in `clear` are removed.
 * Returns the names changed (never the values) for the audit log.
 */
export async function updateSettings(section: Section, values: Record<string, string | undefined>, clear: string[], by: string) {
  const fields = SETTING_FIELDS[section] as Record<string, AnyField>;
  const doc = await SystemConfig.findById(DOC_ID).lean();
  const stored = { ...((doc?.value ?? {}) as Record<string, unknown>) };
  const changed: string[] = [];
  for (const [name, raw] of Object.entries(values)) {
    const meta = fields[name];
    if (!meta) throw new Error(`Unknown setting ${name}`);
    if (raw === undefined || raw === '') continue;
    const v = raw.trim();
    if (meta.values && !meta.values.includes(v)) throw new Error(`${name} must be one of ${meta.values.join(', ')}`);
    stored[name] = meta.secret ? { enc: encrypt(v) } : v;
    changed.push(name);
  }
  for (const name of clear) {
    if (!fields[name]) throw new Error(`Unknown setting ${name}`);
    delete stored[name];
    changed.push(`${name} (cleared)`);
  }
  await SystemConfig.updateOne({ _id: DOC_ID }, { $set: { value: stored, updatedBy: by } }, { upsert: true });
  await loadSettings();
  return changed;
}
