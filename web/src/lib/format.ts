export const fmtNumber = (n?: number | null) => (n == null ? '—' : n.toLocaleString('en-KE'));
export const fmtKes = (n?: number | null) => (n == null ? 'Not available' : `KSh ${n.toLocaleString('en-KE', { maximumFractionDigits: 2 })}`);
export function fmtKesShort(n?: number | null) {
  if (n == null) return 'Not available';
  const a = Math.abs(n);
  if (a >= 1e9) return `KSh ${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `KSh ${(n / 1e6).toFixed(1)}M`;
  return fmtKes(n);
}
export const fmtPct = (n?: number | null) => (n == null ? '—' : `${n.toLocaleString('en-KE', { maximumFractionDigits: 2 })}%`);
export const fmtDate = (d?: string | Date | null) => (d ? new Date(d).toLocaleDateString('en-KE', { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
export const fmtDateTime = (d?: string | Date | null) => (d ? new Date(d).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const humanize = (s?: string | null) => (s ? s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : '');
export const POSITION_LABELS: Record<string, string> = {
  PRESIDENT: 'President',
  GOVERNOR: 'Governor',
  SENATOR: 'Senator',
  WOMAN_REP: 'Woman Representative',
  MP: 'Member of Parliament',
  MCA: 'Member of County Assembly'
};
export const POSITIONS = Object.keys(POSITION_LABELS);
