import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { localPorts } from './local-ports.mjs';

const require = createRequire(new URL('../apps/child-web/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const root = resolve(process.argv[2] ?? 'artifacts/acceptance');
const qa = resolve(root, 'qa');
await mkdir(qa, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 1000 },
  ]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(pathToFileURL(resolve(root, 'report.html')).href);
    await page.locator('h1').waitFor();
    const count = await page.locator('.enlarge').count();
    assert.ok(count > 0, 'No screenshot evidence in the report');
    await page.evaluate(async () => {
      for (const image of document.querySelectorAll('figure img')) {
        image.loading = 'eager';
        await image.decode();
      }
    });
    assert.equal(
      await page
        .locator('figure img')
        .evaluateAll((images) => images.every((img) => img.complete && img.naturalWidth > 0)),
      true,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
    );
    const invalidAnchors = await page
      .locator('nav a[href^="#"]')
      .evaluateAll((anchors) =>
        anchors
          .filter((a) => !document.querySelector(a.getAttribute('href')))
          .map((a) => a.getAttribute('href')),
      );
    assert.deepEqual(invalidAnchors, []);
    const attachments = await page
      .locator('a[download]')
      .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href')));
    for (const attachment of attachments)
      await access(resolve(root, decodeURIComponent(attachment)));
    await page.screenshot({ path: resolve(qa, `report-${viewport.width}-summary.png`) });
    await page.locator('.enlarge').first().click();
    assert.equal(await page.locator('#viewer').evaluate((dialog) => dialog.open), true);
    await page.locator('#full-image').evaluate((img) => img.decode());
    await page.screenshot({ path: resolve(qa, `report-${viewport.width}-viewer.png`) });
    await page.locator('#zoom').click();
    assert.equal(
      await page.locator('#zoom-area').evaluate((area) => area.classList.contains('fit')),
      false,
    );
    await page.locator('#close').click();
    assert.equal(await page.locator('#viewer').evaluate((dialog) => dialog.open), false);
    await page.locator('nav a[href="#cases"]').click();
    assert.equal(await page.locator('#cases').isVisible(), true);
    assert.deepEqual(errors, []);
    checks.push({
      viewport,
      screenshotCount: count,
      imagesDecoded: true,
      horizontalOverflow: false,
      anchorsValid: true,
      attachmentLinksValid: attachments.length,
      zoomAndClose: true,
      pageErrors: errors,
    });
    await page.close();
  }
  const results = JSON.parse(await readFile(resolve(root, 'results.json'), 'utf8'));
  const original = JSON.parse(await readFile(resolve(root, 'results.original.json'), 'utf8'));
  const withoutAttachments = (value) =>
    JSON.parse(JSON.stringify(value, (key, item) => (key === 'attachments' ? undefined : item)));
  assert.deepEqual(withoutAttachments(results), withoutAttachments(original));
  const status = await (await fetch(`http://localhost:${localPorts().api}/local/status`)).json();
  assert.equal(status.mode, 'scripted');
  assert.equal(status.realModelVerified, false);
  assert.equal(status.externalDelivery, false);
  assert.equal(status.lastFailure, null);
  const result = {
    verifiedAt: new Date().toISOString(),
    checks,
    playwrightStats: results.stats,
    archivedOutcomesUnchanged: true,
    runtime: status,
  };
  await writeFile(resolve(qa, 'verification.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await browser.close();
}
