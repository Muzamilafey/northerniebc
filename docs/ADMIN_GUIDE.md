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

**Settings** holds integration credentials: KRA PIN Checker, M-Pesa (Daraja), SMTP email, AI reading (Anthropic or Groq: provider, key and model), and the switch for open agent self-registration. Values saved there override the server's `.env`. Secrets are stored encrypted, are never shown again after saving (leave a field blank to keep it), and every change is audit-logged without the secret values. Use **Test connection** after saving.

## Agent sign-in and when results are received

- **Agent sign-in** (Settings → Agents): when closed, agents cannot sign in, agents already signed in are stopped at their next action, and the public **Login** button is hidden. Staff sign in from the footer link (**Staff sign-in**) or `/login`. Self-registration is also closed while agent sign-in is closed.
- **Receiving results** (Election setup, per election): **Open**, **Paused**, or **Scheduled** with an opening and/or closing time in East Africa Time (UTC+3). Outside the window the server refuses counts and result submissions. The agent screen shows "Results open at … EAT" or "Results closed at … EAT", and the + buttons are disabled. Reviewers and administrators are not affected.

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

## Counties, constituencies, wards, aspirants and parties

- **Counties** (super administrators): add a county with its official code and upload its logo (JPEG/PNG/WebP, at most 2 MB; SVG is refused). Logos appear on the home page, the county list and each county page. Codes cannot be changed.
- **Constituencies & wards** (on the Counties page or from the Aspirants page, per election): **Load official IEBC list** adds the 24 constituencies and 120 county assembly wards of the five counties with their IEBC codes (constituencies 027–050, wards 0131–0250). They come from the IEBC *Registered Voters per County Assembly Ward, 2022 General Election* schedule, which is recorded as the source. Loading again changes nothing that already exists. If the IEBC gazettes new boundaries, add constituencies or wards by hand with their new codes. A spelling can be corrected with a reason, but codes never change. Counties are matched by official code, then by name ("ISIOLO COUNTY" matches Isiolo), and created if missing. Duplicates and code mismatches are reported. A later `POLLING_STATIONS` import joins stations to these areas by code.
- **Aspirants & parties**: choose the election, then the county, constituency, ward and position. The President is national. Governor, Senator and Woman Representative are chosen per county, Member of Parliament per constituency, and MCA per ward. Add each aspirant with their ballot name, party (or Independent), photo and source reference (for example the gazette notice). Under *Parties*, **Load parties** brings in the Registrar of Political Parties (ORPP) list of fully registered parties in one of three ways:
  - Paste the link to the latest list on orpp.or.ke. Only that site is fetched.
  - Upload the ORPP PDF.
  - Paste the rows as text, one party per line, e.g. `Orange Democratic Movement (ODM)`.

  Links and PDFs are read by the AI reader (Settings → AI reading); Groq cannot read PDFs, so use a link or pasted text with Groq. Pasted text needs no AI. You review and correct every row before importing. Rows without an abbreviation, or with a repeated one, must be fixed first. Parties already present are never changed. Then use **Add logo / Change logo / Remove** on each party card; county cards have the same buttons. Photos and party logos appear on public results, station pages and the agent count screen. Removing an aspirant needs a reason. Renaming a party updates its aspirants.

### Images not showing

Every upload is checked for malware before anyone can open it. If no scanner is reachable, image uploads are now refused with a message saying so (earlier they were stored but never shown).
- **Production:** run ClamAV and set `CLAMAV_HOST` (and `CLAMAV_PORT`) in `server/.env`.
- **Local testing only:** set `ALLOW_UNSCANNED_UPLOADS=true` in `server/.env` (production refuses to start with it).

Restart the API, then run `npm run files:rescan -w server` to release images uploaded before the change, or upload them again.

## Before an election

1. **Election setup** → create the election (DRAFT). Under *Configure positions*, enable each contested position. Set the required form fields and the reconciliation rules **from the official documentation for that election**, and record the source.
2. **Source registry** → register the official station register and candidate list publications, and attach the documents. A second person marks each source *reviewed*.
3. **Counties → Constituencies & wards** → load the official list for the election. **Data imports** → `POLLING_STATIONS` (stations, and any areas not already present), then `CANDIDATES`, or add aspirants one by one under *Aspirants & parties*. Each import goes through validate → second-person review → publish. Conflicts with the existing register are reported and never overwritten.
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
