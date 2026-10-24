import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Empty, ErrorBox, Field, Loading, PageHeader, StatusBadge, Success } from '../../components/ui';
import { fmtDate, fmtDateTime, fmtKes, humanize } from '../../lib/format';
import { getSocket } from '../../lib/socket';
import { useApi } from '../../lib/useApi';

interface Config {
  accepting: boolean;
  operatorConfigured: boolean;
  operator: { legalName: string | null; email: string | null; phone: string | null; address: string | null; registration: string | null };
  presetsKes: number[];
  minKes: number;
  maxKes: number;
  methods: { method: 'MPESA' | 'CARD' | 'PAYPAL'; label: string; currency: string; operational: boolean; mode: string; requires: { phone?: boolean; email?: boolean } }[];
  termsVersion: string;
  taxWording: string;
  statusNote?: string;
}

export default function Donate() {
  const { data: cfg, loading, error } = useApi<Config>('/donations/config');
  const [amount, setAmount] = useState<number | ''>(500);
  const [method, setMethod] = useState<'MPESA' | 'CARD' | 'PAYPAL'>('MPESA');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [result, setResult] = useState<{ reference: string; token: string; message?: string }>();
  const [idem] = useState(() => crypto.randomUUID());

  const available = cfg?.methods.filter((m) => m.operational) ?? [];
  useEffect(() => {
    if (available.length && !available.some((m) => m.method === method)) setMethod(available[0]!.method);
  }, [available, method]);
  const m = cfg?.methods.find((x) => x.method === method);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setErr(undefined);
    try {
      const r = await api<{ donation: { reference: string; status: string }; statusToken: string; next: { type: string; url?: string; message?: string } }>('/donations', {
        body: {
          idempotencyKey: idem,
          amount: Number(amount),
          method,
          phone: f.get('phone') || undefined,
          name: f.get('name') || undefined,
          email: f.get('email') || undefined,
          message: f.get('message') || undefined,
          acknowledgement: f.get('acknowledgement') ?? 'NONE',
          acceptTerms: f.get('acceptTerms') === 'on',
          termsVersion: cfg!.termsVersion
        }
      });
      if (r.next.type === 'REDIRECT' && r.next.url) {
        window.location.assign(r.next.url);
        return;
      }
      setResult({ reference: r.donation.reference, token: r.statusToken, message: r.next.message });
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!cfg) return null;
  if (result) return <DonationStatusView reference={result.reference} token={result.token} intro={result.message} />;

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        <PageHeader title="Support Independent Election Monitoring and County Accountability" />
        <p className="text-gray-700">Help sustain a public-interest platform that makes election monitoring information, county budget records, development project information, and public accountability reports easier to access. Contributions support platform hosting, data collection, verification, research, maintenance, and public access.</p>
        <div className="card text-sm">
          <h2 className="font-bold text-navy-900">What donations fund</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>Website hosting, security, backups and maintenance</li>
            <li>Election data collection and verification</li>
            <li>County budget research and document access</li>
            <li>Accessibility and community outreach</li>
          </ul>
          <p className="mt-2 text-xs text-gray-600">Unless a goal is explicitly marked as a restricted fund, donations support the platform's overall operations; categories are not separate bank accounts. See <Link className="link" to="/donate/transparency">donation transparency</Link>.</p>
        </div>
        <div className="card text-sm">
          <h2 className="font-bold text-navy-900">Who receives your donation</h2>
          {cfg.operatorConfigured ? (
            <p className="mt-1">{cfg.operator.legalName}{cfg.operator.registration ? `, ${cfg.operator.registration}` : ''}. {cfg.operator.address} · {cfg.operator.email} {cfg.operator.phone ? `· ${cfg.operator.phone}` : ''}</p>
          ) : (
            <p className="mt-1 text-amber-900">The legal operator has not been configured yet.</p>
          )}
          <p className="mt-2 text-xs text-gray-600">{cfg.taxWording} We do not claim charitable or tax-exempt status. <Link className="link" to="/donate/terms">Donation terms &amp; refund policy</Link> · <Link className="link" to="/privacy">Privacy notice</Link></p>
        </div>
      </div>

      <aside className="card h-fit">
        {!cfg.accepting ? (
          <Empty title="Donations are awaiting setup">{cfg.statusNote ?? 'No payment method has been verified for live use yet.'}</Empty>
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            <fieldset>
              <legend className="label">Amount (KSh)</legend>
              <div className="grid grid-cols-3 gap-2">
                {cfg.presetsKes.map((p) => (
                  <button type="button" key={p} aria-pressed={amount === p} className={amount === p ? 'btn-primary' : 'btn-outline'} onClick={() => setAmount(p)}>{p.toLocaleString('en-KE')}</button>
                ))}
              </div>
              <input className="input mt-2" type="number" inputMode="numeric" min={m?.currency === 'USD' ? 1 : cfg.minKes} max={m?.currency === 'USD' ? 10000 : cfg.maxKes} step={m?.currency === 'USD' ? 0.01 : 1} placeholder="Custom amount" value={amount} onChange={(e) => setAmount(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Custom amount" required />
              {m?.currency === 'USD' && <p className="mt-1 text-xs text-amber-800">PayPal donations are taken in US dollars.</p>}
            </fieldset>
            <fieldset>
              <legend className="label">Payment method</legend>
              <div className="space-y-1">
                {cfg.methods.map((x) => (
                  <label key={x.method} className={`flex items-center gap-2 rounded border p-2 text-sm ${x.operational ? '' : 'opacity-50'}`}>
                    <input type="radio" name="method" checked={method === x.method} disabled={!x.operational} onChange={() => setMethod(x.method)} />
                    {x.label} {!x.operational && <span className="text-xs">(not available)</span>}{x.operational && x.mode === 'sandbox' && <span className="rounded bg-amber-100 px-1 text-xs">sandbox — test only</span>}
                  </label>
                ))}
              </div>
            </fieldset>
            {m?.requires.phone && <Field label="M-Pesa phone number"><input name="phone" className="input" inputMode="tel" placeholder="07XX XXX XXX" required /></Field>}
            <Field label={m?.requires.email ? 'Email (for the provider and your receipt)' : 'Email for receipt (optional)'}><input name="email" type="email" className="input" required={Boolean(m?.requires.email)} /></Field>
            <Field label="Name (optional)"><input name="name" className="input" maxLength={120} /></Field>
            <Field label="Message (optional)"><textarea name="message" className="input" maxLength={500} /></Field>
            <Field label="Public acknowledgement"><select name="acknowledgement" className="input"><option value="NONE">Do not mention me</option><option value="ANONYMOUS">Count me as an anonymous supporter</option><option value="NAMED">Thank me by name (no amount shown)</option></select></Field>
            <label className="flex items-start gap-2 text-xs"><input type="checkbox" name="acceptTerms" required className="mt-0.5" /> I agree to the <Link to="/donate/terms" className="link">donation terms and refund policy</Link> and the <Link to="/privacy" className="link">privacy notice</Link>.</label>
            {err && <ErrorBox error={err} />}
            <button className="btn-accent w-full" disabled={busy || amount === ''}>{busy ? 'Starting payment…' : `Donate${amount ? ` ${m?.currency === 'USD' ? 'USD' : 'KSh'} ${Number(amount).toLocaleString('en-KE')}` : ''}`}</button>
            <p className="text-xs text-gray-500">We never ask for your M-Pesa PIN or card security code on this site.</p>
          </form>
        )}
      </aside>
    </div>
  );
}

function DonationStatusView({ reference, token, intro }: { reference: string; token: string; intro?: string }) {
  const { data, error, reload } = useApi<{ donation: { reference: string; status: string; amount: number; currency: string; message: string; confirmedAt: string | null }; receipt: { receiptNumber: string } | null }>(`/donations/${reference}/status`, { t: token });
  useEffect(() => {
    if (data && data.donation.status !== 'PENDING') return;
    const t = setInterval(() => void reload(), 4000);
    return () => clearInterval(t);
  }, [data, reload]);
  return (
    <div className="mx-auto max-w-lg space-y-4">
      <PageHeader title="Donation status" subtitle={`Reference ${reference}`} />
      {intro && data?.donation.status === 'PENDING' && <div className="rounded-lg bg-navy-50 p-3 text-sm">{intro}</div>}
      {error && <ErrorBox error={error} />}
      {data && (
        <div className="card space-y-2">
          <div className="flex items-center justify-between"><span className="text-2xl font-bold">{data.donation.currency} {data.donation.amount.toLocaleString('en-KE')}</span><StatusBadge status={data.donation.status} /></div>
          <p className="text-sm">{data.donation.message}</p>
          {data.donation.status === 'PENDING' && <p className="text-xs text-gray-500">This page updates automatically. Do not pay twice.</p>}
          {data.receipt && (
            <Success>
              Receipt {data.receipt.receiptNumber} — <a className="link" href={`/api/donations/${reference}/receipt.pdf?t=${encodeURIComponent(token)}`}>download PDF</a>
            </Success>
          )}
          {data.donation.confirmedAt && <p className="text-xs text-gray-500">Confirmed {fmtDateTime(data.donation.confirmedAt)}</p>}
          <p className="text-xs text-gray-500">Bookmark this page to return to your receipt.</p>
        </div>
      )}
    </div>
  );
}

export function DonationStatusPage() {
  const { reference } = useParams();
  const [p] = useSearchParams();
  return <DonationStatusView reference={reference!} token={p.get('t') ?? ''} />;
}

export function Transparency() {
  const { data, error, loading, reload } = useApi<{
    totals: { currency: string; count: number; gross: number; paymentFees: number; feesRecordedFor: number; refunds: number; net: number }[];
    currentMonth: { from: string; totals: { currency: string; gross: number; count: number }[] };
    goals: { id: string; title: string; description?: string; targetKes: number; raisedKes: number; percent: number; periodStart: string; periodEnd: string; basis: string }[];
    expenditure: { publishedTotalKes: number; byCategory: { category: string; totalKes: number; entries: number }[] };
    availableBalance: null | { kes: number; formula: string; note: string };
    acknowledgements: Record<string, number>;
    reports: { _id: string; title: string; periodStart: string; periodEnd: string; publishedAt: string }[];
    note: string;
    generatedAt: string;
  }>('/donations/public/summary');
  useEffect(() => {
    const s = getSocket();
    s.emit('subscribe:donations');
    const h = () => void reload();
    s.on('donations:updated', h);
    return () => {
      s.off('donations:updated', h);
    };
  }, [reload]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const kes = data.totals.find((t) => t.currency === 'KES');
  const month = data.currentMonth.totals.find((t) => t.currency === 'KES');
  return (
    <div className="space-y-6">
      <PageHeader title="Donation transparency" subtitle={`${data.note} Updated ${fmtDateTime(data.generatedAt)}.`} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="card"><p className="text-xs uppercase text-gray-500">Confirmed donations (gross)</p><p className="text-2xl font-bold">{fmtKes(kes?.gross ?? 0)}</p><p className="text-xs text-gray-500">{kes?.count ?? 0} donations</p></div>
        <div className="card"><p className="text-xs uppercase text-gray-500">This month</p><p className="text-2xl font-bold">{fmtKes(month?.gross ?? 0)}</p><p className="text-xs text-gray-500">since {fmtDate(data.currentMonth.from)}</p></div>
        <div className="card"><p className="text-xs uppercase text-gray-500">Fees / refunds</p><p className="text-lg font-bold">{fmtKes(kes?.paymentFees ?? 0)} / {fmtKes(kes?.refunds ?? 0)}</p><p className="text-xs text-gray-500">Fees recorded for {kes?.feesRecordedFor ?? 0} payments</p></div>
        <div className="card"><p className="text-xs uppercase text-gray-500">Net receipts</p><p className="text-2xl font-bold">{fmtKes(kes?.net ?? 0)}</p></div>
      </div>
      {data.totals.filter((t) => t.currency !== 'KES').map((t) => <p key={t.currency} className="text-sm">{t.currency}: gross {t.gross}, fees {t.paymentFees}, refunds {t.refunds}, net {t.net} ({t.count} donations)</p>)}
      <section className="card">
        <h2 className="font-bold">Fundraising goals</h2>
        {data.goals.length === 0 ? <p className="text-sm text-gray-600">No fundraising goal is configured.</p> : data.goals.map((g) => (
          <div key={g.id} className="mt-3">
            <div className="flex justify-between text-sm"><span className="font-semibold">{g.title}</span><span>{fmtKes(g.raisedKes)} of {fmtKes(g.targetKes)}</span></div>
            <div className="mt-1 h-2 rounded bg-gray-200"><div className="h-2 rounded bg-brand-600" style={{ width: `${g.percent}%` }} /></div>
            <p className="text-xs text-gray-500">{fmtDate(g.periodStart)} – {fmtDate(g.periodEnd)}. {g.basis}</p>
          </div>
        ))}
      </section>
      <section className="card">
        <h2 className="font-bold">Published expenditure</h2>
        {data.expenditure.byCategory.length === 0 ? <p className="text-sm text-gray-600">No verified expenditure records have been published yet, so no balance is calculated.</p> : (
          <>
            <table className="table mt-2"><tbody>{data.expenditure.byCategory.map((c) => <tr key={c.category}><td>{humanize(c.category)}</td><td className="text-right">{fmtKes(c.totalKes)}</td></tr>)}</tbody></table>
            {data.availableBalance && <p className="mt-2 text-sm">Available balance: <strong>{fmtKes(data.availableBalance.kes)}</strong> <span className="text-xs text-gray-500">({data.availableBalance.formula}. {data.availableBalance.note})</span></p>}
          </>
        )}
      </section>
      <section className="card">
        <h2 className="font-bold">Financial accountability reports</h2>
        {data.reports.length === 0 ? <p className="text-sm text-gray-600">None published yet.</p> : <ul className="mt-2 text-sm">{data.reports.map((r) => <li key={r._id}>{r.title} ({fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)}), published {fmtDate(r.publishedAt)}</li>)}</ul>}
      </section>
      <p className="text-sm">Supporters: {data.acknowledgements.NAMED ?? 0} named and {data.acknowledgements.ANONYMOUS ?? 0} anonymous supporters chose to be acknowledged.</p>
    </div>
  );
}

export function DonationTerms() {
  const { data } = useApi<Config>('/donations/config');
  return (
    <div className="max-w-3xl space-y-3 text-sm">
      <PageHeader title="Donation terms & refund policy" subtitle={`Version ${data?.termsVersion ?? ''}`} />
      <div className="card space-y-2">
        <p>Donations are voluntary contributions to {data?.operator.legalName ?? 'the platform operator (not yet configured)'} to support the operation of The Northern IEBC. They do not buy any service, influence over content, or access to data.</p>
        <p>A donation is complete only when the payment provider confirms it. Pending or failed payments are never treated as received, and no receipt is issued for them.</p>
        <p><strong>Refunds.</strong> If you donated in error, contact {data?.operator.email ?? 'the operator'} within 30 days with your donation reference. Approved refunds are made through the original payment provider and require approval by two authorised staff.</p>
        <p><strong>Tax.</strong> {data?.taxWording}</p>
        <p>Donations support overall operations unless you donate to a goal explicitly marked as a restricted fund.</p>
      </div>
    </div>
  );
}
