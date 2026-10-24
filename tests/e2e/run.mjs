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
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
}

const browser = await chromium.launch();
const mobile = devices['Pixel 7'];

async function login(page, id) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Email or agent ID').fill(id);
  await page.getByLabel('Password').fill(PW);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

const agentCtx = await browser.newContext({ ...mobile });
const agent = await agentCtx.newPage();

await step('public home shows brand, independence notice and county cards', async () => {
  const p = await (await browser.newContext({ ...mobile })).newPage();
  await p.goto(BASE);
  await p.getByRole('heading', { name: 'Follow the Vote. Follow the Money.' }).waitFor();
  assert.ok(await p.getByText('not affiliated with or endorsed by').first().isVisible());
  for (const c of ['Garissa', 'Mandera', 'Wajir', 'Isiolo', 'Marsabit']) assert.ok(await p.getByText(c, { exact: true }).first().isVisible(), c);
  await p.screenshot({ path: `${SHOTS}/01-home-mobile.png`, fullPage: true });
});

await step('agent signs in and sees only the assigned station', async () => {
  await login(agent, 'AGT-DEMO0001');
  await agent.getByText('DEMO-PS1 — DEMO Polling Station 1').waitFor();
  assert.equal(await agent.getByText('DEMO Polling Station 2').count(), 0);
  await agent.screenshot({ path: `${SHOTS}/02-agent-home.png`, fullPage: true });
});

await step('counting: increments, undo, manual entry, review and server receipt', async () => {
  await agent.getByRole('link', { name: /Governor/ }).click();
  const plusA = agent.getByRole('button', { name: 'Add one vote for DEMO Candidate Alpha' });
  for (let i = 0; i < 3; i++) {
    await plusA.click();
    await agent.waitForTimeout(300);
  }
  await agent.getByRole('button', { name: 'Undo' }).click();
  assert.equal(await agent.getByLabel('Votes for DEMO Candidate Alpha').inputValue(), '2');
  await agent.getByLabel('Votes for DEMO Candidate Beta').fill('120');
  await agent.getByLabel('Votes for DEMO Candidate Gamma').fill('76');
  await agent.locator('label', { hasText: 'Total valid votes' }).locator('input').fill('198');
  await agent.locator('label', { hasText: 'Rejected ballots' }).locator('input').fill('3');
  await agent.screenshot({ path: `${SHOTS}/03-count-screen.png`, fullPage: true });
  await agent.getByRole('button', { name: 'Review & submit' }).click();
  await agent.getByRole('checkbox').check();
  await agent.getByRole('button', { name: 'Submit result' }).click();
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
