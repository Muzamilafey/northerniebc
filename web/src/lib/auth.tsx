import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, refreshSession, setToken } from './api';

export type Role = 'SUPER_ADMIN' | 'REGIONAL_ADMIN' | 'COUNTY_ADMIN' | 'CONSTITUENCY_SUPERVISOR' | 'VERIFICATION_OFFICER' | 'FINANCE_OFFICER' | 'AGENT';

export interface User {
  id: string;
  fullName: string;
  email: string;
  role: Role;
  agentCode?: string | null;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  scope: { countyIds: string[]; constituencyIds: string[] };
}

interface AuthState {
  user: User | null;
  loading: boolean;
  mfaSetupRequired: boolean;
  signIn(identifier: string, password: string): Promise<{ mfaToken?: string }>;
  verifyMfa(mfaToken: string, code: string): Promise<void>;
  signOut(): Promise<void>;
  reload(): Promise<void>;
  setSession(token: string, user: User, mfaSetupRequired: boolean): void;
}

const Ctx = createContext<AuthState | null>(null);

export const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: 'Super Administrator',
  REGIONAL_ADMIN: 'Regional Administrator',
  COUNTY_ADMIN: 'County Administrator',
  CONSTITUENCY_SUPERVISOR: 'Constituency Supervisor',
  VERIFICATION_OFFICER: 'Verification Officer',
  FINANCE_OFFICER: 'Finance Officer',
  AGENT: 'Polling-Station Agent'
};

/** UI-only hints for navigation. The server enforces every permission independently. */
export const can = {
  monitor: (r?: Role) => !!r && ['SUPER_ADMIN', 'REGIONAL_ADMIN', 'COUNTY_ADMIN', 'CONSTITUENCY_SUPERVISOR', 'VERIFICATION_OFFICER'].includes(r),
  verify: (r?: Role) => !!r && ['SUPER_ADMIN', 'REGIONAL_ADMIN', 'VERIFICATION_OFFICER'].includes(r),
  manageUsers: (r?: Role) => !!r && ['SUPER_ADMIN', 'REGIONAL_ADMIN', 'COUNTY_ADMIN', 'CONSTITUENCY_SUPERVISOR'].includes(r),
  elections: (r?: Role) => r === 'SUPER_ADMIN',
  finance: (r?: Role) => !!r && ['SUPER_ADMIN', 'REGIONAL_ADMIN', 'COUNTY_ADMIN', 'FINANCE_OFFICER', 'VERIFICATION_OFFICER'].includes(r),
  donations: (r?: Role) => !!r && ['SUPER_ADMIN', 'FINANCE_OFFICER'].includes(r),
  moderate: (r?: Role) => !!r && ['SUPER_ADMIN', 'REGIONAL_ADMIN', 'COUNTY_ADMIN', 'VERIFICATION_OFFICER'].includes(r),
  audit: (r?: Role) => !!r && ['SUPER_ADMIN', 'REGIONAL_ADMIN'].includes(r)
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [mfaSetupRequired, setMfaSetupRequired] = useState(false);

  const setSession = useCallback((token: string, u: User, mfaReq: boolean) => {
    setToken(token);
    setUser(u);
    setMfaSetupRequired(mfaReq);
  }, []);

  const reload = useCallback(async () => {
    try {
      const r = await api<{ user: User }>('/auth/me');
      setUser(r.user);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    (async () => {
      if (await refreshSession()) await reload();
      setLoading(false);
    })();
  }, [reload]);

  const value: AuthState = {
    user,
    loading,
    mfaSetupRequired,
    setSession,
    reload,
    async signIn(identifier, password) {
      const r = await api<{ mfaRequired?: boolean; mfaToken?: string; accessToken?: string; user?: User; mfaSetupRequired?: boolean }>('/auth/login', { body: { identifier, password } });
      if (r.mfaRequired) return { mfaToken: r.mfaToken };
      setSession(r.accessToken!, r.user!, Boolean(r.mfaSetupRequired));
      return {};
    },
    async verifyMfa(mfaToken, code) {
      const r = await api<{ accessToken: string; user: User; mfaSetupRequired: boolean }>('/auth/mfa/verify', { body: { mfaToken, code } });
      setSession(r.accessToken, r.user, r.mfaSetupRequired);
    },
    async signOut() {
      await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
      setToken(null);
      setUser(null);
    }
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside provider');
  return c;
}
