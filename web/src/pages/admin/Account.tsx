import { useState } from 'react';
import { api, setToken } from '../../lib/api';
import { ROLE_LABELS, useAuth } from '../../lib/auth';
import { ErrorBox, Field, PageHeader, Success } from '../../components/ui';
import { fmtDateTime } from '../../lib/format';
import { useApi } from '../../lib/useApi';

export default function Account() {
  const { user, reload, setSession } = useAuth();
  const [setup, setSetup] = useState<{ qrDataUrl: string; secret: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const sessions = useApi<{ sessions: { familyId: string; userAgent?: string; ip?: string; lastUsedAt: string; current: boolean }[] }>('/auth/sessions');
  if (!user) return null;
  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="My account & security" subtitle={`${user.fullName} · ${ROLE_LABELS[user.role]}`} />
      {msg.ok && <Success>{msg.ok}</Success>}
      {msg.err && <ErrorBox error={msg.err} />}
      <section className="card space-y-3">
        <h2 className="font-bold">Multi-factor authentication</h2>
        {user.mfaEnabled ? <p className="text-sm text-green-800">Enabled.</p> : !setup ? (
          <button className="btn-primary" onClick={async () => setSetup(await api('/auth/mfa/setup', { body: {} }))}>Set up authenticator app</button>
        ) : (
          <form className="space-y-2" onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await api<{ recoveryCodes: string[]; accessToken: string }>('/auth/mfa/enable', { body: { code: new FormData(e.currentTarget).get('code') } });
              setToken(r.accessToken);
              setSession(r.accessToken, { ...user, mfaEnabled: true }, false);
              setCodes(r.recoveryCodes);
              setSetup(null);
              await reload();
            } catch (x) {
              setMsg({ err: (x as Error).message });
            }
          }}>
            <img src={setup.qrDataUrl} alt="QR code for authenticator app" className="h-48 w-48" />
            <p className="text-xs">Or enter this key manually: <code className="select-all">{setup.secret}</code></p>
            <Field label="6-digit code"><input name="code" className="input w-40" inputMode="numeric" required /></Field>
            <button className="btn-primary">Enable</button>
          </form>
        )}
        {codes && <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm"><p className="font-semibold">Recovery codes — store them offline. Each works once.</p><pre className="mt-2 grid grid-cols-2 gap-1">{codes.map((c) => <span key={c}>{c}</span>)}</pre></div>}
      </section>
      <section className="card">
        <h2 className="font-bold">Change password</h2>
        <form className="mt-2 grid gap-2 sm:grid-cols-2" onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          try {
            await api('/auth/password/change', { body: { currentPassword: f.get('current'), newPassword: f.get('next') } });
            setMsg({ ok: 'Password changed. Other sessions were signed out.' });
            e.currentTarget.reset();
            void sessions.reload();
          } catch (x) {
            setMsg({ err: (x as Error).message });
          }
        }}>
          <Field label="Current password"><input name="current" type="password" className="input" autoComplete="current-password" required /></Field>
          <Field label="New password (min. 12 characters)"><input name="next" type="password" minLength={12} className="input" autoComplete="new-password" required /></Field>
          <button className="btn-primary w-fit">Change password</button>
        </form>
      </section>
      <section className="card">
        <h2 className="font-bold">Active sessions</h2>
        <ul className="mt-2 divide-y text-sm">{sessions.data?.sessions.map((s) => <li key={s.familyId} className="flex items-center justify-between py-2"><span>{s.userAgent?.slice(0, 60) ?? 'Unknown device'} · {s.ip} · last used {fmtDateTime(s.lastUsedAt)} {s.current && <strong>(this device)</strong>}</span>{!s.current && <button className="link text-red-700" onClick={async () => { await api(`/auth/sessions/${s.familyId}`, { method: 'DELETE' }); void sessions.reload(); }}>Sign out</button>}</li>)}</ul>
      </section>
    </div>
  );
}

export function AuditLog() {
  const [filter, setFilter] = useState<Record<string, string>>({});
  const list = useApi<{ items: { _id: string; seq: number; at: string; actorLabel?: string; actorRole?: string; action: string; entityType: string; entityId?: string; ip?: string; hash: string; meta?: unknown }[] }>('/admin/audit-log', filter);
  const [verify, setVerify] = useState<{ ok: boolean; checked: number; reason?: string; firstBrokenSeq?: number } | null>(null);
  return (
    <div className="space-y-4">
      <PageHeader title="Audit log" subtitle="Append-only, hash-chained record of privileged actions." actions={<button className="btn-outline" onClick={async () => setVerify(await api('/admin/audit-log/verify'))}>Verify chain integrity</button>} />
      {verify && (verify.ok ? <Success>Chain intact — {verify.checked} events verified.</Success> : <ErrorBox error={`Chain broken at seq ${verify.firstBrokenSeq ?? '?'}: ${verify.reason}`} />)}
      <div className="card flex flex-wrap gap-2">
        <input className="input max-w-xs" placeholder="Action e.g. result.verified" onKeyDown={(e) => e.key === 'Enter' && setFilter({ ...filter, action: (e.target as HTMLInputElement).value })} />
        <input className="input max-w-xs" placeholder="Entity ID" onKeyDown={(e) => e.key === 'Enter' && setFilter({ ...filter, entityId: (e.target as HTMLInputElement).value })} />
      </div>
      <div className="card overflow-x-auto">
        <table className="table"><thead><tr><th>#</th><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Hash</th></tr></thead>
          <tbody>{list.data?.items.map((e) => <tr key={e._id}><td>{e.seq}</td><td className="text-xs">{fmtDateTime(e.at)}</td><td className="text-xs">{e.actorLabel ?? '—'}<br />{e.actorRole}</td><td>{e.action}</td><td className="text-xs">{e.entityType} {e.entityId}</td><td className="font-mono text-xs">{e.hash.slice(0, 12)}…</td></tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}
