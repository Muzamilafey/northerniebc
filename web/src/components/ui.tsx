import type { ReactNode } from 'react';
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
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      <p>{typeof error === 'string' ? error : error.message}</p>
      {onRetry && (
        <button className="btn-outline mt-2" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 bg-white p-6 text-center">
      <p className="font-semibold text-gray-800">{title}</p>
      {children && <div className="mt-1 text-sm text-gray-600">{children}</div>}
    </div>
  );
}

export function Success({ children }: { children: ReactNode }) {
  return <div role="status" className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">{children}</div>;
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
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold text-navy-900 sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 max-w-3xl text-gray-600">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-navy-900">{value}</p>
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
