# API reference

Base path `/api`. JSON in and out. Errors are returned as `{ "error": { "code", "message", "details?" } }`.
Authenticated calls send `Authorization: Bearer <accessToken>`. Privileged roles must have completed MFA, or they receive 403.
The refresh token is an httpOnly cookie scoped to `/api/auth`. Cookie endpoints require `X-Requested-With: XMLHttpRequest` and an allowed `Origin`.

## Auth — `/api/auth`
| Method | Path | Notes |
|---|---|---|
| POST | `/login` | `{identifier (email or agent ID), password}` → `{accessToken, user, mfaSetupRequired}` or `{mfaRequired, mfaToken}` |
| POST | `/mfa/verify` | `{mfaToken, code}` (TOTP or recovery code) |
| POST | `/refresh`, `/logout` | cookie-based; refresh rotates the token |
| GET | `/me` | current user |
| POST | `/mfa/setup`, `/mfa/enable` | enrol TOTP; enable returns 10 one-time recovery codes |
| POST | `/password/change`, `/password/forgot`, `/password/reset` | forgot always returns 200 (no enumeration) |
| GET/DELETE | `/sessions`, `/sessions/:familyId` | list and revoke own sessions |

## Public (no auth) — `/api/public`
`GET /home`, `/counties`, `/counties/:slug`, `/updates`, `/elections`, `/elections/:id`, `/elections/:id/{constituencies?countyId,wards?constituencyId,stations?wardId,candidates?position&scopeRefId}`,
`/results/tally?electionId&position[&countyId|constituencyId|wardId|pollingStationId]`, `/results/breakdown?electionId&position&level&parentId`, `/results/stations/:id`,
`/budgets/years`, `/budgets/summary?countyId&financialYear[&departmentId&fundingSource]`, `/budgets/figures?…`, `/budgets/compare?financialYear&metric`, `/departments?countyId`, `/departments/:id`, `/disbursements?financialYear[&countyId]`,
`/projects?…`, `/projects/map`, `/projects/:reference`, `/audit-findings?…`, `/audit-findings/:key`, `/sources`, `/citizen-reports` (GET published; POST multipart, rate-limited, honeypot, optional Turnstile), `/citizen-reports/:reference/abuse`, `/search?q`.

Tally responses include `candidates[{rank, votes, verifiedVotes, share}]`, `totals`, `coverage{reported, registered, outstanding, percent}`, `overallStatus` (`NO_RESULTS | AWAITING_VERIFICATION | PROVISIONAL | VERIFIED | MATCHED_OFFICIAL | OFFICIAL`), `winnerDeclared: false` and `disclaimer`.

## Exports — `/api/exports/:kind?format=csv|xlsx|pdf`
Public: `results`, `coverage`, `budgets`, `disbursements`, `projects`, `audit-findings`, `citizen-reports-summary`, `donations-summary`.
Restricted (permission checked and audit-logged): `submissions` (results.monitor), `donations` (donations.view), `audit-log` (audit.view).

## Files — `/api/files`
`POST /` (staff; `purpose`) · `GET /:id`. Public files are served only once scanned clean. Private files require authorisation, and result evidence is limited to in-scope reviewers and the uploading agent.

## Agent — `/api/agent` (role AGENT)
`GET /assignments` · `POST /evidence` (multipart) · `POST /submissions` · `GET /submissions`.
Submission body: `{idempotencyKey (uuid), electionId, pollingStationId, position, candidateVotes[{candidateId, votes}], fields{registeredVoters,totalVotesCast,rejectedVotes,rejectedObjectedTo,disputedVotes,validVotes}, formReference?, evidenceFileIds[], declarationAccepted: true, baseRevision: number|null, correctionReason?}`.
Returns `201 {receipt}`. A replay with the same key returns `200` with the same receipt. A stale `baseRevision` returns `409` with `details.serverRevision`.

Live counting and safeguards (agent):
`POST /confirm-identity {password}` (password re-confirmation, valid `SUBMIT_REAUTH_MINUTES`) · `POST /tally-events {clientSessionId, electionId, pollingStationId, position, events[{seq, kind: INCREMENT|UNDO|SET, candidateId, undoOfSeq?, value?, reasonCode?, reason?, clientAt?}]}`. Events must be in sequence: a gap returns 409 with `details.expectedSeq`, duplicates are ignored, and an absurd tap rate returns 422. · `GET /count-sessions/:clientSessionId` · `POST /form-extract {fileId, electionId, pollingStationId, position}` (AI reading of the uploaded form; advisory). Submissions accept `countSessionId`, need an approved (vetted) agent, and need a recent password confirmation (403 `STEP_UP_REQUIRED`).

## Agent registration — `/api/agent-registration`
`GET /config` · `POST /start {idNumber, email, phone?, consent: true}` → 202 with a generic message (never the name or PIN) · `GET /confirm?token` → masked name · `POST /complete {token, password}` → creates an AGENT awaiting approval, with name and KRA PIN locked.

## Settings — `/api/admin/settings` (SUPER_ADMIN)
`GET /` (secrets reported only as set or unset) · `PUT /:section {values, clear[]}` for `mpesa | smtp | kra | registration` · `POST /:section/test`.

## Verification — `/api/verification`
`GET /dashboard`, `/tally`, `/submissions`, `/submissions/:submissionId` · `POST /submissions/:id/extract {fileId}` (rerun AI reading) · `POST /submissions/:id/start-review {note}` · `POST /submissions/:id/decision {revision, decision: VERIFY|REJECT, note}`. Returns 202 with `approvalId` when a second reviewer is required.

