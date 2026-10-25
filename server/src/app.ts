import crypto from 'node:crypto';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { corsOrigins, env } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { apiLimiter, liveResultsLimiter, rejectMongoOperators } from './middleware/security.js';
import { accountabilityAdminRouter, accountabilityPublicRouter } from './modules/accountability/routes.js';
import { approvalsRouter } from './modules/approvals/routes.js';
import { auditLogRouter } from './modules/auditlog/routes.js';
import { authRouter } from './modules/auth/routes.js';
import { donationsAdminRouter, donationsPublicRouter, paymentCallbacksRouter } from './modules/donations/routes.js';
import { electionsAdminRouter, electionsPublicRouter } from './modules/elections/routes.js';
import { partiesAdminRouter } from './modules/parties/routes.js';
import { exportsRouter } from './modules/exports/routes.js';
import { filesRouter } from './modules/files/routes.js';
import { financeAdminRouter, financePublicRouter } from './modules/finance/routes.js';
import { healthRouter } from './modules/health/routes.js';
import { importsRouter } from './modules/imports/routes.js';
import { projectsAdminRouter, projectsPublicRouter } from './modules/projects/routes.js';
import { agentRouter, publicResultsRouter, verificationRouter } from './modules/results/routes.js';
import { searchRouter } from './modules/search/routes.js';
import { siteAdminRouter, sitePublicRouter } from './modules/site/routes.js';
import { usersRouter } from './modules/users/routes.js';
import { settingsRouter } from './modules/settings/routes.js';
import { registrationRouter } from './modules/registration/routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.set('query parser', 'simple');

  app.use((req, res, next) => {
    req.requestId = (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) ?? crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
  });
  app.use(pinoHttp({ logger, genReqId: (req) => (req as express.Request).requestId!, autoLogging: { ignore: (req) => req.url === '/healthz' } }));
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      strictTransportSecurity: { maxAge: 63072000, includeSubDomains: true, preload: false }
    })
  );
  app.use(cors({ origin: (origin, cb) => cb(null, !origin || corsOrigins.includes(origin)), credentials: true, maxAge: 600 }));

  app.use(healthRouter());
  // Payment callbacks need their own body parsers (raw body for signature checks).
  app.use('/api/payments', paymentCallbacksRouter());

  app.use(express.json({ limit: '200kb' }));
  app.use(express.urlencoded({ extended: false, limit: '200kb' }));
  app.use(cookieParser());
  app.use(rejectMongoOperators);
  app.use('/api/public/results', liveResultsLimiter());
  app.use('/api', apiLimiter());

  app.use('/api/auth', authRouter());

  // Public, unauthenticated read APIs.
  app.use('/api/public', electionsPublicRouter(), publicResultsRouter(), financePublicRouter(), projectsPublicRouter(), accountabilityPublicRouter(), searchRouter(), sitePublicRouter());
  app.use('/api/donations', donationsPublicRouter());
  app.use('/api/exports', exportsRouter());
  app.use('/api/files', filesRouter());

  // Role-specific portals.
  app.use('/api/agent', agentRouter());
  app.use('/api/verification', verificationRouter());
  app.use('/api/admin', usersRouter(), partiesAdminRouter(), electionsAdminRouter(), financeAdminRouter(), projectsAdminRouter(), accountabilityAdminRouter(), siteAdminRouter());
  app.use('/api/admin/imports', importsRouter());
  app.use('/api/admin/donations', donationsAdminRouter());
  app.use('/api/admin/audit-log', auditLogRouter());
  app.use('/api/approvals', approvalsRouter());
  app.use('/api/admin/settings', settingsRouter());
  app.use('/api/agent-registration', registrationRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
