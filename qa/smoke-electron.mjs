// End-to-end smoke test: launches the real Electron app, hands it two documents
// the way the right-click menu would, drives the interface, and checks that the
// files it writes are real. Run: xvfb-run -a node qa/smoke-electron.mjs
import { _electron as electron } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lumpkin-smoke-'));
for (const f of ['MSA_v1.docx', 'MSA_v2.docx']) {
  fs.copyFileSync(path.join(ROOT, 'fixtures', f), path.join(work, f));
}

const fail = (msg) => { console.error('SMOKE FAIL:', msg); process.exitCode = 1; };

const app = await electron.launch({
  executablePath: path.join(ROOT, 'app/node_modules/electron/dist/electron'),
  args: [
    '--no-sandbox', '--disable-gpu',
    path.join(ROOT, 'app'),
    '--mode=both',
    path.join(work, 'MSA_v1.docx'),
    path.join(work, 'MSA_v2.docx'),
  ],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  timeout: 60000,
});

const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

// The two documents arrive through the coalescing + pull handshake.
await win.waitForSelector('body[data-screen="picker"] .card', { timeout: 30000 });
const cards = await win.$$eval('#cards .card .card-name', (els) => els.map((e) => e.textContent.trim()));
console.log('picker shows:', cards.join('  |  '));
if (cards.length !== 2) fail(`expected two cards, got ${cards.length}`);

await win.click('#cards .card');                       // the first card is the older draft
await win.waitForSelector('body[data-screen="done"]', { timeout: 60000 });

const summary = await win.textContent('#done-summary');
const outputs = await win.$$eval('#outputs .file-name', (els) => els.map((e) => e.textContent.trim()));
console.log('done screen:', summary.replace(/\s+/g, ' ').trim());
console.log('outputs:', outputs.join('  |  '));

const written = fs.readdirSync(work).filter((f) => f.startsWith('Redline - '));
console.log('files on disk:', written.join('  |  '));
if (!written.some((f) => f.endsWith('.docx'))) fail('no .docx was written');
if (!written.some((f) => f.endsWith('.pdf'))) fail('no .pdf was written');
for (const f of written) {
  const size = fs.statSync(path.join(work, f)).size;
  if (size < 5000) fail(`${f} is only ${size} bytes`);
  console.log(`  ${f}  ${(size / 1024).toFixed(0)} KB`);
}
const pdf = written.find((f) => f.endsWith('.pdf'));
if (pdf && !fs.readFileSync(path.join(work, pdf)).subarray(0, 5).toString().startsWith('%PDF')) {
  fail('the PDF is not a PDF');
}

const quote = await win.textContent('#quote-line');
if (!quote || !quote.trim()) fail('no Tom Bombadil quote was shown');
else console.log('reward quote:', quote.replace(/\n/g, ' / '));

if (errors.length) fail('console errors: ' + errors.join(' | '));

await app.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(process.exitCode ? '\nSMOKE TEST FAILED' : '\nSMOKE TEST PASSED');
