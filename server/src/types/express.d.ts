import type { Role } from '../models/identity.js';

export interface AuthUser {
  id: string;
  role: Role;
  fullName: string;
  sessionId: string;
  mfa: boolean;
  scope: { countyIds: string[]; constituencyIds: string[] };
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      requestId?: string;
    }
  }
}

export {};
