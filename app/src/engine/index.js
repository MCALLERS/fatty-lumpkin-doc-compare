'use strict';
/**
 * Fatty Lumpkin compare engine.
 *
 *   buildRedline({ oldPath, newPath })
 *     -> { stats, meta, docx: Buffer|null, html: string|null }
 *
 * Everything here is plain Node with no Electron dependency, so the engine can
 * be unit-tested and reused headlessly.
 */

const fs = require('fs');
const path = require('path');

const {
  loadDocx, acceptRevisions, styleIds, numIds, UserError, baseName,
  auxContainers, docDates, countRevisions, mediaFingerprints,
} = require('./docfile');
const M = require('./model');
const C = require('./compare');
const { Emitter } = require('./emit-docx');
const { HtmlRenderer } = require('./emit-html');
const { pdfDocument } = require('./pdf-template');

const AUTHOR = 'Fatty Lumpkin Doc Compare';

/** Order aux sections the way a reader expects them. */
const AUX_ORDER = ['header', 'footer', 'footnote', 'endnote'];
function auxRank(key) {
  const kind = key.split(':')[0];
  const i = AUX_ORDER.indexOf(kind);
  return (i < 0 ? 99 : i) * 10000 + Number(key.split(':')[1] || 0);
}

async function buildRedline(options) {
  const opts = options || {};
  const oldPath = opts.oldPath, newPath = opts.newPath;
  if (!oldPath || !newPath) throw new UserError('Two documents are needed to make a redline.');
  if (path.resolve(oldPath) === path.resolve(newPath)) {
    throw new UserError('Those are the same file. Pick two different documents.');
  }

  const [oldPkg, newPkg] = await Promise.all([loadDocx(oldPath), loadDocx(newPath)]);

  // Both documents are settled to their final text first; say so if either of
  // them arrived with pending revisions, because that changes what "no
  // differences" means.
  const preExisting = countRevisions(oldPkg.body) + countRevisions(newPkg.body);
  acceptRevisions(oldPkg.body, oldPkg.document);
  acceptRevisions(newPkg.body, newPkg.document);

  const oldMedia = mediaFingerprints(oldPkg);
  const newMedia = mediaFingerprints(newPkg);
  const oldBlocks = M.blocksOf(oldPkg.body, oldMedia);
  const newBlocks = M.blocksOf(newPkg.body, newMedia);

  if (!oldBlocks.length && !newBlocks.length) {
    throw new UserError('Both documents are empty, so there is nothing to compare.');
  }

  const entries = C.plan(oldBlocks, newBlocks);
  const stats = C.countChanges(entries);

  /* ---- footnotes, endnotes, headers and footers -------------------- */

  const oldAux = auxContainers(oldPkg);
  const newAux = auxContainers(newPkg);
  const auxSections = [];
  const skippedParts = [];

  for (const key of [...new Set([...oldAux.keys(), ...newAux.keys()])].sort((a, b) => auxRank(a) - auxRank(b))) {
    const o = oldAux.get(key), n = newAux.get(key);
    // A part that exists on only one side is a whole-part insertion or
    // deletion, not something to quietly skip -- skipping it is how a changed
    // header ends up reported as "no differences".
    if (!o && !n) continue;
    if (o) acceptRevisions(o.container, o.doc);
    if (n) acceptRevisions(n.container, n.doc);
    const ob = o ? M.blocksOf(o.container, oldMedia) : [];
    const nb = n ? M.blocksOf(n.container, newMedia) : [];
    if (!n) {
      const label = o.label;
      const words = ob.reduce((sum, b) => sum + require('./diff').wordsOf(M.blockText(b)).length, 0);
      if (words) {
        stats.deletedWords += words;
        stats.changedBlocks += 1;
        skippedParts.push(`${label} was removed (${words} word${words === 1 ? '' : 's'})`);
      }
      continue;
    }
    if (!o) {
      const words = nb.reduce((sum, b) => sum + require('./diff').wordsOf(M.blockText(b)).length, 0);
      if (words) {
        stats.insertedWords += words;
        stats.changedBlocks += 1;
        skippedParts.push(`${n.label} is new (${words} word${words === 1 ? '' : 's'})`);
      }
      continue;
    }
    if (!ob.length && !nb.length) continue;
    const auxEntries = C.plan(ob, nb);
    const auxStats = C.countChanges(auxEntries);
    if (!auxStats.changedBlocks) continue;
    stats.insertedWords += auxStats.insertedWords;
    stats.deletedWords += auxStats.deletedWords;
    stats.changedBlocks += auxStats.changedBlocks;
    auxSections.push({ key, label: n.label, entries: auxEntries, target: n, source: o });
  }

  stats.identical = stats.insertedWords === 0 && stats.deletedWords === 0
    && stats.changedBlocks === 0 && skippedParts.length === 0;
  stats.skippedParts = skippedParts;
  stats.acceptedRevisions = preExisting;

  const oldDates = docDates(oldPkg), newDates = docDates(newPkg);
  const meta = {
    oldName: baseName(oldPath),
    newName: baseName(newPath),
    oldSaved: oldDates.modified,
    newSaved: newDates.modified,
    oldModified: safeMtime(oldPath),
    newModified: safeMtime(newPath),
    generated: new Date(),
    pageSize: pageSizeOf(newPkg),
    stats,
  };

  /* ---- render the PDF body (read-only) before mutating the package -- */

  let html = null;
  if (opts.html !== false) {
    const renderer = new HtmlRenderer(newPkg, oldPkg);
    let body = renderer.blocks(entries);
    for (const section of auxSections) {
      renderer.resetCounters();
      body += `<h2 class="aux">${escapeText(section.label)}</h2>` + renderer.blocks(section.entries);
    }
    html = pdfDocument(body, meta, opts.brandImage || null);
  }

  /* ---- write tracked changes into the new package ------------------ */

  let docx = null;
  if (opts.docx !== false) {
    const em = new Emitter(newPkg, oldPkg, {
      author: opts.author || AUTHOR,
      styleIds: styleIds(newPkg),
      numIds: numIds(newPkg),
    });
    em.run(newPkg.body, entries);
    for (const section of auxSections) {
      em.useDoc(section.target.doc).run(section.target.container, section.entries);
    }
    docx = await newPkg.toBuffer();
  }

  return { stats, meta, docx, html, entries };
}

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeMtime(p) {
  try { return fs.statSync(p).mtime; } catch { return null; }
}

