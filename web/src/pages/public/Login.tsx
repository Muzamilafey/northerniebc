import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useSiteFlags } from '../../lib/siteFlags';
import { ErrorBox, Field, Logo, Success } from '../../components/ui';

export default function Login() {
  const { signIn, verifyMfa } = useAuth();
  const nav = useNavigate();
  const [mfaToken, setMfaToken] = useState<string>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const go = () => nav('/portal');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setErr(undefined);
    try {
      if (mfaToken) {
        await verifyMfa(mfaToken, String(f.get('code')));
        go();
      } else {
        const r = await signIn(String(f.get('identifier')), String(f.get('password')));
        if (r.mfaToken) setMfaToken(r.mfaToken);
        else go();
      }
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const flags = useSiteFlags();
  return (
    <div className="mx-auto max-w-sm">
      <div className="card space-y-4">
        <div className="flex justify-center"><Logo size={64} withText={false} /></div>
        <h1 className="text-center text-xl font-bold text-navy-900">{flags?.agentLogin === false ? 'Staff sign in' : 'Staff & agent sign in'}</h1>
        {flags?.agentLogin === false && <p className="rounded-lg bg-amber-50 p-3 text-center text-sm text-amber-900">Agent sign-in is closed at the moment. Your coordinator will tell you when it opens.</p>}
        <form className="space-y-3" onSubmit={submit}>
          {!mfaToken ? (
            <>
              <Field label="Email or agent ID"><input name="identifier" className="input" autoComplete="username" required /></Field>
              <Field label="Password"><input name="password" type="password" className="input" autoComplete="current-password" required /></Field>
            </>
          ) : (
            <Field label="Authentication code" hint="Enter the 6-digit code from your authenticator app, or a recovery code."><input name="code" className="input" inputMode="numeric" autoComplete="one-time-code" required autoFocus /></Field>
          )}
          {err && <ErrorBox error={err} />}
          <button className="btn-primary w-full" disabled={busy}>{busy ? 'Please wait…' : mfaToken ? 'Verify' : 'Sign in'}</button>
        </form>
        <p className="text-center text-sm"><Link className="link" to="/forgot-password">Forgot password?</Link></p>
        {flags?.open && <p className="text-center text-sm"><Link className="link" to="/register">Register as a polling-station agent</Link></p>}
        <p className="text-center text-xs text-gray-500">Public visitors do not need an account.</p>
      </div>
    </div>
  );
}

export function ForgotPassword() {
  const [done, setDone] = useState<string>();
  const [err, setErr] = useState<string>();
  return (
    <div className="mx-auto max-w-sm card space-y-3">
      <h1 className="text-xl font-bold">Reset password</h1>
      {done ? <Success>{done}</Success> : (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); try { const r = await api<{ message: string }>('/auth/password/forgot', { body: { email: new FormData(e.currentTarget).get('email') } }); setDone(r.message); } catch (x) { setErr((x as Error).message); } }}>
          <Field label="Email"><input name="email" type="email" className="input" required /></Field>
          {err && <ErrorBox error={err} />}
          <button className="btn-primary w-full">Send reset link</button>
        </form>
      )}
    </div>
  );
}

export function ResetPassword() {
  const [p] = useSearchParams();
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string>();
  return (
    <div className="mx-auto max-w-sm card space-y-3">
      <h1 className="text-xl font-bold">Choose a new password</h1>
      {done ? <Success>Password updated. <Link className="link" to="/login">Sign in</Link>.</Success> : (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); try { await api('/auth/password/reset', { body: { token: p.get('token'), newPassword: new FormData(e.currentTarget).get('pw') } }); setDone(true); } catch (x) { setErr((x as Error).message); } }}>
          <Field label="New password" hint="At least 12 characters."><input name="pw" type="password" minLength={12} className="input" autoComplete="new-password" required /></Field>
          {err && <ErrorBox error={err} />}
          <button className="btn-primary w-full">Update password</button>
        </form>
      )}
    </div>
  );
}
