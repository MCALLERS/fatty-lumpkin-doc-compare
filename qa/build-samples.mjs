// Rebuilds every fixture redline (docx + html) into out/ and prints a summary.
import { createRequire } from 'module';
import { mkdirSync, writeFileSync } from 'fs';
const require = createRequire(import.meta.url);
const { buildRedline } = require('../app/src/engine');

const PAIRS = [
  ['MSA_v1.docx', 'MSA_v2.docx', 'MSA_redline'],
  ['Memo_same_A.docx', 'Memo_same_B.docx', 'same'],
  ['Definitions_v1.docx', 'Definitions_v2.docx', 'big'],
];

mkdirSync('out', { recursive: true });
for (const [a, b, name] of PAIRS) {
  const t0 = Date.now();
  const r = await buildRedline({ oldPath: `fixtures/${a}`, newPath: `fixtures/${b}` });
  writeFileSync(`out/${name}.docx`, r.docx);
  writeFileSync(`out/${name}.html`, r.html);
  console.log(name.padEnd(14), JSON.stringify(r.stats), `${Date.now() - t0}ms`);
}
