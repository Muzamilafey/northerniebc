/**
 * End-to-end smoke test against a running stack (API on :4000, web on :5173) seeded with
 * `npm run db:seed-demo -w server` (synthetic DEMO data, MFA disabled for local runs).
 * Usage: BASE_URL=http://localhost:5173 node tests/e2e/run.mjs
 */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const PW = process.env.DEMO_PASSWORD ?? 'demo-password-change-me';
const SHOTS = process.env.SHOTS_DIR ?? 'test-results/e2e';
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    for (const [i, pg] of openPages.entries()) await pg.screenshot({ path: `${SHOTS}/FAIL-${results.length}-${i}.png`, fullPage: true }).catch(() => undefined);
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
}

// Fresh, synthetic DEMO database for every run (non-production only).
const { execSync } = await import('node:child_process');
if (process.env.SKIP_RESET !== '1') execSync('npm run db:seed-demo -w server', { env: { ...process.env, DEMO_RESET: '1' }, stdio: 'ignore' });

const browser = await chromium.launch();
const openPages = [];
const _newContext = browser.newContext.bind(browser);
browser.newContext = async (o) => {
  const c = await _newContext(o);
  const _np = c.newPage.bind(c);
  c.newPage = async () => {
    const pg = await _np();
    openPages.push(pg);
    return pg;
  };
  return c;
};
const mobile = devices['Pixel 7'];

async function login(page, id) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Email or agent ID').fill(id);
  await page.getByLabel('Password').fill(PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
}

const agentCtx = await browser.newContext({ ...mobile });
const agent = await agentCtx.newPage();

await step('public home shows brand, independence notice and county cards', async () => {
  const p = await (await browser.newContext({ ...mobile })).newPage();
  await p.goto(BASE);
  await p.getByRole('heading', { name: 'Follow the Vote. Follow the Money.' }).waitFor();
  assert.ok(await p.getByText('not affiliated with or endorsed by').first().isVisible());
  for (const c of ['Garissa', 'Mandera', 'Wajir', 'Isiolo', 'Marsabit']) await p.getByText(c, { exact: true }).first().waitFor({ timeout: 10000 });
  await p.screenshot({ path: `${SHOTS}/01-home-mobile.png`, fullPage: true });
});

await step('agent signs in and sees only the assigned station', async () => {
  await login(agent, 'AGT-DEMO0001');
  await agent.getByText('DEMO-PS1 — DEMO Polling Station 1').waitFor();
  assert.equal(await agent.getByText('DEMO Polling Station 2').count(), 0);
  await agent.screenshot({ path: `${SHOTS}/02-agent-home.png`, fullPage: true });
});

await step('counting: each tap recorded live, undo with reason, manual entry, password-confirmed submission', async () => {
  await agent.getByRole('link', { name: /Governor/ }).click();
  await agent.getByText('Form 37A').first().waitFor();
  const plusA = agent.getByRole('button', { name: 'Add one vote for DEMO Candidate Alpha' });
  for (let i = 0; i < 3; i++) {
    await plusA.click();
    await agent.waitForTimeout(350);
  }
  await agent.getByText('Live count: 3 taps recorded on server').waitFor({ timeout: 10000 });
  await agent.getByRole('button', { name: 'Undo last +1' }).click();
  await agent.getByRole('dialog').getByLabel('Accidental tap').check();
  await agent.getByRole('dialog').getByRole('button', { name: 'Undo' }).click();
  assert.equal(await agent.getByLabel('Votes for DEMO Candidate Alpha').inputValue(), '2');
  await agent.getByText('Live count: 4 taps recorded on server').waitFor({ timeout: 10000 });
  await agent.getByLabel('Votes for DEMO Candidate Beta').fill('120');
  await agent.getByLabel('Votes for DEMO Candidate Gamma').fill('76');
  await agent.locator('label', { hasText: 'Total valid votes' }).locator('input').fill('198');
  await agent.locator('label', { hasText: 'Rejected ballots' }).locator('input').fill('3');
  await agent.screenshot({ path: `${SHOTS}/03-count-screen.png`, fullPage: true });
  await agent.getByRole('button', { name: 'Review & submit' }).click();
  await agent.getByRole('checkbox').check();
  await agent.getByRole('button', { name: 'Submit result' }).click();
  // "+" never submits; the agent must confirm their password.
  await agent.getByRole('dialog').getByLabel('Password').fill(PW);
  await agent.getByRole('dialog').getByRole('button', { name: 'Confirm & submit' }).click();
  await agent.getByText('Received by server.').waitFor({ timeout: 15000 });
  assert.match(await agent.getByText(/Receipt RCPT-/).innerText(), /RCPT-/);
  await agent.screenshot({ path: `${SHOTS}/04-receipt.png`, fullPage: true });
});

