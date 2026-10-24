import { pino } from 'pino';
import { env, isProd } from '../config/env.js';

/**
 * Paths are redacted everywhere a request, body or error may be logged. Secrets,
 * credentials and personal data must never reach the log stream.
 */
export const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
  '*.mfaCode',
  '*.secret',
  '*.phone',
  '*.phoneNumber',
  '*.PhoneNumber',
  '*.PartyA',
  '*.Password',
  '*.email',
  '*.consumerSecret',
  '*.passkey',
  '*.SecurityCredential',
  '*.authorization',
  '*.Authorization'
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  base: { service: 'northern-iebc-api' },
  ...(isProd || env.NODE_ENV === 'test'
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true } } })
});
