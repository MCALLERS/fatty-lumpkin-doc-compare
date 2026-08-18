// Renders a redline HTML file to PDF + page PNGs the same way Electron will,
// so the print output can be reviewed without launching the desktop app.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const [, , htmlPath, outDir] = process.argv;
if (!htmlPath) { console.error('usage: node render-pdf.mjs <html> <outdir>'); process.exit(1); }
const dir = outDir || 'qa/out';
mkdirSync(dir, { recursive: true });

const html = readFileSync(htmlPath, 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.setContent(html, { waitUntil: 'load' });
const base = path.basename(htmlPath).replace(/\.html$/, '');
const pdf = path.join(dir, base + '.pdf');
await page.pdf({
  path: pdf,
  format: 'Letter',
  printBackground: true,
  margin: { top: '16mm', bottom: '16mm', left: '15mm', right: '15mm' },
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate:
    '<div style="width:100%;font:8px \'Segoe UI\',Helvetica,Arial,sans-serif;color:#7A7364;padding:0 15mm;display:flex;justify-content:space-between;">'
    + '<span>Fatty Lumpkin Doc Compare</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>',
});
await browser.close();
console.log('pdf ->', pdf, errors.length ? 'CONSOLE ERRORS: ' + errors.join(' | ') : 'no console errors');
execSync(`pdftoppm -png -r 110 "${pdf}" "${path.join(dir, base)}"`);
console.log(execSync(`ls ${dir}`).toString());