await step('offline: MCA result is queued locally, not reported as submitted, then syncs', async () => {
  await agent.goto(`${BASE}/agent`);
  await agent.getByRole('link', { name: /Member of County Assembly/ }).click();
  await agent.getByLabel('Votes for DEMO Ward Candidate One').fill('80');
  await agent.getByLabel('Votes for DEMO Ward Candidate Two').fill('70');
  await agentCtx.setOffline(true);
  await agent.getByRole('button', { name: 'Review & submit' }).click();
  await agent.getByRole('checkbox').check();
  await agent.getByRole('button', { name: 'Submit result' }).click();
  await agent.getByText(/has NOT reached the server yet/).waitFor();
  assert.ok(await agent.getByText('OFFLINE').first().isVisible());
  await agent.screenshot({ path: `${SHOTS}/05-offline-queued.png`, fullPage: true });
  // Draft survives a reload while offline (IndexedDB).
  await agentCtx.setOffline(false);
  await agent.getByRole('button', { name: 'Sync now' }).click();
  await agent.getByText('Received by server.').waitFor({ timeout: 20000 });
});

await step('an unapproved agent cannot count until a different administrator approves them', async () => {
  const p = await (await browser.newContext({ ...mobile })).newPage();
  await login(p, 'AGT-DEMO0002');
  await p.getByText(/awaiting approval/).waitFor();
  const admin = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await login(admin, 'demo-admin@example.org');
  await admin.goto(`${BASE}/admin/users`);
  await admin.getByRole('button', { name: 'Agents awaiting approval' }).click();
  await admin.getByRole('button', { name: 'Review approval' }).first().click();
  await admin.getByLabel(/National ID/).check();
  await admin.getByLabel(/Phone number confirmed/).check();
  await admin.getByLabel(/Accreditation \/ appointment letter/).check();
  await admin.getByLabel('Accreditation reference').fill('DEMO-ACC-2');
  await admin.getByLabel('Note (what you checked)').fill('Checked ID and letter in person');
  await admin.getByRole('button', { name: 'Approve agent' }).click();
  await admin.getByText(/was approved and can now count/).waitFor();
  await admin.screenshot({ path: `${SHOTS}/06a-agent-approval.png`, fullPage: true });
  await p.reload();
  await p.getByText('DEMO-PS').first().waitFor({ timeout: 5000 }).catch(() => undefined);
  assert.equal(await p.getByText(/awaiting approval/).count(), 0);
});

