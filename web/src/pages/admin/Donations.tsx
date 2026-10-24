import { useState, type FormEvent } from 'react';
import { api, download } from '../../lib/api';
import { ErrorBox, Field, PageHeader, Pager, Stat, StatusBadge, Success } from '../../components/ui';
import { fmtDate, fmtDateTime, fmtKes, humanize } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import { useDialog } from '../../components/Dialog';

interface DonationRow { _id: string; reference: string; status: string; method: string; providerMode: string; amountCents: number; currency: string; confirmedAt?: string; createdAt: string; needsReconciliation: boolean; providerReceipt?: string }

export default function DonationsAdmin() {
  const summary = useApi<{ byStatus: { _id: string; n: number; amount: number }[]; byMonth: { _id: { month: string; currency: string }; gross: number; n: number }[]; byMethod: { _id: { method: string; currency: string }; gross: number; n: number }[]; totals: { currency: string; gross: number; paymentFees: number; refunds: number; net: number; count: number }[]; reconciliationDiscrepancies: number; confirmedWithoutReceipt: number; providers: { id: string; method: string; mode: string; configured: boolean; operational: boolean }[] }>('/admin/donations/summary');
  const [filter, setFilter] = useState<{ status?: string; reconciliation?: string }>({});
  const [page, setPage] = useState(1);
  const list = useApi<{ items: DonationRow[]; total: number; limit: number }>('/admin/donations', { ...filter, page });
  const [selected, setSelected] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const s = summary.data;
  const kes = s?.totals.find((t) => t.currency === 'KES');
  const count = (st: string) => s?.byStatus.find((x) => x._id === st)?.n ?? 0;
  return (
    <div className="space-y-6">
      <PageHeader title="Donations" subtitle="Only provider-confirmed payments count. Manual reconciliation and refunds require a second authorised person." actions={<div className="flex gap-2"><button className="btn-outline" onClick={() => void download('/exports/donations', { format: 'csv' })}>Export CSV</button><button className="btn-outline" onClick={() => void download('/exports/donations', { format: 'xlsx' })}>Export Excel</button></div>} />
      {msg.ok && <Success>{msg.ok}</Success>}
      {msg.err && <ErrorBox error={msg.err} />}
      {s && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Confirmed (gross)" value={fmtKes(kes?.gross ?? 0)} hint={`${kes?.count ?? 0} donations`} />
            <Stat label="Fees / refunds" value={`${fmtKes(kes?.paymentFees ?? 0)} / ${fmtKes(kes?.refunds ?? 0)}`} />
            <Stat label="Net receipts" value={fmtKes(kes?.net ?? 0)} />
            <Stat label="Pending / failed" value={`${count('PENDING')} / ${count('FAILED') + count('CANCELLED') + count('EXPIRED')}`} />
            <Stat label="Reconciliation discrepancies" value={<button className="link" onClick={() => setFilter({ reconciliation: 'true' })}>{s.reconciliationDiscrepancies}</button>} />
            <Stat label="Confirmed without receipt" value={s.confirmedWithoutReceipt} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="card"><h2 className="font-bold">Payment providers</h2><ul className="mt-2 text-sm">{s.providers.map((p) => <li key={p.id}>{p.method} ({p.id}): {p.operational ? `operational (${p.mode})` : p.configured ? 'configured, not attested for live use' : 'awaiting setup'}</li>)}</ul></div>
            <div className="card"><h2 className="font-bold">By month</h2><ul className="mt-2 text-sm">{s.byMonth.map((m) => <li key={`${m._id.month}${m._id.currency}`}>{m._id.month}: {m._id.currency} {(m.gross / 100).toLocaleString()} ({m.n})</li>)}</ul></div>
            <div className="card"><h2 className="font-bold">By method</h2><ul className="mt-2 text-sm">{s.byMethod.map((m) => <li key={`${m._id.method}${m._id.currency}`}>{m._id.method}: {m._id.currency} {(m.gross / 100).toLocaleString()} ({m.n})</li>)}</ul></div>
          </div>
        </>
      )}
      <div className="card">
        <div className="mb-2 flex flex-wrap gap-2">{['', 'PENDING', 'SUCCESSFUL', 'FAILED', 'CANCELLED', 'REFUND_PENDING', 'REFUNDED'].map((st) => <button key={st} className={filter.status === st || (!filter.status && !st) ? 'btn-primary px-2 py-1' : 'btn-outline px-2 py-1'} onClick={() => { setFilter(st ? { status: st } : {}); setPage(1); }}>{st ? humanize(st) : 'All'}</button>)}</div>
        <div className="overflow-x-auto"><table className="table"><thead><tr><th>Reference</th><th>Created</th><th>Amount</th><th>Method</th><th>Status</th><th>Provider ref.</th><th /></tr></thead>
          <tbody>{list.data?.items.map((d) => <tr key={d._id}><td>{d.reference}{d.needsReconciliation && <span className="ml-1 text-xs font-semibold text-red-700">reconcile</span>}</td><td className="text-xs">{fmtDateTime(d.createdAt)}</td><td>{d.currency} {(d.amountCents / 100).toLocaleString()}</td><td>{d.method}{d.providerMode === 'sandbox' && ' (sandbox)'}</td><td><StatusBadge status={d.status} /></td><td className="text-xs">{d.providerReceipt ?? '—'}</td><td><button className="link" onClick={() => setSelected(d._id)}>Open</button></td></tr>)}</tbody></table></div>
        {list.data && <Pager page={page} total={list.data.total} limit={list.data.limit} onPage={setPage} />}
      </div>
      {selected && <DonationDetail id={selected} onDone={(m) => { setMsg(m); void list.reload(); void summary.reload(); }} />}
      <GoalsAndExpenditure />
    </div>
  );
}

