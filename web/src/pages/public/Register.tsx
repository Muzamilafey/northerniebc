import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Empty, ErrorBox, Field, Loading, PageHeader, Success } from '../../components/ui';
import { useApi } from '../../lib/useApi';

/** Agent self-registration: national ID number + email. Name and KRA PIN come from KRA. */
export default function Register() {
  const cfg = useApi<{ open: boolean }>('/agent-registration/config');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ message: string; devConfirmUrl?: string }>();
  const [err, setErr] = useState<string>();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setErr(undefined);
    try {
      setDone(await api('/agent-registration/start', { body: { idNumber: String(f.get('idNumber')).trim(), email: f.get('email'), phone: f.get('phone') || undefined, consent: f.get('consent') === 'on', website: f.get('website') || undefined } }));
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (cfg.loading) return <Loading />;
  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title="Register as a polling-station agent" subtitle="Enter your national ID number and email. We confirm your name and KRA PIN with the Kenya Revenue Authority." />
      {!cfg.data?.open ? (
        <Empty title="Agent registration is not open">Registration opens when the platform administrators enable it. Contact your coordinator.</Empty>
      ) : done ? (
        <Success>
          {done.message}
          {done.devConfirmUrl && <span className="mt-2 block text-xs">Development mode (email not configured): <a className="link" href={done.devConfirmUrl}>open confirmation link</a></span>}
        </Success>
      ) : (
        <form className="card space-y-3" onSubmit={submit}>
          <Field label="National ID number"><input name="idNumber" className="input" inputMode="numeric" pattern="\d{6,9}" required autoComplete="off" /></Field>
          <Field label="Email address" hint="We send a confirmation link here. You will use it to sign in."><input name="email" type="email" className="input" required autoComplete="email" /></Field>
          <Field label="Mobile number (optional)"><input name="phone" className="input" inputMode="tel" placeholder="07XX XXX XXX" /></Field>
          <input type="text" name="website" className="hidden" tabIndex={-1} autoComplete="off" aria-hidden="true" />
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="consent" required className="mt-1" />
            <span>I consent to The Northern IEBC checking my ID number with the Kenya Revenue Authority's PIN Checker to confirm my name and KRA PIN, and storing them (encrypted) for agent vetting, as described in the <Link className="link" to="/privacy">privacy notice</Link>. My name and KRA PIN will be taken from KRA records and cannot be edited.</span>
          </label>
          {err && <ErrorBox error={err} />}
          <button className="btn-primary w-full" disabled={busy}>{busy ? 'Checking…' : 'Verify and continue'}</button>
          <p className="text-xs text-gray-500">After registering, an administrator must approve your account before you can count or submit results.</p>
        </form>
      )}
    </div>
  );
}

export function RegisterConfirm() {
  const [p] = useSearchParams();
  const token = p.get('token') ?? '';
  const info = useApi<{ maskedName: string; email: string; note: string }>(token ? '/agent-registration/confirm' : null, { token });
  const [done, setDone] = useState<{ agentCode: string; message: string }>();
  const [err, setErr] = useState<string>();
  if (!token) return <ErrorBox error="Missing confirmation token" />;
  if (info.loading) return <Loading />;
  if (info.error) return <ErrorBox error={info.error} />;
  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title="Complete your agent registration" />
      {done ? (
        <Success>{done.message} Your agent ID is <strong>{done.agentCode}</strong>. <Link className="link" to="/login">Sign in</Link></Success>
      ) : (
        <form className="card space-y-3" onSubmit={async (e) => { e.preventDefault(); setErr(undefined); try { setDone(await api('/agent-registration/complete', { body: { token, password: new FormData(e.currentTarget).get('password') } })); } catch (x) { setErr((x as Error).message); } }}>
          <p className="text-sm">Name on KRA records: <strong>{info.data!.maskedName}</strong></p>
          <p className="text-sm">Email: <strong>{info.data!.email}</strong></p>
          <p className="text-xs text-gray-600">{info.data!.note} If this is not you, do not continue.</p>
          <Field label="Choose a password" hint="At least 12 characters."><input name="password" type="password" minLength={12} className="input" autoComplete="new-password" required /></Field>
          {err && <ErrorBox error={err} />}
          <button className="btn-primary w-full">Create my agent account</button>
        </form>
      )}
    </div>
  );
}
