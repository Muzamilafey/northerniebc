// Renders PWA icons from public/brand/logo.svg using the pre-installed Playwright Chromium.
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import path from 'node:path';
const svg = path.resolve('public/brand/logo.svg');
const browser = await chromium.launch();
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0;background:transparent"><img src="file://${svg}" width="${size}" height="${size}"></body></html>`);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `public/brand/icon-${size}.png`, omitBackground: true });
}
await browser.close();
