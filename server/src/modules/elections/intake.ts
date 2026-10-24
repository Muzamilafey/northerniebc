/**
 * Whether an election is receiving results from agents right now. Administrators can pause
 * intake, leave it open, or schedule an opening and closing time; times are stored in UTC and
 * shown in East Africa Time (UTC+3, no daylight saving), the time used across Kenya.
 */
export type IntakeMode = 'OPEN' | 'CLOSED' | 'SCHEDULED';
export interface IntakeConfig { mode?: IntakeMode | null; opensAt?: Date | string | null; closesAt?: Date | string | null }
export interface IntakeState { open: boolean; mode: IntakeMode; opensAt: string | null; closesAt: string | null; message: string }

const EAT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
export const fmtEat = (d: Date) => `${EAT.format(d)} EAT`;

export function intakeState(election: { status: string; resultsIntake?: IntakeConfig | null }, now = new Date()): IntakeState {
  const cfg = election.resultsIntake ?? {};
  const mode: IntakeMode = cfg.mode ?? 'OPEN';
  const opensAt = cfg.opensAt ? new Date(cfg.opensAt) : null;
  const closesAt = cfg.closesAt ? new Date(cfg.closesAt) : null;
  const base = { mode, opensAt: opensAt?.toISOString() ?? null, closesAt: closesAt?.toISOString() ?? null };
  if (election.status !== 'ACTIVE') return { ...base, open: false, message: 'This election is not accepting results.' };
  if (mode === 'CLOSED') return { ...base, open: false, message: 'Receiving results is paused by the administrators.' };
  if (mode === 'SCHEDULED') {
    if (opensAt && now < opensAt) return { ...base, open: false, message: `Results open at ${fmtEat(opensAt)}.` };
    if (closesAt && now >= closesAt) return { ...base, open: false, message: `Results closed at ${fmtEat(closesAt)}.` };
    return { ...base, open: true, message: closesAt ? `Receiving results until ${fmtEat(closesAt)}.` : 'Receiving results.' };
  }
  return { ...base, open: true, message: 'Receiving results.' };
}
