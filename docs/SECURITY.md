# Security

| Threat | Control |
| --- | --- |
| Credential attacks | Argon2id (m=19 MiB, t=2); per-account lockout (5 failures → 15 min); per-IP login rate limit (memory or Redis); identical error messages; timing-equalised unknown-user path |
| Account takeover | TOTP MFA required for all privileged roles before any privileged action; recovery codes stored hashed; password reset tokens hashed, 30-minute expiry; reset and password change revoke other sessions |
| Session theft | 15-minute access JWT in memory only; httpOnly SameSite=Strict refresh cookie scoped to `/api/auth`; rotation with reuse detection (reuse revokes the whole family); role, status and session re-checked from the DB on every request; shorter refresh lifetime (12 h) for privileged roles |
| CSRF | Cookie endpoints require same-origin `Origin` and `X-Requested-With`; all other APIs use bearer tokens |
| Broken access control | Permission matrix plus geographic scope enforced server-side on every route; agents act only on active assignments; reviewers cannot review their own work; second-person rules for imports, publication, result corrections, reconciliation and refunds |
| NoSQL injection | zod validation of every input; rejection of keys containing `$` or `.`; `strictQuery`; regex input escaped |
| XSS | React output escaping; strict CSP on API and site; no `dangerouslySetInnerHTML` |
| Malicious uploads | Size limits; magic-byte type detection (client MIME ignored); ClamAV scan; files stored outside the web root with random names; not served until clean; private by default; served with `nosniff` and a sandboxed CSP |
| Replay / duplicates | Idempotency keys (results, donations); deduplicated payment callbacks (unique keys); conditional state transitions (a donation can be confirmed at most once) |
| Payment spoofing | Secret callback path token plus optional IP allowlist; M-Pesa success double-checked by STK status query; amount and currency validated; Paystack HMAC-SHA512; PayPal webhook verification; hosted checkout (no card data touches the server) |
| Data leaks | Public APIs read only published or aggregated data; agent identity and evidence never public; donor and reporter contact data AES-256-GCM encrypted at rest; blind index for phone lookups; logger redaction of secrets and contact data; sensitive exports permission-checked and audit-logged |
| Tampering | Hash-chained, append-only audit log with content hashes; verification endpoint and CLI; restore test re-verifies the chain on backups |
| Abuse of public forms | Rate limits, honeypot, optional Cloudflare Turnstile, duplicate detection, moderation, abuse reports |
| Transport | HTTPS only in production (enforced at boot), HSTS, TLS 1.2+ |

**Testing status.** The automated suites in `server/test` cover authentication, authorisation, injection, oversize bodies, headers, audit tamper detection, idempotency and payment callback abuse. No external penetration test has been performed. Do not describe the platform as production-ready or secure until one has been completed, and until the go-live checklist in DEPLOYMENT.md is done.