/** Read the section's page size so the PDF matches the document it came from. */
function pageSizeOf(pkg) {
  try {
    const X = require('./ooxml');
    const sect = X.descendants(pkg.body, 'sectPr').pop();
    if (!sect) return 'Letter';
    const sz = X.kid(sect, 'pgSz');
    if (!sz) return 'Letter';
    const w = Number(X.wAttr(sz, 'w') || 0);
    // A4 is 11906 twips wide; US Letter is 12240.
    return Math.abs(w - 11906) < Math.abs(w - 12240) ? 'A4' : 'Letter';
  } catch { return 'Letter'; }
}

/**
 * Decide which of two files is most likely the earlier draft.
 * Used only to pre-highlight a suggestion in the picker; the user always confirms.
 */
/**
 * Same decision as guessOlder, but it also says WHY — so the interface can make
 * an honest claim ("saved 6 days earlier") instead of inventing one for a guess
 * that actually came from the filename.
 */
function explainOlder(fileA, fileB) {
  const index = guessOlder(fileA, fileB);
  const older = index === 0 ? fileA : fileB;
  const newer = index === 0 ? fileB : fileA;
  const t = (f) => {
    const v = f && f.modified ? Date.parse(f.modified) : NaN;
    return Number.isFinite(v) ? v : null;
  };
  const to = t(older), tn = t(newer);
  // Only claim a date difference when the file we picked really is the earlier
  // one; the filename heuristic often disagrees with the timestamps.
  if (to !== null && tn !== null && to < tn) {
    const ms = tn - to;
    return { index, reason: 'modified', hours: Math.round(ms / 3600000), days: Math.round(ms / 86400000) };
  }
  if (nameScore(older) !== nameScore(newer)) return { index, reason: 'filename' };
  return { index, reason: 'order' };
}

function nameScore(file) {
  const n = String((file && file.name) || '').toLowerCase();
  let s = 0;
  const v = /(?:^|[^a-z0-9])v\.?\s?(\d+)/.exec(n);
  if (v) s += Number(v[1]) * 10;
  const d = /(?:^|[^0-9])(20\d{2})[-._]?(\d{2})[-._]?(\d{2})/.exec(n);
  if (d) s += (Number(d[1]) * 10000 + Number(d[2]) * 100 + Number(d[3])) / 1000;
  if (/\b(final|execution|clean|revised|updated|latest)\b/.test(n)) s += 5;
  if (/\b(draft|initial|original|first|orig)\b/.test(n)) s -= 5;
  return s;
}

function guessOlder(fileA, fileB) {
  const score = (name) => {
    const n = String(name || '').toLowerCase();
    let s = 0;
    const v = /(?:^|[^a-z0-9])v\.?\s?(\d+)/.exec(n);
    if (v) s += Number(v[1]) * 10;
    const d = /(?:^|[^0-9])(20\d{2})[-._]?(\d{2})[-._]?(\d{2})/.exec(n);
    if (d) s += (Number(d[1]) * 10000 + Number(d[2]) * 100 + Number(d[3])) / 1000;
    if (/\b(final|execution|clean|revised|updated|latest)\b/.test(n)) s += 5;
    if (/\b(draft|initial|original|first|orig)\b/.test(n)) s -= 5;
    return s;
  };
  const sa = score(fileA && fileA.name), sb = score(fileB && fileB.name);
  if (sa !== sb) return sa < sb ? 0 : 1;

  // `modified` arrives as an ISO string across the IPC boundary, so it must be
  // parsed rather than coerced -- +"2026-08-18T..." is NaN and every comparison
  // with it is false, which silently answered "the second one" every time.
  const when = (f) => {
    const t = f && f.modified ? Date.parse(f.modified) : NaN;
    return Number.isFinite(t) ? t : null;
  };
  const ma = when(fileA), mb = when(fileB);
  if (ma !== null && mb !== null && ma !== mb) return ma < mb ? 0 : 1;

  return String(fileA && fileA.name).localeCompare(String(fileB && fileB.name)) <= 0 ? 0 : 1;
}

module.exports = { buildRedline, guessOlder, explainOlder, UserError };