function DonationDetail({ id, onDone }: { id: string; onDone: (m: { ok?: string; err?: string }) => void }) {
  const dialog = useDialog();
  const d = useApi<{ donation: DonationRow & { donor: { name: string | null; email: string | null; phoneMasked: string | null; message?: string; acknowledgement: string }; statusHistory: { status: string; at: string; reason: string }[]; refundedCents: number; feeCents?: number }; transactions: { _id: string; kind: string; status: string; responseCode?: string; responseDescription?: string; createdAt: string }[]; callbacks: { _id: string; receivedAt: string; outcome?: string; authenticityCheck: string }[]; refunds: { _id: string; amountCents: number; status: string; reason: string }[] }>(`/admin/donations/${id}`);
  if (!d.data) return null;
  const x = d.data.donation;
  const run = async (fn: () => Promise<{ message?: string } | unknown>) => {
    try {
      const r = (await fn()) as { message?: string; providerOutcome?: string };
      onDone({ ok: r?.message ?? (r?.providerOutcome ? `Provider says: ${r.providerOutcome}` : 'Done') });
      void d.reload();
    } catch (e) {
      onDone({ err: (e as Error).message });
    }
  };
  async function reconcile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const file = f.get('evidence') as File;
    await run(async () => {
      const form = new FormData();
      form.append('purpose', 'RECONCILIATION_EVIDENCE');
      form.append('file', file);
      const up = await api<{ fileId: string }>('/files', { form });
      return api(`/admin/donations/${id}/reconcile`, { body: { outcome: f.get('outcome'), providerReceipt: f.get('providerReceipt') || undefined, evidenceFileId: up.fileId, note: f.get('note') } });
    });
  }
  return (
    <section className="card space-y-3 border-brand-500">
      <div className="flex items-center justify-between"><h2 className="font-bold">{x.reference}</h2><StatusBadge status={x.status} /></div>
      <p className="text-sm">{x.currency} {(x.amountCents / 100).toLocaleString()} · {x.method} · donor: {x.donor.name ?? 'not given'} {x.donor.email ?? ''} {x.donor.phoneMasked ?? ''} · acknowledgement {humanize(x.donor.acknowledgement)}</p>
      <div className="grid gap-3 text-xs md:grid-cols-3">
        <div><p className="font-semibold">Status history</p>{x.statusHistory.map((h, i) => <p key={i}>{fmtDateTime(h.at)} {h.status} — {h.reason}</p>)}</div>
        <div><p className="font-semibold">Provider requests</p>{d.data.transactions.map((t) => <p key={t._id}>{fmtDateTime(t.createdAt)} {t.kind} {t.status} {t.responseCode} {t.responseDescription}</p>)}</div>
        <div><p className="font-semibold">Callbacks</p>{d.data.callbacks.map((c) => <p key={c._id}>{fmtDateTime(c.receivedAt)} {c.authenticityCheck} → {c.outcome}</p>)}</div>
      </div>
      <div className="flex flex-wrap gap-2">
        {x.status === 'PENDING' && <button className="btn-outline" onClick={() => run(() => api(`/admin/donations/${id}/requery`, { body: {} }))}>Re-query provider</button>}
        {['SUCCESSFUL', 'PARTIALLY_REFUNDED'].includes(x.status) && <button className="btn-outline" onClick={async () => { const r = await dialog.form({ title: 'Request a refund', message: 'A different authorised person must approve the refund before it is sent.', confirmLabel: 'Request refund', tone: 'danger', fields: [{ name: 'amount', label: 'Refund amount', type: 'number', min: 1, step: '0.01' }, { name: 'reason', label: 'Reason', type: 'textarea', minLength: 10, maxLength: 1000 }] }); if (r) void run(() => api(`/admin/donations/${id}/refunds`, { body: { amount: Number(r.amount), reason: r.reason } })); }}>Request refund</button>}
      </div>
      {['PENDING', 'FAILED', 'EXPIRED', 'CANCELLED'].includes(x.status) && (
        <form className="grid gap-2 rounded border p-3 sm:grid-cols-2" onSubmit={reconcile}>
          <p className="text-sm font-semibold sm:col-span-2">Manual reconciliation (needs provider evidence and a second approver)</p>
          <Field label="Outcome"><select name="outcome" className="input"><option value="SUCCESSFUL">Payment received</option><option value="FAILED">Payment not received</option></select></Field>
          <Field label="Provider transaction reference"><input name="providerReceipt" className="input" /></Field>
          <Field label="Statement / evidence (PDF or image)"><input name="evidence" type="file" required accept="application/pdf,image/*" className="input" /></Field>
          <Field label="Note"><textarea name="note" className="input" required minLength={20} /></Field>
          <button className="btn-primary">Request reconciliation</button>
        </form>
      )}
    </section>
  );
}

