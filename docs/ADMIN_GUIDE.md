# Administrator guide

## Roles

| Role | Can |
| --- | --- |
| Super Administrator | Everything, including creating elections, privileged users, MFA resets |
| Regional Administrator | All five counties: users (except super/regional), geography and candidate imports, publication of financial data, audit log |
| County Administrator | Their counties: agents and constituency supervisors, monitoring, finance imports, project records, citizen-report moderation |
| Constituency Supervisor | Agents and monitoring in their constituencies |
| Verification Officer | Verify or reject results, review imports and sources, moderate citizen reports (optionally county-scoped) |
| Finance Officer | Finance imports, donation administration, reconciliation, refunds, goals and expenditure |
| Polling-Station Agent | Count and submit results for assigned stations only |

All privileged accounts must enrol an authenticator app (My account & security) before they can act.

## Settings (super administrators)

**Settings** holds integration credentials: KRA PIN Checker, M-Pesa (Daraja), SMTP email, and the switch for open agent self-registration. Values saved there override the server's `.env`. Secrets are stored encrypted, are never shown again after saving (leave a field blank to keep it), and every change is audit-logged without the secret values. Use **Test connection** after saving.

## Agents: registration and approval

- **Created by an administrator.** The account starts *awaiting approval*.
- **Self-registered.** When registration is open and KRA is configured, applicants go to `/register` and give their national ID number and email (phone optional). Their name and KRA PIN are fetched from the KRA PIN Checker and are **locked**: neither the agent nor any administrator can change them. They confirm through an emailed link and set a password. The public form never displays the name or PIN, and lookups are rate-limited per IP address and per ID number.
- **Approval (every agent).** Under *Users & agents → Agents awaiting approval → Review approval*, compare the KRA details (viewing them is logged) with the agent's ID card and appointment or accreditation letter. Tick the checks, record the accreditation reference, and approve. The administrator who created the account cannot approve it. Until approved, an agent cannot count or submit.

## How counting is protected

- Each **+** adds one vote and is recorded on the server immediately, in a timestamped, hash-chained tally log (queued on the phone when offline). It never submits a result.
- **Undo** reverses only the previous addition and always needs a reason (accidental tap, wrong candidate, counted twice, or other with an explanation).
- Tapping faster than a person can count is flagged (`MAX_TAPS_PER_SECOND`) or refused (`HARD_MAX_TAPS_PER_SECOND`). A count above the station's registered voters is flagged.
- **Submitting** requires the agent's password within the last 15 minutes, the declaration, and (if configured) the form photo. The server compares the submitted figures with the live tap count and with the AI reading of the form. Differences are flagged for reviewers, never silently corrected.
- **AI form reading** (Form 34A for the presidential race, 35A–39A for the others; set each form code in Election setup or apply the template) reads the figures from the photo. The agent must tick that they checked every number before using them. Readings can be wrong, so reviewers see the live count, the AI reading and the submitted figures side by side and can rerun the reading.

## Before an election

1. **Election setup** → create the election (DRAFT). Under *Configure positions*, enable each contested position. Set the required form fields and the reconciliation rules **from the official documentation for that election**, and record the source.
2. **Source registry** → register the official station register and candidate list publications, and attach the documents. A second person marks each source *reviewed*.
3. **Data imports** → `POLLING_STATIONS` (election-specific constituencies, wards, stations), then `CANDIDATES`. Each import goes through validate → second-person review → publish. Conflicts with the existing register are reported and never overwritten.
4. **Users & agents** → create agent accounts (each gets an `AGT-…` ID and a one-time temporary password). Assign each agent to a station, individually or with an `AGENT_ASSIGNMENTS` import. Give agents their credentials through a secure channel.
5. Decide whether to *publish provisional results* (clearly labelled) or verified results only. Then move the election to ACTIVE.

## On election day

- **Results dashboard**: coverage, outstanding stations, submissions awaiting verification, conflicts, active agents, a live activity feed.
- **Verification queue**: open each submission, compare it with the photographed form and any other submissions for the same station, write a decision note, then verify or reject.
- Replacing an already-verified result (or rejecting the submission behind it) goes to **Second-review approvals**, where a different reviewer must approve it.
- Suspend lost or compromised agent accounts immediately (*Suspend* ends their sessions). Reassign stations as needed.
- When official results are published, register the publication as a source and import `OFFICIAL_RESULTS`. Matching stations are labelled *Matched against official IEBC records*, and differences are flagged.

## Budgets, projects and findings

1. Register the source document (Controller of Budget report, approved estimates, OAG report…). Note the page numbers.
2. Prepare a CSV or XLSX in the template shown under *Data imports* (one row per metric; leave a metric out rather than writing 0).
3. Upload, validate, have a colleague review, then a regional or super administrator publishes.
4. To correct a published figure, either re-import it (conflicting rows are published only with a documented correction reason) or use *Financial & project records → Correct*. The earlier value stays in the history.
5. Use neutral wording. Project discrepancy flags require cited evidence. Audit categories follow the report; “confirmed loss” and “allegation under investigation” require the competent authority's wording.

## Citizen reports

Reports arrive as RECEIVED and are never public until a moderator writes a public summary and publishes it. Keep summaries free of personal data and unproven accusations. Reporter contact details are hidden. *Reveal contact* requires a reason and is audit-logged.

## Donations

- Donations stay disabled until the operator's legal name and contact details are configured (server environment) and at least one provider is operational.
- *Pending* never counts as received. Donations that stay unconfirmed past the timeout are flagged for reconciliation.
- **Manual reconciliation**: upload the provider statement and request it; a second finance user approves.
- **Refunds**: request, then a second user approves, and the refund is sent through the provider. Status changes only when the provider confirms.
- Record operating expenditure with document references; another person publishes it. Publish periodic reports from the Donations page.
- Export donation records (CSV/Excel) from the Donations page. Exports are audit-logged.

## Audit log

*Audit log → Verify chain integrity* recomputes the hash chain. Any edit or deletion of past events is reported with the first broken sequence number. Run `npm run audit:verify -w server` from the server as well.