- `GET /verification/coverage?electionId&countyId&position` — per-station agent coverage (assigned agents, approval, last seen, reported) and a summary, within the caller's scope.

## Approvals — `/api/approvals`
`GET /` · `POST /:id/approve|reject {note}`. The approver must be a different user from the requester. Kinds: `RESULT_CORRECTION`, `MANUAL_RECONCILIATION`, `REFUND`.

## Admin — `/api/admin`
Users: `GET/POST /users` (`?vetting=PENDING`), `PATCH /users/:id` (locked KRA names cannot change), `GET /users/:id/identity` (audited), `POST /users/:id/vetting {decision, identityChecked, phoneChecked, accreditationChecked, accreditationReference, note}`, `GET /form-templates`, `POST /users/:id/{suspend,reactivate,revoke,revoke-sessions,reset-password,reset-mfa}`; assignments `GET/POST /assignments`, `POST /assignments/:id/revoke`.
Elections: `GET/POST /elections`, `PATCH /elections/:id`, `POST /candidates`, `PATCH /candidates/:id`.
Records: `GET /records/:kind` (`BUDGET_FIGURE|DISBURSEMENT|PROJECT|AUDIT_FINDING`), `GET /records/:kind/:id/history`, `POST /records/:kind/:id/advance {to}`, `POST /records/:kind/:id/correct {changes, reason}`, `PATCH /records/:kind/:id`; `POST /figures`, `/disbursements`, `/departments`, `/projects`, `/projects/:id/flag`, `GET /projects-discrepancies`, `POST /audit-findings`.
Sources: `GET/POST /sources`, `POST /sources/:id/document`, `POST /sources/:id/review`.
Citizen reports: `GET /citizen-reports`, `GET /citizen-reports/:id`, `POST /citizen-reports/:id/reveal-contact {reason}`, `POST /citizen-reports/:id/moderate`.
Imports: `GET /imports/templates`, `GET/POST /imports`, `GET /imports/:id`, `GET /imports/:id/rows`, `POST /imports/:id/{validate,review,publish,discard}`.
Donations: `GET /donations/summary`, `GET /donations`, `GET /donations/:id`, `POST /donations/:id/{requery,reconcile,refunds}`, `POST/PATCH /donations/goals`, `GET /donations/expenditure/list`, `POST /donations/expenditure`, `POST /donations/expenditure/:id/publish`, `POST /donations/reports`.
Audit log: `GET /audit-log`, `GET /audit-log/verify`. Site: `POST /updates`.

### Catalogue (admin)
- `GET /admin/candidates?electionId&position&scopeRefId`, `POST /admin/candidates`, `PATCH /admin/candidates/:id` (needs `reason`) — `candidates.manage`.
- `GET|POST /admin/parties`, `PATCH /admin/parties/:id` — `candidates.manage`. Public: `GET /public/parties`.
- `POST /admin/parties/read` — preview of the ORPP register from `{url}` (https on orpp.or.ke only), a multipart PDF `file` (AI reader), or `{text}` (one party per line); nothing is saved. `POST /admin/parties/import` `{rows:[{name, abbreviation}], source:{title,url,asAt}}` creates only new, valid rows. Logos: `PATCH /admin/parties/:id {logoFileId | null}`.
- `POST /admin/counties`, `PATCH /admin/counties/:id` (code immutable) — `counties.manage` (SUPER_ADMIN).
- `GET /admin/elections/:id/areas` — constituencies with their wards.
- `POST /admin/elections/:id/areas/load-official` — idempotently loads the IEBC 2022 constituency and ward schedule for the five counties; returns `{constituenciesAdded, wardsAdded, alreadyPresent, conflicts}`.
- `POST /admin/elections/:id/stations/load-official` — idempotently loads the 2,384 IEBC 2022 polling stations (and any missing areas); returns `{stationsAdded, alreadyPresent, registeredVotersAdded, areas, conflicts}`.
- `POST /admin/elections/:id/constituencies` `{countyId, code (3 digits), name}`, `POST /admin/elections/:id/wards` `{constituencyId, code (4 digits), name}`.
- `PATCH /admin/constituencies/:id`, `PATCH /admin/wards/:id` `{name, reason}` — spelling corrections only.
- Logos and photos: `POST /api/files` multipart with `purpose` = `COUNTY_LOGO` | `PARTY_LOGO` | `CANDIDATE_PHOTO` (images only, 2 MB, public).

## Donations — `/api/donations`
`GET /config` · `POST /` `{idempotencyKey, amount, method, phone?, email?, name?, message?, acknowledgement, acceptTerms: true, termsVersion}` → `{donation, statusToken, next}` · `GET /:reference/status?t=` · `GET /:reference/receipt.pdf?t=` · `GET /public/summary` · `GET /public/acknowledgements`.

## Payment callbacks — `/api/payments`
`POST /mpesa/callback/:token`, `POST /mpesa/reversal/:token/{result,timeout}`, `POST /paystack/webhook` (HMAC-SHA512 verified), `POST /paypal/webhook` (verified via PayPal API). All callbacks are deduplicated.

## Real-time — Socket.IO at `/socket.io`
Emit `subscribe {electionId}`, then receive `results:updated` (public ping only). Authenticated monitors also receive `admin:results` for their scope. Emit `subscribe:donations`, then receive `donations:updated`.

## Health
`GET /healthz` (liveness) · `GET /readyz` (Mongo, Redis, outbox backlog).
