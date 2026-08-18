// Captures evidence screenshots of every app screen, at several window sizes,
// in both colour schemes, plus console errors and a keyboard-reachability walk.
// The numbers on screen come from a real engine run so they reconcile with the
// fixture documents. Run: node qa/shoot-app.mjs
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = path.join(ROOT, 'app/src/renderer');
const OUT = path.join(ROOT, 'qa/shots');
const MOCK = fs.readFileSync(path.join(ROOT, 'qa/mock-preload.js'), 'utf8');

const require = createRequire(path.join(ROOT, 'app/package.json'));
const { buildRedline } = require(path.join(ROOT, 'app/src/engine'));
const { quoteAt } = require(path.join(ROOT, 'app/src/shared/quotes'));

const real = await buildRedline({
  oldPath: path.join(ROOT, 'fixtures/MSA_v1.docx'),
  newPath: path.join(ROOT, 'fixtures/MSA_v2.docx'),
  docx: false, html: false,
});
const REAL = { stats: real.stats, quote: quoteAt(11) };
console.log('real stats used in shots:', JSON.stringify(REAL.stats));

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const file = path.join(RENDERER, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(RENDERER) || !fs.existsSync(file)) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '820x700', width: 820, height: 700 },
  { name: '620x560', width: 620, height: 560 },
  { name: '390x844', width: 390, height: 844 },
];

const toPicker = async (p, count = 2, mode = 'both') => {
  await p.evaluate(([n, m]) => window.__mock.emit('files', { files: window.__mock.FILES.slice(0, n), mode: m, rejected: [] }), [count, mode]);
  await p.waitForSelector('body[data-screen="picker"] .card');
};

const SCENES = [
  { id: '01-drop', run: async () => {} },
  {
    id: '02-drop-one', run: async (p) => {
      await p.evaluate(() => window.__mock.emit('files', {
        files: [window.__mock.FILES[0]], mode: 'both', rejected: ['Withywindle term sheet.pdf'],
      }));
      await p.waitForSelector('#staged:not([hidden])');
    },
  },
  { id: '03-picker', run: (p) => toPicker(p, 2) },
  { id: '04-picker-three', run: (p) => toPicker(p, 3, 'word') },
  {
    id: '05-working', run: async (p) => {
      await toPicker(p, 2);
      await p.evaluate(() => {
        const orig = window.lumpkin.compare;
        window.lumpkin.compare = async (a) => { await new Promise((r) => setTimeout(r, 60000)); return orig(a); };
      });
      await p.click('#cards .card');
      await p.waitForSelector('body[data-screen="working"]');
      await p.waitForTimeout(700);
    },
  },
  {
    id: '06-done', run: async (p) => {
      await toPicker(p, 2);
      await p.click('#cards .card');
      await p.waitForSelector('body[data-screen="done"]', { timeout: 8000 });
    },
  },
  {
    id: '07-error', run: async (p) => {
      await p.evaluate(() => { window.__MOCK_FAIL__ = 'busy'; });
      await toPicker(p, 2);
      await p.click('#cards .card');
      await p.waitForSelector('body[data-screen="error"]', { timeout: 8000 });
    },
  },
  {
    id: '08-settings', run: async (p) => {
      await p.click('#settings-btn');
      await p.waitForSelector('#sheet:not([hidden])');
    },
  },
  {
    id: '09-identical', run: async (p) => {
      await p.evaluate(() => { window.__MOCK_IDENTICAL__ = true; });
      await toPicker(p, 2);
      await p.click('#cards .card');
      await p.waitForSelector('body[data-screen="done"]', { timeout: 8000 });
    },
  },
  {
    id: '10-error-readonly', run: async (p) => {
      await p.evaluate(() => { window.__MOCK_FAIL__ = 'readonly'; });
      await toPicker(p, 2);
      await p.click('#cards .card');
      await p.waitForSelector('body[data-screen="error"]', { timeout: 8000 });
    },
  },
];

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});

const problems = [];
for (const scheme of ['light', 'dark']) {
  for (const vp of VIEWPORTS) {
    if (scheme === 'dark' && !['820x700', '1440x900'].includes(vp.name)) continue;
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      colorScheme: scheme,
    });
    await ctx.addInitScript(`window.__REAL__ = ${JSON.stringify(REAL)};`);
    await ctx.addInitScript(MOCK);
    for (const scene of SCENES) {
      const page = await ctx.newPage();
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
      page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
      await page.goto(base, { waitUntil: 'networkidle' });
      await page.waitForSelector('body[data-screen="drop"]');
      await scene.run(page);
      await page.mouse.move(0, 0);
      await page.waitForTimeout(450);
      await page.screenshot({ path: path.join(OUT, `${scheme}-${vp.name}-${scene.id}.png`) });
      if (errors.length) problems.push(`${scheme} ${vp.name} ${scene.id}: ${errors.join(' | ')}`);
      await page.close();
    }
    await ctx.close();
  }
}

/* ---- keyboard walk: every screen must be fully reachable by Tab ---- */
{
  const ctx = await browser.newContext({ viewport: { width: 820, height: 700 } });
  await ctx.addInitScript(`window.__REAL__ = ${JSON.stringify(REAL)};`);
  await ctx.addInitScript(MOCK);
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('body[data-screen="drop"]');

  const walk = async (label, limit = 14) => {
    const seen = [];
    for (let i = 0; i < limit; i++) {
      await page.keyboard.press('Tab');
      seen.push(await page.evaluate(() => {
        const a = document.activeElement;
        if (!a || a === document.body) return 'BODY';
        return (a.id || a.className || a.tagName).toString().split(' ')[0];
      }));
      if (seen.length > 2 && seen[seen.length - 1] === seen[0]) break;
    }
    return `${label}: ${seen.join(' -> ')}`;
  };

  problems.push('TAB ' + await walk('drop'));
  await toPicker(page, 2);
  problems.push('TAB ' + await walk('picker'));
  await page.click('#cards .card');
  await page.waitForSelector('body[data-screen="done"]', { timeout: 8000 });
  problems.push('TAB ' + await walk('done'));

  // focus must survive re-rendering the card list in the three-document flow
  await page.evaluate(() => window.__mock.emit('files', { files: window.__mock.FILES, mode: 'both', rejected: [] }));
  await page.waitForSelector('body[data-screen="picker"] .card');
  await page.waitForTimeout(300);      // let the screen-change focus settle first
  await page.evaluate(() => document.querySelectorAll('#cards .card')[1].focus());
  const before = await page.evaluate(() => document.activeElement.querySelector('.card-name')?.textContent.trim());
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => {
    const a = document.activeElement;
    return a && a.classList.contains('card')
      ? 'card: ' + a.querySelector('.card-name').textContent.trim()
      : 'LOST (' + (a ? (a.id || a.tagName) : 'none') + ')';
  });
  problems.push(`FOCUS after selecting card "${before}" -> ${after}`);

  await ctx.close();
}

await browser.close();
server.close();

fs.writeFileSync(path.join(OUT, 'console.txt'), problems.join('\n') || 'clean\n');
fs.writeFileSync(path.join(OUT, 'real-stats.json'), JSON.stringify(REAL, null, 2));
console.log('shots ->', OUT);
console.log(problems.length ? problems.join('\n') : 'no console errors or warnings');
void pathToFileURL;