function GoalsAndExpenditure() {
  const exp = useApi<{ items: { _id: string; category: string; description: string; amountCents: number; spentOn: string; documentReference: string; published: boolean }[] }>('/admin/donations/expenditure/list');
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const submit = (path: string, conv: (f: FormData) => unknown) => async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      await api(path, { body: conv(new FormData(e.currentTarget)) });
      setMsg({ ok: 'Saved' });
      void exp.reload();
    } catch (x) {
      setMsg({ err: (x as Error).message });
    }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {msg.ok && <div className="lg:col-span-3"><Success>{msg.ok}</Success></div>}
      {msg.err && <div className="lg:col-span-3"><ErrorBox error={msg.err} /></div>}
      <form className="card space-y-2" onSubmit={submit('/admin/donations/goals', (f) => ({ title: f.get('title'), category: f.get('category'), targetKes: Number(f.get('targetKes')), periodStart: f.get('periodStart'), periodEnd: f.get('periodEnd'), restricted: f.get('restricted') === 'on', description: f.get('description') || undefined }))}>
        <h2 className="font-bold">New fundraising goal</h2>
        <input name="title" className="input" placeholder="Title" required />
        <select name="category" className="input">{['GENERAL', 'HOSTING', 'ELECTION_DATA', 'BUDGET_RESEARCH', 'PUBLIC_REPORTING', 'SECURITY_MAINTENANCE', 'ACCESSIBILITY_OUTREACH'].map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</select>
        <input name="targetKes" type="number" min={1} className="input" placeholder="Target (KSh)" required />
        <div className="flex gap-2"><input name="periodStart" type="date" className="input" required /><input name="periodEnd" type="date" className="input" required /></div>
        <textarea name="description" className="input" placeholder="Description" />
        <label className="text-xs"><input type="checkbox" name="restricted" /> Restricted fund (only if a legally separate restricted fund exists)</label>
        <button className="btn-primary">Create goal</button>
      </form>
      <form className="card space-y-2" onSubmit={submit('/admin/donations/expenditure', (f) => ({ category: f.get('category'), description: f.get('description'), amountKes: Number(f.get('amountKes')), spentOn: f.get('spentOn'), documentReference: f.get('documentReference') }))}>
        <h2 className="font-bold">Record operating expenditure</h2>
        <select name="category" className="input">{['HOSTING', 'ELECTION_DATA', 'BUDGET_RESEARCH', 'PUBLIC_REPORTING', 'SECURITY_MAINTENANCE', 'ACCESSIBILITY_OUTREACH', 'PAYMENT_FEES', 'ADMINISTRATION', 'OTHER'].map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</select>
        <input name="description" className="input" placeholder="Description" required />
        <input name="amountKes" type="number" min={1} step="0.01" className="input" placeholder="Amount (KSh)" required />
        <input name="spentOn" type="date" className="input" required />
        <input name="documentReference" className="input" placeholder="Invoice / receipt reference" required />
        <button className="btn-primary">Save (unpublished)</button>
      </form>
      <form className="card space-y-2" onSubmit={submit('/admin/donations/reports', (f) => ({ title: f.get('title'), periodStart: f.get('periodStart'), periodEnd: f.get('periodEnd'), narrative: f.get('narrative') || undefined }))}>
        <h2 className="font-bold">Publish a period report</h2>
        <input name="title" className="input" placeholder="e.g. Q3 2026 donations & expenditure" required />
        <div className="flex gap-2"><input name="periodStart" type="date" className="input" required /><input name="periodEnd" type="date" className="input" required /></div>
        <textarea name="narrative" className="input" placeholder="Narrative" />
        <button className="btn-primary">Publish report</button>
      </form>
      <div className="card lg:col-span-3 overflow-x-auto">
        <h2 className="font-bold">Expenditure records</h2>
        <table className="table"><tbody>{exp.data?.items.map((e) => <tr key={e._id}><td>{fmtDate(e.spentOn)}</td><td>{humanize(e.category)}</td><td>{e.description}</td><td>{fmtKes(e.amountCents / 100)}</td><td>{e.documentReference}</td><td>{e.published ? 'Published' : <button className="link" onClick={async () => { try { await api(`/admin/donations/expenditure/${e._id}/publish`, { body: {} }); void exp.reload(); } catch (x) { setMsg({ err: (x as Error).message }); } }}>Publish</button>}</td></tr>)}</tbody></table>
      </div>
    </div>
  );
}
