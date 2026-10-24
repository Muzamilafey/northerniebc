import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { fmtDate, humanize } from '../lib/format';

export function Logo({ size = 40, withText = true }: { size?: number; withText?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <img src="/brand/logo.svg" width={size} height={size} alt="The Northern IEBC logo" className="shrink-0" />
      {withText && (
        <span className="leading-tight">
          <span className="block font-bold tracking-tight">The Northern IEBC</span>
          <span className="block text-xs opacity-80">Follow the Vote. Follow the Money.</span>
        </span>
      )}
    </span>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 p-6 text-gray-600">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-navy-700" />
      {label}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: Error | string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <p className="flex items-start gap-2">
        <svg viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true"><path fillRule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-5a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 10 5Zm0 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" /></svg>
        <span>{typeof error === 'string' ? error : error.message}</span>
      </p>
      {onRetry && (
        <button className="btn-outline mt-2" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-300 bg-white px-6 py-10 text-center">
      <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-gray-100 text-gray-400" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-6 w-6"><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.63 10.63a2.25 2.25 0 0 1-2.24 2.12H6.62a2.25 2.25 0 0 1-2.24-2.12L3.75 7.5M10 11.25h4M3.38 7.5h17.25c.62 0 1.12-.5 1.12-1.12v-1.5c0-.63-.5-1.13-1.12-1.13H3.38c-.63 0-1.13.5-1.13 1.13v1.5c0 .62.5 1.12 1.13 1.12Z" /></svg>
      </span>
      <p className="font-semibold text-gray-800">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-md text-sm text-gray-600">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** A titled card: header with optional description and actions, then content. */
export function Panel({ title, description, actions, children, className = '', flush = false }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            {title && <h2 className="text-base font-bold text-navy-900">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-gray-600">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
      {flush ? <div className="table-wrap">{children}</div> : children}
    </section>
  );
}

export function Success({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="flex items-start gap-2 rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-800">
      <svg viewBox="0 0 20 20" fill="currentColor" className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true"><path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.86-9.81a.75.75 0 0 0-1.22-.88l-3.24 4.53-1.62-1.62a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.1l3.75-5.24Z" clipRule="evenodd" /></svg>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Honest placeholder when verified data has not been published. */
export function DataUnavailable({ what }: { what: string }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <strong>Not available.</strong> {what} has not been published from a verified source yet. Missing figures are never shown as zero.
    </div>
  );
}

const STATUS_STYLES: Record<string, [string, string]> = {
  NO_RESULTS: ['No results received', 'bg-gray-100 text-gray-700'],
  AWAITING_VERIFICATION: ['Awaiting verification', 'bg-amber-100 text-amber-900'],
  PROVISIONAL: ['Provisional agent-reported results', 'bg-orange-100 text-orange-900'],
  VERIFIED: ['Verified monitoring results', 'bg-teal-600/10 text-teal-700'],
  MATCHED_OFFICIAL: ['Matched against official IEBC records', 'bg-blue-100 text-blue-900'],
  OFFICIAL: ['Official result (per official publication)', 'bg-navy-100 text-navy-900'],
  UNVERIFIED: ['Unverified', 'bg-gray-100 text-gray-700'],
  OFFICIAL_SOURCE_REPORTED: ['Official-source reported', 'bg-blue-100 text-blue-900'],
  INDEPENDENTLY_VERIFIED: ['Independently verified', 'bg-teal-600/10 text-teal-700'],
  INDEPENDENTLY_INSPECTED: ['Independently inspected', 'bg-teal-600/10 text-teal-700'],
  DISPUTED: ['Disputed', 'bg-red-100 text-red-800'],
  SUBMITTED: ['Submitted', 'bg-blue-100 text-blue-900'],
  UNDER_REVIEW: ['Under review', 'bg-amber-100 text-amber-900'],
  REJECTED: ['Rejected', 'bg-red-100 text-red-800'],
  PENDING: ['Pending', 'bg-amber-100 text-amber-900'],
  SUCCESSFUL: ['Confirmed', 'bg-green-100 text-green-800'],
  FAILED: ['Failed', 'bg-red-100 text-red-800'],
  CANCELLED: ['Cancelled', 'bg-gray-100 text-gray-700'],
  PLANNED: ['Planned', 'bg-gray-100 text-gray-700'],
  ONGOING: ['Ongoing', 'bg-blue-100 text-blue-900'],
  COMPLETED: ['Completed (documented)', 'bg-green-100 text-green-800'],
  DELAYED: ['Delayed', 'bg-amber-100 text-amber-900'],
  SUSPENDED: ['Suspended', 'bg-red-100 text-red-800'],
  PUBLISHED: ['Published', 'bg-green-100 text-green-800'],
  IMPORTED: ['Imported', 'bg-gray-100 text-gray-700'],
  VALIDATED: ['Validated', 'bg-blue-100 text-blue-900'],
  REVIEWED: ['Reviewed', 'bg-teal-600/10 text-teal-700']
};

export function StatusBadge({ status }: { status?: string | null }) {
  if (!status) return null;
  const [label, cls] = STATUS_STYLES[status] ?? [humanize(status), 'bg-gray-100 text-gray-700'];
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}>{label}</span>;
}

export interface SourceInfo {
  _id?: string;
  name?: string;
  documentTitle?: string;
  url?: string;
  publicationDate?: string;
  publisher?: string;
}

export function SourceRef({ source, page, className = '' }: { source?: SourceInfo | null | string; page?: string | null; className?: string }) {
  if (!source || typeof source === 'string') return <span className={`text-xs text-gray-500 ${className}`}>Source: not recorded</span>;
  const label = source.documentTitle ? `${source.name} — ${source.documentTitle}` : source.name;
  return (
    <span className={`text-xs text-gray-600 ${className}`}>
      Source:{' '}
      {source.url ? (
        <a className="link" href={source.url} target="_blank" rel="noopener noreferrer">
          {label}
        </a>
      ) : (
        label
      )}
      {page ? `, p. ${page}` : ''}
      {source.publicationDate ? ` (published ${fmtDate(source.publicationDate)})` : ''}
    </span>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-navy-900 sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-3xl text-sm text-gray-600 sm:text-base">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card relative overflow-hidden">
      <span className="absolute inset-y-0 left-0 w-1 bg-brand-500/70" aria-hidden="true" />
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1.5 text-3xl font-bold tabular-nums text-navy-900">{value}</p>
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

export function Pager({ page, total, limit, onPage }: { page: number; total: number; limit: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) return null;
  return (
    <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Pagination">
      <button className="btn-outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <span>
        Page {page} of {pages} ({total} items)
      </span>
      <button className="btn-outline" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </nav>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-500">{hint}</span>}
    </label>
  );
}

export function Independence({ compact = false }: { compact?: boolean }) {
  return (
    <p className={`text-xs ${compact ? '' : 'rounded-lg bg-navy-50 p-3'} text-gray-700`}>
      The Northern IEBC is an independently operated public-interest platform. It is <strong>not affiliated with or endorsed by</strong> the Independent Electoral and Boundaries Commission (IEBC) or any government body. Monitoring figures are not official declarations. <Link to="/about" className="link">Methodology &amp; corrections</Link>
    </p>
  );
}

/** Public image (county logo, party logo, aspirant photo) with an initials fallback. */
export function PublicImage({ fileId, alt, size = 40, rounded = 'rounded-md', fallback }: { fileId?: string | null; alt: string; size?: number; rounded?: string; fallback?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!fileId || failed === fileId) {
    const initials = (fallback ?? alt).split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
    return (
      <span aria-hidden="true" title={fileId ? 'Image unavailable' : undefined} className={`inline-flex shrink-0 items-center justify-center bg-gray-100 text-xs font-bold text-gray-500 ${rounded}`} style={{ width: size, height: size }}>
        {initials || '?'}
      </span>
    );
  }
  return <img src={`/api/files/${fileId}`} alt={alt} width={size} height={size} loading="lazy" onError={() => setFailed(fileId)} className={`shrink-0 object-contain ${rounded}`} style={{ width: size, height: size }} />;
}

/** Pill-style single choice (filters, record types). */
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number }[]; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex max-w-full flex-wrap gap-1 rounded-xl bg-gray-100 p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${value === o.value ? 'bg-white text-navy-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
        >
          {o.label}
          {o.count != null && <span className="ml-1.5 rounded-full bg-gray-200 px-1.5 text-xs text-gray-700">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}
