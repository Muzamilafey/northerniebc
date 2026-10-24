# Architecture & implementation status

## Starting point and plan

The repository was empty. The build followed the phases in the brief: foundation (models, auth, UI shell) → election infrastructure → tallying and offline sync → verification and public results → budgets → projects → audit and accountability → donations → hardening (tests, backups, deployment, docs).

## Overview

```
 Browser / Android PWA ──HTTPS──▶ Nginx ──▶ Node API (PM2 cluster, Express 5) ──▶ MongoDB replica set
        ▲   IndexedDB drafts              │        │  Socket.IO (Redis adapter)        (transactions)
        └──── Socket.IO "changed" pings ◀─┘        └─ Worker process: outbox, notifications,
                                                       payment status queries, timeouts
 Payment providers (Daraja, Paystack, PayPal) ──callbacks/webhooks──▶ /api/payments/*
```

### Data-integrity principles in the code

| Principle | Where |
| --- | --- |
| One accepted result per station × position; aggregates read only from it, so duplicates and revisions are never summed | `StationResult` unique index; `modules/results/query.ts` |
| Submissions are immutable revisions, chained by hash; corrections need `baseRevision` + reason | `SubmissionRevision`; `modules/results/service.ts` |
| Idempotency keys on submissions and donations; replays return the original receipt | `submitResult`, `createDonation` |
| Changing a verified result needs a second reviewer | `decide()` → `PendingApproval` → `/api/approvals` |
| Missing figures are absent rows, never zero | `BudgetFigure` one row per metric; `metricSummary()` |
| Published records are superseded, never edited | `publishableFields`, `correctRecord`, import `supersede()` |
| Payment success only from provider confirmation (callback **and** status query for M-Pesa) | `modules/donations/service.ts` |
| Every privileged action → append-only hash-chained audit event in the same transaction | `lib/audit.ts` |
| Real-time updates via transactional outbox | `lib/outbox.ts`, `jobs/outboxWorker.ts` |

### Write path (spec §36)

1. Authenticate (bearer JWT → user + live session loaded from DB) and authorise (role + geographic scope, server-side).
2. Validate (zod; operator-key rejection).
3. In one MongoDB transaction: write the record(s), the audit event, and the outbox event.
4. Commit.
5. The worker claims the outbox event, invalidates caches and emits Socket.IO pings (public rooms get “changed” only; scoped admin rooms get details).
6. Aggregates are computed from accepted results on read (with a 5-second cache), so they are always consistent with the stored records.

### Collections

Users, Sessions, AuditEvents/AuditChainHead, OutboxEvents, NotificationJobs, StoredFiles, SystemConfig, Counters, PendingApprovals, DataSources, ImportJobs/ImportRows, PlatformUpdates; Counties, Constituencies, Wards, PollingStations (election-specific), Elections (positions and reconciliation rules), Candidates, AgentAssignments, ResultSubmissions, SubmissionRevisions, VerificationDecisions, StationResults, OfficialStationResults; Departments, BudgetFigures, TreasuryDisbursements, Contractors, Projects, ProjectUpdates, AuditFindings, CitizenReports; Donations, PaymentTransactions, PaymentCallbacks, Refunds, DonationReceipts, FundraisingGoals, OperatingExpenditures, DonationReports.

Roles and permissions are defined in code (`server/src/lib/permissions.ts`) rather than in a collection, so they cannot be changed by editing database rows. A `FINANCE_OFFICER` role was added for donation and finance staff.

## Implementation status

| Area | Status |
| --- | --- |
| Auth: Argon2id, TOTP MFA (enforced for privileged roles), recovery codes, refresh rotation with reuse detection, lockout, reset, session revocation | Implemented and tested |
| Election setup, election-specific geography, candidates with scope validation, agent assignment | Implemented and tested |
| Agent counting UI, drafts in IndexedDB, ordered offline queue, conflicts, receipts | Implemented; unit and e2e tested |
| Verification, conflicts, second-reviewer corrections, admin dashboard, public portal | Implemented and tested |
| Official-results matching (`OFFICIAL_RESULTS` import) | Implemented; not yet covered by an automated test |
| Budgets, disbursements, departments, projects, findings, citizen reports, imports, exports, search | Implemented and tested |
| M-Pesa STK Push, callbacks, status query, timeouts, reconciliation, reversals | Implemented; tested against a local Daraja stub, **not yet against Safaricom sandbox** |
| Paystack and PayPal adapters | Implemented; **not exercised against provider sandboxes**; shown as unavailable until configured |
| Recurring donations | Not implemented (shown as unavailable, as the brief allows) |
| Malware scanning | ClamAV `INSTREAM` client; uploads remain unservable until a scanner is configured |
| SMS notifications | Not implemented (email via SMTP only) |

## Known risks and open items

- **Authoritative data.** None is bundled. Each election's station register, candidate list and reconciliation rules must come from official IEBC publications; budgets and findings from the official documents. Until loaded, the site shows “not available”.
- **Payment go-live.** Each provider must be tested end to end in sandbox, then in production with a small live transaction, before setting its `*_VERIFIED_OPERATIONAL=true`.
- **Legal.** The operator's legal identity, terms, privacy notice and data-protection registration (ODPC) must be confirmed before accepting donations.
- **Single-node replica set** is supported but has no failover; use three members for elections.
- **Audit chain hot spot.** Every write appends to one hash chain, which serialises audit writes. The measured load test passed (see TESTING.md). For very high write volumes, consider per-partition chains.
