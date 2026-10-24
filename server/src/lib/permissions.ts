import { Types } from 'mongoose';
import type { Role } from '../models/identity.js';
import type { AuthUser } from '../types/express.js';

const ALL_ADMIN: Role[] = ['SUPER_ADMIN', 'REGIONAL_ADMIN'];

/**
 * Server-side permission matrix. Roles are read from the database on every request;
 * nothing the client sends can grant a permission.
 */
export const PERMISSIONS = {
  'users.manage': [...ALL_ADMIN, 'COUNTY_ADMIN'],
  'users.manage_privileged': ['SUPER_ADMIN'],
  'agents.manage': [...ALL_ADMIN, 'COUNTY_ADMIN', 'CONSTITUENCY_SUPERVISOR'],
  'elections.manage': ['SUPER_ADMIN'],
  'geography.import': [...ALL_ADMIN],
  'candidates.manage': [...ALL_ADMIN],
  'counties.manage': ['SUPER_ADMIN'],
  'results.submit': ['AGENT'],
  'results.monitor': [...ALL_ADMIN, 'COUNTY_ADMIN', 'CONSTITUENCY_SUPERVISOR', 'VERIFICATION_OFFICER'],
  'results.verify': [...ALL_ADMIN, 'VERIFICATION_OFFICER'],
  'results.official': [...ALL_ADMIN],
  'finance.import': [...ALL_ADMIN, 'COUNTY_ADMIN', 'FINANCE_OFFICER'],
  'finance.review': [...ALL_ADMIN, 'VERIFICATION_OFFICER', 'FINANCE_OFFICER'],
  'finance.publish': [...ALL_ADMIN],
  'projects.manage': [...ALL_ADMIN, 'COUNTY_ADMIN', 'FINANCE_OFFICER'],
  'sources.manage': [...ALL_ADMIN, 'FINANCE_OFFICER', 'VERIFICATION_OFFICER'],
  'citizen.moderate': [...ALL_ADMIN, 'COUNTY_ADMIN', 'VERIFICATION_OFFICER'],
  'donations.view': ['SUPER_ADMIN', 'FINANCE_OFFICER'],
  'donations.reconcile': ['SUPER_ADMIN', 'FINANCE_OFFICER'],
  'donations.refund': ['SUPER_ADMIN', 'FINANCE_OFFICER'],
  'donations.configure': ['SUPER_ADMIN', 'FINANCE_OFFICER'],
  'audit.view': [...ALL_ADMIN],
  'settings.manage': ['SUPER_ADMIN'],
  'exports.sensitive': [...ALL_ADMIN, 'FINANCE_OFFICER'],
  'files.read_private': [...ALL_ADMIN, 'COUNTY_ADMIN', 'CONSTITUENCY_SUPERVISOR', 'VERIFICATION_OFFICER', 'FINANCE_OFFICER']
} as const satisfies Record<string, Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(user: Pick<AuthUser, 'role'> | undefined, perm: Permission): boolean {
  if (!user) return false;
  return (PERMISSIONS[perm] as readonly Role[]).includes(user.role);
}

/** Roles that may create users of the given role. */
export function canAssignRole(actor: AuthUser, target: Role): boolean {
  if (actor.role === 'SUPER_ADMIN') return true;
  if (actor.role === 'REGIONAL_ADMIN') return target !== 'SUPER_ADMIN' && target !== 'REGIONAL_ADMIN';
  if (actor.role === 'COUNTY_ADMIN') return target === 'AGENT' || target === 'CONSTITUENCY_SUPERVISOR';
  if (actor.role === 'CONSTITUENCY_SUPERVISOR') return target === 'AGENT';
  return false;
}

export type GeoRef = { countyId?: unknown; constituencyId?: unknown };

/** Whether a scoped user may act on a record located in the given county/constituency. */
export function inScope(user: AuthUser, ref: GeoRef): boolean {
  switch (user.role) {
    case 'SUPER_ADMIN':
    case 'REGIONAL_ADMIN':
      return true;
    case 'COUNTY_ADMIN':
      return ref.countyId != null && user.scope.countyIds.includes(String(ref.countyId));
    case 'CONSTITUENCY_SUPERVISOR':
      return ref.constituencyId != null && user.scope.constituencyIds.includes(String(ref.constituencyId));
    case 'VERIFICATION_OFFICER':
    case 'FINANCE_OFFICER':
      return user.scope.countyIds.length === 0 || (ref.countyId != null && user.scope.countyIds.includes(String(ref.countyId)));
    default:
      return false;
  }
}

const oids = (ids: string[]) => ids.map((id) => new Types.ObjectId(id));

/** Mongo filter fragment (ObjectIds, so it is safe inside aggregation pipelines) restricting a query to the user's geographic scope. */
export function scopeFilter(user: AuthUser): Record<string, unknown> {
  switch (user.role) {
    case 'SUPER_ADMIN':
    case 'REGIONAL_ADMIN':
      return {};
    case 'COUNTY_ADMIN':
      return { countyId: { $in: oids(user.scope.countyIds) } };
    case 'CONSTITUENCY_SUPERVISOR':
      return { constituencyId: { $in: oids(user.scope.constituencyIds) } };
    case 'VERIFICATION_OFFICER':
    case 'FINANCE_OFFICER':
      return user.scope.countyIds.length ? { countyId: { $in: oids(user.scope.countyIds) } } : {};
    default:
      return { _id: null };
  }
}
