# Testing

| Suite | Command | Needs |
| --- | --- | --- |
| Server unit + API integration (real MongoDB transactions) | `npm test -w server` | MongoDB replica set at 127.0.0.1:27017 (initiated automatically if empty) |
| Web unit (offline draft logic, IndexedDB via fake-indexeddb) | `npm test -w web` | — |
| End-to-end (Chromium via Playwright) | `node tests/e2e/run.mjs` | API and web running, fresh DB seeded with `db:seed-demo` |
| Load | `npm run test:load` | Running **non-production** API with `API_RATE_LIMIT_PER_MIN` raised |
| Backup restoration | `deploy/scripts/restore-test.sh` | age key, backup directory, mongorestore, mongosh |

## Results recorded during development (2026-10-24, single VM, MongoDB 7.0 single-node replica set)

- **Server:** 62 tests in 5 files, all passing. They cover the acceptance tests in brief §41–43: assignment-only access, idempotent submissions, no silent overwrite, revisions not inflating totals, conflicts triggering review, second-reviewer corrections, scoped dashboards, publication controls, distinct budget stages, missing ≠ zero, source links, correction history, financial vs physical progress, unverified citizen reports, reconciling aggregates, the M-Pesa flow with duplicate callbacks, amount mismatch, unconfirmed success, failed payments excluded from totals, receipts, second-approver reconciliation, provider-only refunds, no secrets in config or responses, and authorised exports.
- **Web:** 6 tests passing (increment, undo, manual entry, queue rules, stable idempotency key, correction mode).
- **E2E:** 8/8 steps passing. They cover the home page, an agent seeing only the assigned station, counting with undo, manual entry and a server receipt, an offline submission queued and **not** reported as submitted then synced on reconnect, a verifier verifying, public results with the no-winner disclaimer, the budgets "not available" state, and donate methods.
- **Load (3,000 stations, 300 agents, 200 viewers, one non-clustered dev process):** 600/600 submission requests succeeded (each agent sent twice). This gave 300 station results with no duplicates, and candidate totals exactly matched expected sums. Submission latency was p50 2.8 s and p99 8.7 s at 300-way concurrency. The public tally sustained about 467 req/s, p50 137 ms and p99 2.2 s, with 0 errors. The first run of this test revealed write contention on the single audit-chain head, which was fixed by sealing the chain asynchronously. Expect better numbers with PM2 clustering, production logging and a dedicated database host. Repeat the test on production-like hardware before an election.
- **Backup/restore:** an encrypted backup was taken, then restored into a scratch database; the checksum verified and the audit chain verified on the restored copy.

## Not yet done

- An external penetration test.
- Tests against live payment-provider sandboxes (Daraja, Paystack, PayPal). Only a local Daraja stub was used.
- Network-partition and chaos testing on a three-node replica set, including restart during a transaction.
- An accessibility audit with assistive technologies.
