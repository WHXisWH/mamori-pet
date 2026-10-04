import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const source = resolve(process.argv[2] ?? 'artifacts/e2e-final-2026-10-02');
const target = resolve(process.argv[3] ?? 'artifacts/acceptance');
assert.notEqual(source, target, 'Archive must not replace the raw run');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};
const localPath = (path) => {
  const full = isAbsolute(path) ? path : resolve(source, path);
  const local = relative(source, full);
  assert.ok(local && !local.startsWith(`..${sep}`) && !isAbsolute(local));
  return local.split(sep).join('/');
};
let images = 0;
let omittedTraces = 0;
async function copyImage(path) {
  assert.ok(path.endsWith('.png'), 'Only screenshot assets are archived');
  const local = localPath(path);
  await mkdir(dirname(resolve(target, local)), { recursive: true });
  await copyFile(resolve(source, local), resolve(target, local));
  return local;
}
async function archiveEvidence(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await archiveEvidence(path);
    else if (entry.name === 'evidence.json') {
      const rows = await readJson(path);
      for (const row of rows) {
        row.screenshot = await copyImage(row.screenshot);
        images++;
      }
      await writeJson(resolve(target, localPath(path)), rows);
    }
  }
}
await mkdir(target, { recursive: true });
await archiveEvidence(resolve(source, 'raw-results'));
await copyFile(resolve(source, 'results.json'), resolve(target, 'results.original.json'));
const report = await readJson(resolve(source, 'results.json'));
async function archiveSuite(suite) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      for (const result of test.results ?? []) {
        const attachments = [];
        for (const attachment of result.attachments ?? []) {
          if (attachment.contentType === 'application/zip') {
            omittedTraces++;
          } else if (attachment.path) {
            if (attachment.contentType === 'image/png')
              attachments.push({ ...attachment, path: await copyImage(attachment.path) });
          } else attachments.push(attachment);
        }
        result.attachments = attachments;
      }
    }
  }
  for (const child of suite.suites ?? []) await archiveSuite(child);
}
for (const suite of report.suites) await archiveSuite(suite);
await writeJson(resolve(target, 'results.json'), report);
for (const filename of ['review-notes.json', 'environment.json'])
  await copyFile(resolve(source, filename), resolve(target, filename));
await writeJson(resolve(target, 'archive.json'), {
  archivedAt: new Date().toISOString(),
  evidenceImages: images,
  omittedTraces,
  originalResults: 'results.original.json',
  portableResults: 'results.json',
  transformations: [
    'Screenshot attachment paths and evidence paths are relative to this directory.',
    'Trace archives are omitted; all execution outcomes, timings and counts are unchanged.',
    'results.original.json is an unmodified copy of the Playwright reporter output.',
  ],
});
console.log(JSON.stringify({ target, evidenceImages: images, omittedTraces }, null, 2));
