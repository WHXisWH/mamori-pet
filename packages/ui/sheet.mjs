import { chromium } from '@playwright/test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { PetAvatar } from './dist/index.js';
const chars = ['moko', 'pokke', 'togemaru', 'nami', 'hoshi', 'hidden'];
const exprs = ['happy', 'caring', 'sleepy', 'together', 'celebrate', 'worried'];
let html =
  '<html><body style="margin:0;background:#fff8f0;font-family:sans-serif"><table style="border-collapse:collapse">';
html +=
  '<tr><td></td>' +
  exprs.map((e) => `<td style="text-align:center;font-size:14px;padding:4px">${e}</td>`).join('') +
  '</tr>';
for (const c of chars) {
  html +=
    `<tr><td style="font-size:14px;padding:6px">${c}</td>` +
    exprs
      .map(
        (e) =>
          `<td>${renderToStaticMarkup(createElement(PetAvatar, { characterId: c, expression: e, size: 150, animate: false }))}</td>`,
      )
      .join('') +
    '</tr>';
}
html += '</table></body></html>';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
await page.setContent(html);
await page.screenshot({
  path: 'sheet.png',
  fullPage: true,
});
await browser.close();
