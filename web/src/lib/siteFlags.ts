import { useEffect, useState } from 'react';
import { api } from './api';

export interface SiteFlags { agentLogin: boolean; open: boolean }
let cached: Promise<SiteFlags> | null = null;
const load = () => (cached ??= api<SiteFlags>('/agent-registration/config').catch(() => ({ agentLogin: true, open: false })));

/** Public switches set by administrators: agent sign-in and agent self-registration. */
export function useSiteFlags(): SiteFlags | null {
  const [flags, setFlags] = useState<SiteFlags | null>(null);
  useEffect(() => {
    let live = true;
    void load().then((f) => live && setFlags(f));
    return () => {
      live = false;
    };
  }, []);
  return flags;
}
