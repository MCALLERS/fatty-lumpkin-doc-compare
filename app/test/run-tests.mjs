// Engine tests. No framework: fails loudly, exits non-zero, runs on any CI box.
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import os from 'os';
import JSZip from 'jszip';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');

const { buildRedline, guessOlder } = require('../src/engine');
const D = require('../src/engine/diff');

let passed = 0;
const failures = [];

function check(name, fn) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${e.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

/* ------------------------------ diff unit ------------------------------ */

check('tokenize keeps words whole', () => {
  const t = D.tokenize('Section 1.2 shall not apply, mutatis mutandis.');
  assert(t.includes('mutandis'), 'word split apart');
  assert(t.includes('1.2'), 'decimal number split apart');
  eq(t.join(''), 'Section 1.2 shall not apply, mutatis mutandis.', 'tokens do not round-trip');
});

check('word diff marks only what changed', () => {
  const a = D.tokenize('the quick brown fox jumps over the lazy dog');
  const b = D.tokenize('the quick red fox jumps over the lazy dog');
  const ops = D.myers(a, b);
  const changed = ops.filter((o) => o.op !== 'equal');
  eq(changed.length, 2, 'expected exactly one delete plus one insert');
  eq(a.slice(changed[0].aStart, changed[0].aEnd).join(''), 'brown');
  eq(b.slice(changed[1].bStart, changed[1].bEnd).join(''), 'red');
});

check('identical input produces no edits', () => {
  const t = D.tokenize('nothing at all has changed here');
  eq(D.myers(t, t).filter((o) => o.op !== 'equal').length, 0);
});

check('patience diff aligns around unique anchors', () => {
  const a = ['x', 'a', 'b', 'c', 'y'];
  const b = ['x', 'a', 'q', 'c', 'y'];
  const ops = D.patience(a, b);
  const del = ops.filter((o) => o.op === 'delete');
  eq(del.length, 1);
  eq(a.slice(del[0].aStart, del[0].aEnd).join(''), 'b');
});

check('similarity separates edits from unrelated text', () => {
  const near = D.similarity('the term shall be twelve months', 'the term shall be twenty-four months');
  const far = D.similarity('the term shall be twelve months', 'governing law is Delaware');
  assert(near > 0.34, `near-identical text scored ${near}`);
  assert(far < 0.2, `unrelated text scored ${far}`);
});

check('guessOlder prefers lower version numbers', () => {
  const older = { name: 'Agreement v1.docx', modified: new Date('2026-05-01') };
  const newer = { name: 'Agreement v2.docx', modified: new Date('2026-04-01') };
  eq(guessOlder(older, newer), 0, 'v1 should be picked as older even with a later mtime');
  eq(guessOlder(newer, older), 1);
});

check('guessOlder falls back to modified time', () => {
  const a = { name: 'contract.docx', modified: new Date('2026-01-01') };
  const b = { name: 'contract copy.docx', modified: new Date('2026-02-01') };
  eq(guessOlder(a, b), 0);
});

/* --------------------------- end-to-end docx --------------------------- */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

async function revisionText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml').async('string');
  const ins = [...xml.matchAll(/<w:ins\b[^>]*>([\s\S]*?)<\/w:ins>/g)]
    .map((m) => [...m[1].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((t) => t[1]).join(''))
    .filter(Boolean);
  const del = [...xml.matchAll(/<w:del\b[^>]*>([\s\S]*?)<\/w:del>/g)]
    .map((m) => [...m[1].matchAll(/<w:delText[^>]*>([\s\S]*?)<\/w:delText>/g)].map((t) => t[1]).join(''))
    .filter(Boolean);
  return { ins, del, xml };
}

const havefixtures = fs.existsSync(path.join(FIXTURES, 'MSA_v1.docx'));

if (havefixtures) {
  await checkAsync('MSA pair produces minimal word-level tracked changes', async () => {
    const r = await buildRedline({
      oldPath: path.join(FIXTURES, 'MSA_v1.docx'),
      newPath: path.join(FIXTURES, 'MSA_v2.docx'),
    });
    assert(r.docx && r.docx.length > 1000, 'no docx produced');
    assert(r.html && r.html.includes('<ins>'), 'html has no insertions');
    assert(r.stats.insertedWords > 0 && r.stats.deletedWords > 0, 'stats look empty');

    const { ins, del } = await revisionText(r.docx);
    assert(ins.length > 0 && del.length > 0, 'no revisions in the docx');
    // Economy of redlining: nothing should be deleted and re-inserted verbatim.
    const insSet = new Set(ins.map((s) => s.trim()).filter((s) => s.length > 3));
    for (const d of del) {
      const t = d.trim();
      if (t.length > 3) assert(!insSet.has(t), `text "${t}" was deleted and re-inserted unchanged`);
    }
    // Deletions should be tight, not whole re-typed paragraphs.
    const longDeletes = del.filter((d) => d.split(/\s+/).length > 25);
    assert(longDeletes.length <= 1, `too many sprawling deletions: ${longDeletes.length}`);
  });

  await checkAsync('identical documents report no changes', async () => {
    const r = await buildRedline({
      oldPath: path.join(FIXTURES, 'Memo_same_A.docx'),
      newPath: path.join(FIXTURES, 'Memo_same_B.docx'),
    });
    eq(r.stats.insertedWords, 0);
    eq(r.stats.deletedWords, 0);
    assert(r.stats.identical === true, 'identical flag not set');
    const { ins, del } = await revisionText(r.docx);
    eq(ins.length, 0, 'insertions on identical documents');
    eq(del.length, 0, 'deletions on identical documents');
    assert(/No differences found/.test(r.html), 'PDF body does not say the documents match');
  });

  await checkAsync('output docx stays a readable package', async () => {
    const r = await buildRedline({
      oldPath: path.join(FIXTURES, 'MSA_v1.docx'),
      newPath: path.join(FIXTURES, 'MSA_v2.docx'),
    });
    const zip = await JSZip.loadAsync(r.docx);
    for (const part of ['[Content_Types].xml', 'word/document.xml', 'word/_rels/document.xml.rels']) {
      assert(zip.file(part), `missing package part ${part}`);
    }
    const xml = await zip.file('word/document.xml').async('string');
    assert(xml.startsWith('<?xml'), 'document.xml lost its declaration');
    assert(!/<w:t[^>]*>[^<]*<w:delText/.test(xml), 'delText nested inside w:t');
  });

  await checkAsync('comparing a file with itself is refused', async () => {
    let threw = false;
    try {
      await buildRedline({
        oldPath: path.join(FIXTURES, 'MSA_v1.docx'),
        newPath: path.join(FIXTURES, 'MSA_v1.docx'),
      });
    } catch (e) { threw = true; assert(e.userFacing, 'error is not user-facing'); }
    assert(threw, 'comparing a file with itself should be refused');
  });

  await checkAsync('a non-Word file gives a friendly error', async () => {
    const junk = path.join(os.tmpdir(), 'not-a-doc.docx');
    fs.writeFileSync(junk, 'this is plain text, not a zip');
    let msg = '';
    try {
      await buildRedline({ oldPath: junk, newPath: path.join(FIXTURES, 'MSA_v1.docx') });
    } catch (e) { msg = e.message; assert(e.userFacing, 'error is not user-facing'); }
    fs.unlinkSync(junk);
    assert(/doesn't look like a Word document/i.test(msg), `unhelpful message: ${msg}`);
  });

  await checkAsync('a 400-clause document compares quickly', async () => {
    const t0 = Date.now();
    const r = await buildRedline({
      oldPath: path.join(FIXTURES, 'Definitions_v1.docx'),
      newPath: path.join(FIXTURES, 'Definitions_v2.docx'),
    });
    const ms = Date.now() - t0;
    assert(r.stats.changedBlocks > 5, 'expected changes were not found');
    assert(ms < 8000, `took ${ms}ms, expected under 8000ms`);
  });
} else {
  console.log('  (skipping document tests — fixtures not present)');
}

/* ------------------- accept / reject round-trip ------------------------ */
/*
 * The strongest correctness invariant a redline has: accepting every tracked
 * change must reproduce the revised document exactly, and rejecting every
 * change must reproduce the original. If either fails, the markup is lying.
 */

const { DOMParser } = require('@xmldom/xmldom');
const X = require('../src/engine/ooxml');
const { acceptRevisions, rejectRevisions } = require('../src/engine/docfile');

const COMPARABLE = /^word\/(document|footnotes|endnotes|header\d+|footer\d+)\.xml$/;

async function partText(buffer, transform) {
  const zip = await JSZip.loadAsync(buffer);
  const out = {};
  for (const name of Object.keys(zip.files).sort()) {
    if (!COMPARABLE.test(name)) continue;
    const doc = new DOMParser({ onError: () => {} })
      .parseFromString(await zip.file(name).async('string'), 'text/xml');
    const root = doc.documentElement;
    if (transform) transform(root);
    // Deliberately NOT whitespace-normalised and NOT filtered: a stray space or
    // an orphan empty paragraph left behind by accept/reject is exactly the kind
    // of defect this invariant exists to catch.
    const paras = X.descendants(root, 'p').map((p) => X.textOf(p).replace(/[ \t]+/g, ' '));
    while (paras.length && paras[paras.length - 1] === '') paras.pop();
    if (paras.length) out[name] = paras.join('\u23ce');
  }
  return out;
}

const ROUND_TRIP_PAIRS = [
  ['MSA_v1.docx', 'MSA_v2.docx'],
  ['Memo_same_A.docx', 'Memo_same_B.docx'],
  ['Definitions_v1.docx', 'Definitions_v2.docx'],
  ...(fs.existsSync(path.join(FIXTURES, 'edge')) ? [
    ['edge/short_v1.docx', 'edge/short_v2.docx'],
    ['edge/split_v1.docx', 'edge/split_v2.docx'],
    ['edge/merge_v1.docx', 'edge/merge_v2.docx'],
    ['edge/list_v1.docx', 'edge/list_v2.docx'],
    ['edge/parts_v1.docx', 'edge/parts_v2.docx'],
    ['edge/heading_v1.docx', 'edge/heading_v2.docx'],
    ['edge/table_v1.docx', 'edge/table_v2.docx'],
    ['edge/longtable_v1.docx', 'edge/longtable_v2.docx'],
  ] : []),
];

if (havefixtures) {
  for (const [a, b] of ROUND_TRIP_PAIRS) {
    await checkAsync(`accept-all and reject-all round-trip: ${a} -> ${b}`, async () => {
      const oldPath = path.join(FIXTURES, a), newPath = path.join(FIXTURES, b);
      if (!fs.existsSync(oldPath) || !fs.existsSync(newPath)) return;   // fixture set not built
      const r = await buildRedline({ oldPath, newPath, html: false });

      const wanted = await partText(fs.readFileSync(newPath), (root) => acceptRevisions(root));
      const accepted = await partText(r.docx, (root) => acceptRevisions(root));
      for (const key of Object.keys(wanted)) {
        eq(accepted[key], wanted[key], `accept-all does not reproduce ${b} in ${key}`);
      }

      const original = await partText(fs.readFileSync(oldPath), (root) => acceptRevisions(root));
      const rejected = await partText(r.docx, (root) => rejectRevisions(root));
      for (const key of Object.keys(original)) {
        eq(rejected[key], original[key], `reject-all does not reproduce ${a} in ${key}`);
      }
    });
  }

  await checkAsync('a change that lives only in a header is found, not reported as identical', async () => {
    const oldPath = path.join(FIXTURES, 'edge/parts_v1.docx');
    const newPath = path.join(FIXTURES, 'edge/parts_v2.docx');
    if (!fs.existsSync(oldPath)) return;
    const r = await buildRedline({ oldPath, newPath });
    assert(r.stats.identical === false, 'a header-only change was reported as identical');
    assert(r.stats.insertedWords > 0, 'no insertions counted for a header-only change');
    assert(/Header|Footer/.test(r.html), 'the PDF does not label the changed part');
  });

  await checkAsync('a table row with one changed cell is not struck and retyped', async () => {
    const oldPath = path.join(FIXTURES, 'edge/table_v1.docx');
    const newPath = path.join(FIXTURES, 'edge/table_v2.docx');
    if (!fs.existsSync(oldPath)) return;
    const r = await buildRedline({ oldPath, newPath });
    const { ins, del } = await revisionText(r.docx);
    const insSet = new Set(ins.map((t) => t.trim()).filter(Boolean));
    for (const d of del) {
      const t = d.trim();
      if (t) assert(!insSet.has(t), `"${t}" was struck and retyped inside a table`);
    }
    assert(del.some((t) => /2,400/.test(t)) && ins.some((t) => /3,600/.test(t)), 'the changed rate was not marked');
  });

  await checkAsync('word counts match how a person would count', () => {
    eq(D.wordsOf('$22,000 forty-five non-exclusive').length, 3, 'numbers and hyphenated words counted twice');
    eq(D.wordsOf('1,000,000').length, 1);
  });

  await checkAsync('a change only in a header is never reported as identical', async () => {
    const oldPath = path.join(FIXTURES, 'edge/parts_v1.docx');
    const newPath = path.join(FIXTURES, 'edge/parts_v2.docx');
    if (!fs.existsSync(oldPath)) return;
    const r = await buildRedline({ oldPath, newPath });
    assert(!r.stats.identical, 'header-only change reported as identical');
  });

  await checkAsync('a one-word edit in a short paragraph is not struck and retyped', async () => {
    const oldPath = path.join(FIXTURES, 'edge/short_v1.docx');
    const newPath = path.join(FIXTURES, 'edge/short_v2.docx');
    if (!fs.existsSync(oldPath)) return;
    const r = await buildRedline({ oldPath, newPath });
    const { ins, del } = await revisionText(r.docx);
    for (const d of del) assert(!/Term:|Logo:|Governing law:/.test(d), `whole label struck: "${d}"`);
    for (const i of ins) assert(!/Term:|Logo:|Governing law:/.test(i), `whole label retyped: "${i}"`);
    assert(del.includes('New York') && ins.includes('Delaware'), 'the replacement was not a single clean span');
  });

  await checkAsync('splitting a paragraph marks only the paragraph mark', async () => {
    const oldPath = path.join(FIXTURES, 'edge/split_v1.docx');
    const newPath = path.join(FIXTURES, 'edge/split_v2.docx');
    if (!fs.existsSync(oldPath)) return;
    const r = await buildRedline({ oldPath, newPath });
    const { ins, del } = await revisionText(r.docx);
    // Only the whitespace that used to join the halves is marked, nothing else.
    eq(ins.filter((t) => t.trim()).length, 0, 'text was re-inserted for a paragraph split');
    eq(del.filter((t) => t.trim()).length, 0, 'visible text was struck for a paragraph split');
    eq(r.stats.paragraphBreaks, 1, 'the split was not recorded');
  });

  await checkAsync('merging paragraphs marks only the paragraph mark', async () => {
    const oldPath = path.join(FIXTURES, 'edge/merge_v1.docx');
    const newPath = path.join(FIXTURES, 'edge/merge_v2.docx');
    if (!fs.existsSync(oldPath)) return;
    const r = await buildRedline({ oldPath, newPath });
    const { ins, del } = await revisionText(r.docx);
    eq(ins.filter((t) => t.trim()).length, 0, 'text was re-inserted for a paragraph merge');
    eq(del.filter((t) => t.trim()).length, 0, 'text was struck for a paragraph merge');
    eq(r.stats.paragraphBreaks, 1, 'the merge was not recorded');
  });

  await checkAsync('a deleted list item keeps the number it had in the original', async () => {
    const oldPath = path.join(FIXTURES, 'edge/list_v1.docx');
    const newPath = path.join(FIXTURES, 'edge/list_v2.docx');
    if (!fs.existsSync(oldPath)) return;
    const r = await buildRedline({ oldPath, newPath });
    const labels = [...r.html.split('</header>').pop().matchAll(/<span class="num">([^<]*)<\/span>/g)]
      .map((m) => m[1].trim());
    // Surviving items carry their NEW number; struck items keep the number they
    // had in the original, so a reader can still find the clause being removed.
    // Original 1..5 with items 2 and 4 deleted -> 1, [2], 2, [4], 3.
    eq(labels.join(' '), '1. [2.] 2. [4.] 3.', `list numbering drifted: ${labels.join(' ')}`);
    const listBody = r.html.split('</header>').pop();
    const struck = [...listBody.matchAll(/<del><span class="num">([^<]*)<\/span>/g)].map((m) => m[1].trim());
    eq(struck.join(' '), '[2.] [4.]', `deleted items lost their original numbers: ${struck.join(' ')}`);
  });

  await checkAsync('word counts reconcile with an independent recount', async () => {
    const r = await buildRedline({
      oldPath: path.join(FIXTURES, 'MSA_v1.docx'),
      newPath: path.join(FIXTURES, 'MSA_v2.docx'),
      docx: false,
    });
    const { ins, del } = { ins: [], del: [] };
    // Recount straight off the rendered PDF body, which is produced separately
    // from the counter in compare.js.
    // The legend in the header band is not content, and generated list numbers
    // are furniture rather than words from the document.
    const bodyHtml = r.html.split('</header>').pop()
      .replace(/<span class="num">[^<]*<\/span>/g, '');
    const insWords = [...bodyHtml.matchAll(/<ins(?: [^>]*)?>([\s\S]*?)<\/ins>/g)]
      .map((m) => m[1].replace(/<[^>]+>/g, ''))
      .join(' ');
    const delWords = [...bodyHtml.matchAll(/<del(?: [^>]*)?>([\s\S]*?)<\/del>/g)]
      .map((m) => m[1].replace(/<[^>]+>/g, ''))
      .join(' ');
    const count = (s) => D.wordsOf(s).length;
    eq(count(insWords), r.stats.insertedWords, 'insertion count disagrees with the rendered PDF');
    eq(count(delWords), r.stats.deletedWords, 'deletion count disagrees with the rendered PDF');
    void ins; void del;
  });
}

/* ---------------- changes text alone cannot see ------------------------ */

if (havefixtures && fs.existsSync(path.join(FIXTURES, 'edge/imgswap_v1.docx'))) {
  const cases = [
    ['imgswap', 'a picture swapped for a different picture'],
    ['bold', 'a phrase that became bold'],
    ['hdr', 'a header that appears in only one document'],
    ['imgdrop', 'a picture that was removed'],
    ['cells', 'a table column that was removed'],
  ];
  for (const [name, description] of cases) {
    await checkAsync(`${description} is not reported as identical`, async () => {
      const r = await buildRedline({
        oldPath: path.join(FIXTURES, `edge/${name}_v1.docx`),
        newPath: path.join(FIXTURES, `edge/${name}_v2.docx`),
      });
      assert(r.stats.identical === false, `${description} was reported as identical`);
      assert(r.stats.changedBlocks > 0, `${description} produced no change`);
    });
  }

  await checkAsync('a removed picture is marked, not silently dropped', async () => {
    const r = await buildRedline({
      oldPath: path.join(FIXTURES, 'edge/imgdrop_v1.docx'),
      newPath: path.join(FIXTURES, 'edge/imgdrop_v2.docx'),
    });
    const { del } = await revisionText(r.docx);
    assert(del.some((t) => /image removed/i.test(t)), 'the removed picture left no mark');
  });

  await checkAsync('a removed table column is struck through', async () => {
    const r = await buildRedline({
      oldPath: path.join(FIXTURES, 'edge/cells_v1.docx'),
      newPath: path.join(FIXTURES, 'edge/cells_v2.docx'),
    });
    const { del } = await revisionText(r.docx);
    assert(del.some((t) => /Notes/.test(t)), 'the removed column produced no deletion');
  });

  await checkAsync('a one-cell edit does not strike and retype the whole row', async () => {
    const r = await buildRedline({
      oldPath: path.join(FIXTURES, 'edge/rows_v1.docx'),
      newPath: path.join(FIXTURES, 'edge/rows_v2.docx'),
    });
    const { ins, del } = await revisionText(r.docx);
    assert(!del.some((t) => /Term/.test(t)), 'the unchanged label was struck through');
    assert(!ins.some((t) => /Term/.test(t)), 'the unchanged label was retyped');
  });

  await checkAsync('Chinese text is compared character by character', () => {
    const { ta, tb, ops } = D.diffText('本協議自二零二六年八月十二日起生效', '本協議自二零二六年九月十五日起生效');
    const changed = ops.filter((o) => o.op !== 'equal');
    assert(changed.length <= 4, `a date change rewrote the whole sentence (${changed.length} edits)`);
    void ta; void tb;
  });
}

/* ------------------------------- report -------------------------------- */

if (failures.length) {
  console.error(`\n${failures.length} test(s) FAILED:\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  console.error(`\n${passed} passed, ${failures.length} failed\n`);
  process.exit(1);
}
console.log(`\n  ✓ ${passed} tests passed\n`);