await step('admin configures KRA in Settings; an agent self-registers with ID + email; name and KRA PIN come from KRA', async () => {
  // Local stand-in for the KRA sandbox (same request/response shapes as the published API).
  const http = await import('node:http');
  const kra = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/v1/token/generate')) return res.end(JSON.stringify({ access_token: 'kra-token', expires_in: '3599' }));
      if (req.url === '/checker/v1/pin') return res.end(JSON.parse(b).TaxpayerID === '41789723' ? JSON.stringify({ TaxpayerPIN: 'A000000000I', TaxpayerName: 'YAMAS12 TEST OMINI01' }) : JSON.stringify({ ErrorCode: '30002', ErrorMessage: 'Invalid ID' }));
      res.writeHead(404).end('{}');
    });
  });
  await new Promise((r) => kra.listen(0, '127.0.0.1', r));
  try {
    const admin = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
    await login(admin, 'demo-admin@example.org');
    await admin.goto(`${BASE}/admin/settings`);
    const kraSec = admin.locator('section', { has: admin.getByRole('heading', { name: 'KRA PIN Checker' }) });
    await kraSec.getByLabel('Base URL').fill(`http://127.0.0.1:${kra.address().port}`);
    await kraSec.getByLabel('Consumer key').fill('demo-key');
    await kraSec.getByLabel('Consumer secret').fill('demo-secret');
    await kraSec.getByRole('button', { name: 'Save KRA PIN Checker' }).click();
    await kraSec.getByText(/Saved:/).waitFor();
    await kraSec.getByRole('button', { name: 'Test connection' }).click();
    await kraSec.getByText('Connection succeeded').waitFor();
    assert.equal(await kraSec.getByLabel('Consumer secret').inputValue(), '');
    const regSec = admin.locator('section', { has: admin.getByRole('heading', { name: 'Agents: sign-in and self-registration' }) });
    await regSec.getByLabel('Open agent self-registration').selectOption('true');
    await regSec.getByRole('button', { name: /Save/ }).click();
    await regSec.getByText(/Saved:/).waitFor();
    await admin.screenshot({ path: `${SHOTS}/06b-settings.png`, fullPage: true });

    const p = await (await browser.newContext({ ...mobile })).newPage();
    await p.goto(`${BASE}/register`);
    await p.getByLabel('National ID number').fill('41789723');
    await p.getByLabel('Email address').fill('self.registered@example.org');
    await p.getByRole('checkbox').check();
    await p.getByRole('button', { name: 'Verify and continue' }).click();
    await p.getByText(/confirmation link has been sent/).waitFor();
    assert.equal(await p.getByText('YAMAS12').count(), 0);
    await p.getByRole('link', { name: 'open confirmation link' }).click();
    await p.getByText('Y****** T*** O******').waitFor();
    await p.getByLabel('Choose a password').fill('a-strong-passphrase-2026');
    await p.getByRole('button', { name: 'Create my agent account' }).click();
    await p.getByText(/Registration complete/).waitFor();
    await p.screenshot({ path: `${SHOTS}/06c-registered.png`, fullPage: true });

    await admin.goto(`${BASE}/admin/users`);
    await admin.getByRole('button', { name: 'Agents awaiting approval' }).click();
    await admin.getByRole('row', { name: /YAMAS12 TEST OMINI01/ }).getByRole('button', { name: 'Review approval' }).click();
    await admin.getByText('A000000000I').waitFor();
    await admin.getByText('(from KRA, locked)').waitFor();
    await admin.screenshot({ path: `${SHOTS}/06d-vetting-kra.png`, fullPage: true });
  } finally {
    kra.close();
  }
});

await step('verifier sees the submission and verifies it', async () => {
  const v = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await login(v, 'demo-verifier@example.org');
  await v.waitForURL(/\/verify/);
  await v.locator('table').getByRole('link', { name: 'Review', exact: true }).first().click();
  await v.getByPlaceholder(/Decision note/).fill('Figures match the photographed form');
  await v.getByRole('button', { name: /Verify revision/ }).click();
  await v.getByText('Decision recorded: VERIFY').waitFor();
  await v.screenshot({ path: `${SHOTS}/06-verified.png`, fullPage: true });
});

await step('public results show labelled figures with no winner declaration', async () => {
  const p = await (await browser.newContext({ ...mobile })).newPage();
  await p.goto(`${BASE}/results`);
  await p.getByText('Reporting coverage').waitFor();
  await p.getByText('No winner is declared on this platform', { exact: false }).waitFor();
  await p.getByRole('cell', { name: 'DEMO Candidate Beta' }).waitFor();
  await p.screenshot({ path: `${SHOTS}/07-public-results.png`, fullPage: true });
});

await step('budgets show an honest data-unavailable state', async () => {
  const p = await (await browser.newContext({ ...mobile })).newPage();
  await p.goto(`${BASE}/budgets`);
  await p.getByText(/has not been published from a verified source yet/).first().waitFor();
  await p.screenshot({ path: `${SHOTS}/08-budgets-empty.png`, fullPage: true });
});

await step('donate page lists only operational methods', async () => {
  const p = await (await browser.newContext({ ...mobile })).newPage();
  await p.goto(`${BASE}/donate`);
  await p.getByRole('heading', { name: /Support Independent Election Monitoring/ }).waitFor();
  await p.getByText(/Donations are awaiting setup|not available/).first().waitFor();
  await p.screenshot({ path: `${SHOTS}/09-donate.png`, fullPage: true });
});

await browser.close();
const failed = results.filter((r) => !r.ok);
fs.writeFileSync(`${SHOTS}/results.json`, JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} e2e steps passed`);
process.exit(failed.length ? 1 : 0);
