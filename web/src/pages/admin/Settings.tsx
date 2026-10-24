import { useState } from 'react';
import { api } from '../../lib/api';
import { ErrorBox, Loading, PageHeader, Success } from '../../components/ui';
import { useApi } from '../../lib/useApi';
import { useDialog } from '../../components/Dialog';

interface FieldInfo { value?: string; set: boolean; source: 'settings' | 'environment' | 'unset'; secret: boolean; values?: string[] }
type Settings = Record<string, Record<string, FieldInfo>>;

const SECTIONS: { id: string; title: string; help: string; testable: boolean }[] = [
  { id: 'registration', title: 'Agents: sign-in and self-registration', help: 'Agent sign-in: when closed, agents cannot sign in or use the agent app (staff are not affected) and the public Login button is hidden. Self-registration: when on (and KRA is configured), agents can register with their ID number and email; their name and KRA PIN come from KRA and cannot be changed, and every self-registered agent still needs approval.', testable: false },
  { id: 'kra', title: 'KRA PIN Checker', help: 'Consumer key and secret from the KRA developer portal (sandbox: https://sbx.kra.go.ke). For production, enter the base URL KRA issues to you.', testable: true },
  { id: 'mpesa', title: 'M-Pesa (Daraja) donations', help: 'Daraja app credentials. The callback token must be a random string of at least 24 characters. Only set "verified operational" after a successful end-to-end test.', testable: true },
  { id: 'ai', title: 'AI reading (forms and party lists)', help: 'Reads results-form photos and the party register. Choose Anthropic (Claude) or Groq and give that provider\'s API key. Groq reads photos and text but not PDFs. Readings are always checked by people before use. Leave the provider blank to use whichever has a key (Anthropic first).', testable: true },
  { id: 'smtp', title: 'Email (SMTP)', help: 'Connection URL such as smtps://user:password@smtp.example.org:465, used for receipts, password resets and registration links.', testable: true }
];

const LABELS: Record<string, string> = {
  AGENT_SELF_REGISTRATION: 'Open agent self-registration',
  AGENT_LOGIN: 'Agent sign-in open (default: true)',
  AI_PROVIDER: 'Provider',
  ANTHROPIC_API_KEY: 'Anthropic API key',
  FORM_EXTRACTION_MODEL: 'Anthropic model (default claude-opus-5-5)',
  GROQ_API_KEY: 'Groq API key',
  GROQ_MODEL: 'Groq model (must accept images, e.g. a Llama 4 vision model)',
  KRA_ENV: 'Environment',
  KRA_BASE_URL: 'Base URL',
  KRA_CONSUMER_KEY: 'Consumer key',
  KRA_CONSUMER_SECRET: 'Consumer secret',
  MPESA_ENV: 'Environment',
  MPESA_CONSUMER_KEY: 'Consumer key',
  MPESA_CONSUMER_SECRET: 'Consumer secret',
  MPESA_SHORTCODE: 'Shortcode (paybill / till)',
  MPESA_PASSKEY: 'Lipa na M-Pesa passkey',
  MPESA_TRANSACTION_TYPE: 'Transaction type',
  MPESA_PARTY_B: 'Party B (if different from shortcode)',
  MPESA_CALLBACK_TOKEN: 'Callback token (24+ random characters)',
  MPESA_ALLOWED_CALLBACK_IPS: 'Allowed callback IPs (comma-separated, optional)',
  MPESA_INITIATOR_NAME: 'Initiator name (for refunds)',
  MPESA_SECURITY_CREDENTIAL: 'Security credential (for refunds)',
  MPESA_VERIFIED_OPERATIONAL: 'Verified operational (production go-live)',
  SMTP_URL: 'SMTP connection URL',
  MAIL_FROM: 'From address'
};

export default function SettingsPage() {
  const s = useApi<{ settings: Settings }>('/admin/settings');
  if (!s.data && s.loading) return <Loading />;
  if (!s.data && s.error) return <ErrorBox error={s.error.message.includes('permission') ? 'Only super administrators (with MFA) can manage integration settings.' : s.error} />;
  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Settings" subtitle="Integration credentials. Values saved here override the server's .env file. Secrets are stored encrypted and are never shown again after saving." />
      {s.data && SECTIONS.map((sec) => <SectionForm key={sec.id} sec={sec} fields={s.data!.settings[sec.id] ?? {}} onSaved={() => void s.reload()} />)}
    </div>
  );
}

function SectionForm({ sec, fields, onSaved }: { sec: (typeof SECTIONS)[number]; fields: Record<string, FieldInfo>; onSaved: () => void }) {
  const dialog = useDialog();
  const [values, setValues] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const save = async (clear: string[] = []) => {
    setMsg({});
    try {
      const r = await api<{ changed: string[] }>(`/admin/settings/${sec.id}`, { method: 'PUT', body: { values, clear } });
      setValues({});
      setMsg({ ok: r.changed.length ? `Saved: ${r.changed.join(', ')}` : 'Nothing changed' });
      onSaved();
    } catch (e) {
      setMsg({ err: (e as Error).message });
    }
  };
  const test = async () => {
    setMsg({});
    const r = await api<{ ok: boolean; message: string }>(`/admin/settings/${sec.id}/test`, { body: {} }).catch((e) => ({ ok: false, message: (e as Error).message }));
    setMsg(r.ok ? { ok: r.message } : { err: r.message });
  };
  return (
    <section className="card space-y-3" aria-labelledby={`s-${sec.id}`}>
      <h2 id={`s-${sec.id}`} className="text-lg font-bold text-navy-900">{sec.title}</h2>
      <p className="text-sm text-gray-600">{sec.help}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {Object.entries(fields).map(([name, f]) => (
          <label key={name} className="block text-sm">
            <span className="label">{LABELS[name] ?? name}</span>
            {f.values ? (
              <select className="input" value={values[name] ?? f.value ?? ''} onChange={(e) => setValues({ ...values, [name]: e.target.value })}>
                {!f.value && <option value="">—</option>}
                {f.values.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            ) : (
              <input
                className="input"
                type={f.secret ? 'password' : 'text'}
                autoComplete="off"
                placeholder={f.secret ? (f.set ? '•••••••• (saved — leave blank to keep)' : 'Not set') : f.value ?? 'Not set'}
                value={values[name] ?? (f.secret ? '' : f.value ?? '')}
                onChange={(e) => setValues({ ...values, [name]: e.target.value })}
              />
            )}
            <span className="mt-0.5 block text-xs text-gray-500">
              {f.source === 'settings' ? 'Set here' : f.source === 'environment' ? 'From server .env' : 'Not set'}
              {f.source === 'settings' && <button type="button" className="link ml-2 text-red-700" onClick={async () => { if (await dialog.confirm({ title: `Clear ${LABELS[name] ?? name}?`, message: 'The value saved here is deleted. The server falls back to its .env value, if any.', confirmLabel: 'Clear', tone: 'danger' })) void save([name]); }}>Clear</button>}
            </span>
          </label>
        ))}
      </div>
      {msg.ok && <Success>{msg.ok}</Success>}
      {msg.err && <ErrorBox error={msg.err} />}
      <div className="flex gap-2">
        <button className="btn-primary" onClick={() => void save()}>Save {sec.title}</button>
        {sec.testable && <button className="btn-outline" onClick={() => void test()}>Test connection</button>}
      </div>
    </section>
  );
}
