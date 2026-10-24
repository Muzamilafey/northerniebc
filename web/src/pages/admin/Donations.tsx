import { useState, type FormEvent } from 'react';
import { api, download } from '../../lib/api';
import { Empty, ErrorBox, Field, PageHeader, Pager, Panel, Segmented, Stat, StatusBadge, Success } from '../../components/ui';
import { Icon } from '../../components/icons';
import { fmtDate, fmtDateTime, fmtKes, humanize } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import { Modal, ModalActions, useDialog } from '../../components/Dialog';

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
  const [tab, setTab] = useState<'payments' | 'funds'>('payments');
  const providerState = (p: { operational: boolean; configured: boolean; mode: string }) => (p.operational ? [`Live (${p.mode})`, 'bg-green-100 text-green-800'] : p.configured ? ['Configured — not attested', 'bg-amber-100 text-amber-900'] : ['Awaiting setup', 'bg-gray-100 text-gray-600']);
  return (
    <div className="space-y-6">
      <PageHeader title="Donations" subtitle="Only provider-confirmed payments count. Manual reconciliation and refunds require a second authorised person." actions={<div className="flex gap-2"><button className="btn-outline" onClick={() => void download('/exports/donations', { format: 'csv' })}>Export CSV</button><button className="btn-outline" onClick={() => void download('/exports/donations', { format: 'xlsx' })}>Export Excel</button></div>} />
      <Segmented label="Section" value={tab} onChange={setTab} options={[{ value: 'payments', label: 'Payments' }, { value: 'funds', label: 'Goals, spending & reports' }]} />
      {msg.ok && <Success>{msg.ok}</Success>}
      {msg.err && <ErrorBox error={msg.err} />}
      {tab === 'funds' && <GoalsAndExpenditure />}
      {tab === 'payments' && s && (
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
            <Panel title="Payment providers">
              <ul className="divide-y divide-gray-100 text-sm">{s.providers.map((p) => { const [l, c] = providerState(p); return <li key={p.id} className="flex items-center justify-between gap-2 py-2"><span className="font-medium">{p.method}</span><span className={`badge ${c}`}>{l}</span></li>; })}</ul>
            </Panel>
            <Panel title="By month">
              {s.byMonth.length ? <ul className="divide-y divide-gray-100 text-sm">{s.byMonth.map((m) => <li key={`${m._id.month}${m._id.currency}`} className="flex justify-between py-2"><span>{m._id.month}</span><span className="tabular-nums">{m._id.currency} {(m.gross / 100).toLocaleString()} <span className="text-gray-500">({m.n})</span></span></li>)}</ul> : <p className="text-sm text-gray-500">No confirmed donations yet.</p>}
            </Panel>
            <Panel title="By method">
              {s.byMethod.length ? <ul className="divide-y divide-gray-100 text-sm">{s.byMethod.map((m) => <li key={`${m._id.method}${m._id.currency}`} className="flex justify-between py-2"><span>{m._id.method}</span><span className="tabular-nums">{m._id.currency} {(m.gross / 100).toLocaleString()} <span className="text-gray-500">({m.n})</span></span></li>)}</ul> : <p className="text-sm text-gray-500">No confirmed donations yet.</p>}
            </Panel>
          </div>
        </>
      )}
      {tab === 'payments' && (
        <Panel title="Payments" actions={<Segmented label="Payment status" value={filter.reconciliation ? 'RECONCILE' : filter.status ?? ''} onChange={(st) => { setFilter(st === 'RECONCILE' ? { reconciliation: 'true' } : st ? { status: st } : {}); setPage(1); }} options={['', 'PENDING', 'SUCCESSFUL', 'FAILED', 'REFUND_PENDING', 'REFUNDED', 'RECONCILE'].map((st) => ({ value: st, label: st === 'RECONCILE' ? 'Needs reconciling' : st ? humanize(st) : 'All' }))} />}>
          {list.data?.items.length === 0 ? <Empty title="No payments here">Payments appear once donors start a payment.</Empty> : (
            <div className="table-wrap"><table className="table"><thead><tr><th>Reference</th><th>Created</th><th className="text-right">Amount</th><th>Method</th><th>Status</th><th>Provider ref.</th><th><span className="sr-only">Open</span></th></tr></thead>
              <tbody>{list.data?.items.map((d) => <tr key={d._id}><td className="font-medium">{d.reference}{d.needsReconciliation && <span className="badge ml-2 bg-red-100 text-red-800">Reconcile</span>}</td><td className="whitespace-nowrap text-xs text-gray-600">{fmtDateTime(d.createdAt)}</td><td className="text-right tabular-nums">{d.currency} {(d.amountCents / 100).toLocaleString()}</td><td>{d.method}{d.providerMode === 'sandbox' && <span className="text-xs text-gray-500"> (sandbox)</span>}</td><td><StatusBadge status={d.status} /></td><td className="text-xs">{d.providerReceipt ?? '—'}</td><td className="text-right"><button className="btn-outline btn-sm" onClick={() => setSelected(d._id)}>Open</button></td></tr>)}</tbody></table></div>
          )}
          {list.data && <Pager page={page} total={list.data.total} limit={list.data.limit} onPage={setPage} />}
        </Panel>
      )}
      {selected && (
        <Modal title="Donation" icon={false} size="lg" onClose={() => setSelected(null)}>
          <DonationDetail id={selected} onDone={(m) => { setMsg(m); void list.reload(); void summary.reload(); }} />
        </Modal>
      )}
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
    <section className="space-y-4">
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
        <form className="grid gap-3 rounded-xl border border-gray-200 p-4 sm:grid-cols-2" onSubmit={reconcile}>
          <p className="text-sm font-semibold sm:col-span-2">Manual reconciliation (needs provider evidence and a second approver)</p>
          <Field label="Outcome"><select name="outcome" className="input"><option value="SUCCESSFUL">Payment received</option><option value="FAILED">Payment not received</option></select></Field>
          <Field label="Provider transaction reference"><input name="providerReceipt" className="input" /></Field>
          <Field label="Statement / evidence (PDF or image)"><input name="evidence" type="file" required accept="application/pdf,image/*" className="input" /></Field>
          <Field label="Note"><textarea name="note" className="input" required minLength={20} /></Field>
          <div className="sm:col-span-2"><button className="btn-accent">Request reconciliation</button></div>
        </form>
      )}
    </section>
  );
}

