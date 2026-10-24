# Testing

| Suite | Command | Needs |
| --- | --- | --- |
| Server unit + API integration (real MongoDB transactions) | `npm test -w server` | MongoDB replica set at 127.0.0.1:27017 (initiated automatically if empty) |
| Web unit (offline draft logic, IndexedDB via fake-indexeddb) | `npm test -w web` | — |
| End-to-end (Chromium via Playwright) | `node tests/e2e/run.mjs` | API and web running, fresh DB seeded with `db:seed-demo` |
| Load | `npm run test:load` | Running **non-production** API with `API_RATE_LIMIT_PER_MIN` raised |
| Backup restoration | `deploy/scripts/restore-test.sh` | age key, backup directory, mongorestore, mongosh |

## Results recorded during development (2026-10-24, single VM, MongoDB 7.0 single-node replica set)

- **Server:** 73 tests in 7 files, all passing (latest run). They add live tap-by-tap counting (sequence, duplicates, gaps, hash chain), undo-last-addition with a required reason, tap-rate flags and limits, password re-confirmation before submission, live-count and AI-reading mismatch flags, agent approval with the four-eyes rule, AI form reading against a local Claude API stand-in, KRA self-registration against a local KRA stand-in (locked name and PIN, nothing revealed publicly, duplicate IDs), and write-only encrypted Settings. The original 62 tests They cover the acceptance tests in brief §41–43: assignment-only access, idempotent submissions, no silent overwrite, revisions not inflating totals, conflicts triggering review, second-reviewer corrections, scoped dashboards, publication controls, distinct budget stages, missing ≠ zero, source links, correction history, financial vs physical progress, unverified citizen reports, reconciling aggregates, the M-Pesa flow with duplicate callbacks, amount mismatch, unconfirmed success, failed payments excluded from totals, receipts, second-approver reconciliation, provider-only refunds, no secrets in config or responses, and authorised exports.
- **Web:** 6 tests passing (increment, undo, manual entry, queue rules, stable idempotency key, correction mode).
- **E2E:** 10/10 steps passing (latest run), adding: each tap recorded live, undo with a reason, password-confirmed submission, an offline result held until its taps upload, an unapproved agent blocked until a second admin approves, and Settings → KRA → self-registration → approval showing KRA details. The original 8 steps They cover the home page, an agent seeing only the assigned station, counting with undo, manual entry and a server receipt, an offline submission queued and **not** reported as submitted then synced on reconnect, a verifier verifying, public results with the no-winner disclaimer, the budgets "not available" state, and donate methods.
- **Load (3,000 stations, 300 agents, 200 viewers, one non-clustered dev process):** 600/600 submission requests succeeded (each agent sent twice). This gave 300 station results with no duplicates, and candidate totals exactly matched expected sums. Submission latency was p50 2.8 s and p99 8.7 s at 300-way concurrency. The public tally sustained about 467 req/s, p50 137 ms and p99 2.2 s, with 0 errors. The first run of this test revealed write contention on the single audit-chain head, which was fixed by sealing the chain asynchronously. Expect better numbers with PM2 clustering, production logging and a dedicated database host. Repeat the test on production-like hardware before an election.
- **Backup/restore:** an encrypted backup was taken, then restored into a scratch database; the checksum verified and the audit chain verified on the restored copy.

## Not yet done

- An external penetration test.
- Tests against live provider sandboxes (Daraja, Paystack, PayPal, KRA PIN Checker) and the live Claude API. Local stand-ins following the published request/response shapes were used.
- Accuracy measurement of AI form reading on a set of real (anonymised) results-form photos. Until measured, treat AI readings as a convenience that agents and reviewers must check.
- Network-partition and chaos testing on a three-node replica set, including restart during a transaction.
- An accessibility audit with assistive technologies.
