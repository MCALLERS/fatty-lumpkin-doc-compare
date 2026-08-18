// Evidence capture for the download page: full-page + fold shots at three
// viewports, light and dark, plus console errors and a link check.
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const OUT = path.join(ROOT, 'qa/site-shots');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const file = path.join(SITE, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(SITE) || !fs.existsSync(file)) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1100x800', width: 1100, height: 800 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '390x844', width: 390, height: 844 },
];

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
});

const report = [];
for (const scheme of ['light', 'dark']) {
  for (const vp of VIEWPORTS) {
    if (scheme === 'dark' && vp.name === '1024x768') continue;
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, colorScheme: scheme });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
    page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.mouse.move(0, 0);
    await page.waitForTimeout(400);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    const cw = await page.evaluate(() => document.documentElement.clientWidth);
    if (sw > cw + 1) errors.push(`horizontal overflow at ${vp.name}: ${sw} > ${cw}`);
    await page.screenshot({ path: path.join(OUT, `${scheme}-${vp.name}-fold.png`) });
    await page.screenshot({ path: path.join(OUT, `${scheme}-${vp.name}-full.png`), fullPage: true });

    // section shots for close reading
    if (scheme === 'light' && vp.name === '1440x900') {
      for (const id of ['how', 'output', 'install', 'faq']) {
        const el = await page.$('#' + id);
        if (el) await el.screenshot({ path: path.join(OUT, `section-${id}.png`) });
      }
      // open every FAQ item and shoot again
      await page.$$eval('.faq details', (ds) => ds.forEach((d) => { d.open = true; }));
      await page.waitForTimeout(300);
      const faq = await page.$('#faq');
      if (faq) await faq.screenshot({ path: path.join(OUT, 'section-faq-open.png') });

      // internal anchors resolve?
      const anchors = await page.$$eval('a[href^="#"]', (as) => as.map((a) => a.getAttribute('href')));
      for (const a of anchors) {
        if (a === '#' ) { errors.push('empty anchor href'); continue; }
        const ok = await page.$(a);
        if (!ok) errors.push(`dead internal link ${a}`);
      }
      // download links wired?
      const href = await page.$eval('#dl-primary', (a) => a.href);
      if (!/releases/.test(href)) errors.push('primary download button is not pointing at a release asset');
      report.push(`primary download href: ${href}`);
      for (const id of ['dl-mac-arm', 'dl-mac-intel', 'dl-win']) {
        const h = await page.$eval('#' + id, (a) => a.href);
        if (!/download\/Fatty-Lumpkin/.test(h)) errors.push(`${id} is not a direct asset link: ${h}`);
      }
      // does the install panel appear when a download starts?
      await page.evaluate(() => document.addEventListener('click', (e) => e.preventDefault(), true));
      await page.evaluate(() => document.getElementById('dl-win').click());
      await page.waitForTimeout(200);
      const panelShown = await page.$eval('#after-download', (el) => !el.hidden);
      if (!panelShown) errors.push('install steps do not appear after a download click');
      const shot = await page.$('#after-download');
      if (shot) await shot.screenshot({ path: path.join(OUT, 'section-after-download.png') });
      await page.evaluate(() => { document.getElementById('after-download').hidden = true; });
      // document width must not exceed the viewport
      const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientW = await page.evaluate(() => document.documentElement.clientWidth);
      if (scrollW > clientW + 1) errors.push(`horizontal overflow: ${scrollW} > ${clientW}`);
    }
    if (errors.length) report.push(`${scheme} ${vp.name}: ${errors.join(' | ')}`);
    await ctx.close();
  }
}
await browser.close();
server.close();

fs.writeFileSync(path.join(OUT, 'report.txt'), report.join('\n') || 'clean\n');
console.log(report.length ? report.join('\n') : 'no console errors, no dead links');
console.log('shots ->', OUT);