function GoalsAndExpenditure() {
  const exp = useApi<{ items: { _id: string; category: string; description: string; amountCents: number; spentOn: string; documentReference: string; published: boolean }[] }>('/admin/donations/expenditure/list');
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [open, setOpen] = useState<'goal' | 'expense' | 'report' | null>(null);
  const submit = (path: string, conv: (f: FormData) => unknown, ok: string) => async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setMsg({});
    try {
      await api(path, { body: conv(new FormData(e.currentTarget)) });
      setMsg({ ok });
      setOpen(null);
      void exp.reload();
    } catch (x) {
      setMsg({ err: (x as Error).message });
    }
  };
  const close = () => setOpen(null);
  const errBox = msg.err && <div className="sm:col-span-2"><ErrorBox error={msg.err} /></div>;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {([['goal', 'New fundraising goal', 'Set a target and period donors can see.'], ['expense', 'Record expenditure', 'Log spending with its invoice or receipt.'], ['report', 'Publish a period report', 'Summarise donations and spending for a period.']] as const).map(([k, t, d]) => (
          <button key={k} className="card flex items-start gap-3 text-left transition hover:border-brand-500 hover:shadow-md" onClick={() => { setMsg({}); setOpen(k); }}>
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700" aria-hidden="true"><Icon name="plus" className="h-4 w-4" /></span>
            <span><span className="block font-semibold text-navy-900">{t}</span><span className="block text-sm text-gray-600">{d}</span></span>
          </button>
        ))}
      </div>
      {msg.ok && <Success>{msg.ok}</Success>}
      {msg.err && !open && <ErrorBox error={msg.err} />}
      <Panel title="Expenditure records" description="Unpublished records are visible only to staff until published.">
        {exp.data?.items.length === 0 ? <Empty title="No expenditure recorded yet" /> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Date</th><th>Category</th><th>Description</th><th className="text-right">Amount</th><th>Document</th><th><span className="sr-only">Status</span></th></tr></thead>
            <tbody>{exp.data?.items.map((e) => <tr key={e._id}><td className="whitespace-nowrap">{fmtDate(e.spentOn)}</td><td>{humanize(e.category)}</td><td>{e.description}</td><td className="text-right tabular-nums">{fmtKes(e.amountCents / 100)}</td><td className="text-xs">{e.documentReference}</td><td className="text-right">{e.published ? <span className="badge bg-green-100 text-green-800">Published</span> : <button className="btn-outline btn-sm" onClick={async () => { try { await api(`/admin/donations/expenditure/${e._id}/publish`, { body: {} }); void exp.reload(); } catch (x) { setMsg({ err: (x as Error).message }); } }}>Publish</button>}</td></tr>)}</tbody></table></div>
        )}
      </Panel>

      {open === 'goal' && (
        <Modal title="New fundraising goal" icon={false} size="lg" onClose={close}>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit('/admin/donations/goals', (f) => ({ title: f.get('title'), category: f.get('category'), targetKes: Number(f.get('targetKes')), periodStart: f.get('periodStart'), periodEnd: f.get('periodEnd'), restricted: f.get('restricted') === 'on', description: f.get('description') || undefined }), 'Goal created.')}>
            <div className="sm:col-span-2"><Field label="Title"><input name="title" className="input" required autoFocus /></Field></div>
            <Field label="Category"><select name="category" className="input">{['GENERAL', 'HOSTING', 'ELECTION_DATA', 'BUDGET_RESEARCH', 'PUBLIC_REPORTING', 'SECURITY_MAINTENANCE', 'ACCESSIBILITY_OUTREACH'].map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</select></Field>
            <Field label="Target (KSh)"><input name="targetKes" type="number" min={1} className="input" required /></Field>
            <Field label="Starts"><input name="periodStart" type="date" className="input" required /></Field>
            <Field label="Ends"><input name="periodEnd" type="date" className="input" required /></Field>
            <div className="sm:col-span-2"><Field label="Description (optional)"><textarea name="description" className="input" rows={3} /></Field></div>
            <label className="flex items-start gap-3 rounded-lg border border-gray-200 p-3 text-sm sm:col-span-2"><input type="checkbox" name="restricted" className="mt-0.5" /> <span>Restricted fund <span className="block text-xs text-gray-500">Only if a legally separate restricted fund exists.</span></span></label>
            {errBox}
            <div className="sm:col-span-2"><ModalActions onCancel={close} confirmLabel="Create goal" tone="accent" /></div>
          </form>
        </Modal>
      )}
      {open === 'expense' && (
        <Modal title="Record expenditure" description="Saved unpublished; publish it from the list when ready." icon={false} size="lg" onClose={close}>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit('/admin/donations/expenditure', (f) => ({ category: f.get('category'), description: f.get('description'), amountKes: Number(f.get('amountKes')), spentOn: f.get('spentOn'), documentReference: f.get('documentReference') }), 'Expenditure saved (unpublished).')}>
            <Field label="Category"><select name="category" className="input">{['HOSTING', 'ELECTION_DATA', 'BUDGET_RESEARCH', 'PUBLIC_REPORTING', 'SECURITY_MAINTENANCE', 'ACCESSIBILITY_OUTREACH', 'PAYMENT_FEES', 'ADMINISTRATION', 'OTHER'].map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</select></Field>
            <Field label="Amount (KSh)"><input name="amountKes" type="number" min={1} step="0.01" className="input" required /></Field>
            <div className="sm:col-span-2"><Field label="Description"><input name="description" className="input" required /></Field></div>
            <Field label="Date spent"><input name="spentOn" type="date" className="input" required /></Field>
            <Field label="Invoice / receipt reference"><input name="documentReference" className="input" required /></Field>
            {errBox}
            <div className="sm:col-span-2"><ModalActions onCancel={close} confirmLabel="Save" /></div>
          </form>
        </Modal>
      )}
      {open === 'report' && (
        <Modal title="Publish a period report" description="The report is public as soon as it is published." icon={false} size="lg" onClose={close}>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={submit('/admin/donations/reports', (f) => ({ title: f.get('title'), periodStart: f.get('periodStart'), periodEnd: f.get('periodEnd'), narrative: f.get('narrative') || undefined }), 'Report published.')}>
            <div className="sm:col-span-2"><Field label="Title"><input name="title" className="input" placeholder="e.g. Q3 2026 donations & expenditure" required autoFocus /></Field></div>
            <Field label="Period starts"><input name="periodStart" type="date" className="input" required /></Field>
            <Field label="Period ends"><input name="periodEnd" type="date" className="input" required /></Field>
            <div className="sm:col-span-2"><Field label="Narrative (optional)"><textarea name="narrative" className="input" rows={4} /></Field></div>
            {errBox}
            <div className="sm:col-span-2"><ModalActions onCancel={close} confirmLabel="Publish report" tone="accent" /></div>
          </form>
        </Modal>
      )}
    </div>
  );
}
