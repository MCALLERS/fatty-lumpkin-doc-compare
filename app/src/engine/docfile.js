'use strict';
/**
 * Load a .docx into an editable in-memory package, normalise away any tracked
 * changes it already carries, and expose the pieces the comparer needs.
 */

const fs = require('fs');
const JSZip = require('jszip');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const X = require('./ooxml');
const { local, kids, kid, wAttr, drop, unwrap } = X;

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

class DocPackage {
  constructor(files, name) {
    this.files = files;                 // Map<string, Buffer>
    this.name = name;
    this._dom = new Map();              // path -> Document (parsed lazily)
  }

  has(path) { return this.files.has(path); }

  /** Parsed DOM for an XML part, cached. */
  xml(path) {
    if (this._dom.has(path)) return this._dom.get(path);
    if (!this.files.has(path)) return null;
    const text = this.files.get(path).toString('utf8');
    const doc = new DOMParser({ onError: () => {} }).parseFromString(text, 'text/xml');
    this._dom.set(path, doc);
    return doc;
  }

  get document() { return this.xml('word/document.xml'); }

  get body() {
    const d = this.document;
    if (!d) return null;
    return kid(d.documentElement, 'body');
  }

  /** Serialise every touched DOM back into the file map and zip it up. */
  async toBuffer() {
    for (const [path, doc] of this._dom) {
      const out = DECL + new XMLSerializer().serializeToString(doc).replace(/^<\?xml[^>]*\?>\s*/, '');
      this.files.set(path, Buffer.from(out, 'utf8'));
    }
    const zip = new JSZip();
    // [Content_Types].xml must come first for maximum reader compatibility.
    const names = [...this.files.keys()].sort((a, b) =>
      (a === '[Content_Types].xml' ? -1 : b === '[Content_Types].xml' ? 1 : a < b ? -1 : 1));
    for (const n of names) zip.file(n, this.files.get(n));
    return zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  }
}

async function loadDocx(filePath) {
  let raw;
  try {
    raw = await fs.promises.readFile(filePath);
  } catch (e) {
    throw new UserError(`Can't read “${baseName(filePath)}”. ${e.code === 'ENOENT' ? 'The file no longer exists.' : 'Check that it isn\'t open in another program.'}`);
  }
  if (raw.length === 0) throw new UserError(`“${baseName(filePath)}” is empty.`);
  if (!(raw[0] === 0x50 && raw[1] === 0x4b)) {
    // Old binary .doc files start with D0 CF 11 E0 (OLE compound file).
    if (raw[0] === 0xd0 && raw[1] === 0xcf) {
      throw new UserError(`“${baseName(filePath)}” is an old-format .doc file. Open it in Word and use “Save As → Word Document (.docx)”, then try again.`);
    }
    throw new UserError(`“${baseName(filePath)}” doesn't look like a Word document.`);
  }
  let zip;
  try {
    zip = await JSZip.loadAsync(raw);
  } catch {
    throw new UserError(`“${baseName(filePath)}” is damaged and can't be opened.`);
  }
  const files = new Map();
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    files.set(entry.name, await entry.async('nodebuffer'));
  }
  if (!files.has('word/document.xml')) {
    throw new UserError(`“${baseName(filePath)}” isn't a Word document (no document body found).`);
  }
  const pkg = new DocPackage(files, baseName(filePath));
  if (!pkg.body) throw new UserError(`“${baseName(filePath)}” is damaged and can't be read.`);
  return pkg;
}

function baseName(p) { return String(p).split(/[\\/]/).pop(); }

/** Errors safe to show verbatim to a human. */
class UserError extends Error {
  constructor(msg) { super(msg); this.name = 'UserError'; this.userFacing = true; }
}

/* ------------------------------------------------------------------ *
 * Normalisation: accept any revisions the source document already has
 * ------------------------------------------------------------------ */

/**
 * A `<w:del>` inside `<w:pPr><w:rPr>` means the paragraph MARK was deleted, i.e.
 * this paragraph runs into the next one once the change is accepted. Dropping
 * the marker alone would leave the two paragraphs separate and manufacture a
 * phantom difference, so the merge is performed here.
 */
function mergeDeletedParagraphMarks(root) {
  for (const p of X.descendants(root, 'p')) {
    if (!p.parentNode || p.namespaceURI !== X.NS.w) continue;
    const pPr = kid(p, 'pPr');
    if (!pPr) continue;
    const rPr = kid(pPr, 'rPr');
    if (!rPr) continue;
    const mark = kid(rPr, 'del');
    if (!mark) continue;
    drop(mark);
    let next = p.nextSibling;
    while (next && !(next.nodeType === 1 && local(next) === 'p')) next = next.nextSibling;
    if (!next) continue;
    const movers = kids(p).filter((c) => local(c) !== 'pPr');
    const nextPPr = kid(next, 'pPr');
    const before = nextPPr ? nextPPr.nextSibling : next.firstChild;
    for (const m of movers) next.insertBefore(m, before);
    drop(p);
  }
}

/**
 * Accept all pre-existing tracked changes so we compare final text against
 * final text. Insertions are unwrapped, deletions are discarded, formatting
 * revisions are collapsed. Also strips comments and bookmarks, which are
 * noise for a comparison.
 */
/** Rows whose `w:trPr` carries the given revision marker. */
function revisedRows(root, name) {
  const out = [];
  for (const tr of X.descendants(root, 'tr')) {
    const trPr = kid(tr, 'trPr');
    if (trPr && kid(trPr, name)) out.push(tr);
  }
  return out;
}

/**
 * A `<w:ins>` inside `<w:pPr><w:rPr>` means the paragraph MARK was inserted, so
 * rejecting the change runs this paragraph into the next one.
 */
function mergeInsertedParagraphMarks(root) {
  for (const p of X.descendants(root, 'p')) {
    if (!p.parentNode || p.namespaceURI !== X.NS.w) continue;
    const pPr = kid(p, 'pPr');
    if (!pPr) continue;
    const rPr = kid(pPr, 'rPr');
    if (!rPr) continue;
    const mark = kid(rPr, 'ins');
    if (!mark) continue;
    drop(mark);
    let next = p.nextSibling;
    while (next && !(next.nodeType === 1 && local(next) === 'p')) next = next.nextSibling;
    if (!next) continue;
    const movers = kids(p).filter((c) => local(c) !== 'pPr');
    const nextPPr = kid(next, 'pPr');
    const before = nextPPr ? nextPPr.nextSibling : next.firstChild;
    for (const m of movers) next.insertBefore(m, before);
    drop(p);
  }
}

/**
 * Undo every tracked change, i.e. what Word's "Reject All" does.
 * Used by the test suite to prove the redline is reversible.
 */
function rejectRevisions(root) {
  for (const tr of revisedRows(root, 'ins')) drop(tr);
  mergeInsertedParagraphMarks(root);
  for (const el of [...X.descendants(root, 'ins')]) {
    if (el.namespaceURI !== X.NS.w) continue;
    const parentName = local(el.parentNode || {});
    if (parentName === 'rPr' || parentName === 'pPr') { drop(el); continue; }
    drop(el);
  }
  for (const el of [...X.descendants(root, 'del')]) {
    if (el.namespaceURI !== X.NS.w) continue;
    const parentName = local(el.parentNode || {});
    if (parentName === 'rPr' || parentName === 'pPr') { drop(el); continue; }
    // `w:delText` is left as-is: every reader in this codebase treats it as run
    // text, and rejectRevisions is only used to verify reversibility.
    unwrap(el);
  }
  return root;
}

/** How many tracked changes a document already carried before we compared it. */
function countRevisions(root) {
  let n = 0;
  for (const name of ['ins', 'del', 'moveFrom', 'moveTo', 'rPrChange', 'pPrChange']) {
    for (const el of X.descendants(root, name)) {
      if (el.namespaceURI === X.NS.w) n += 1;
    }
  }
  return n;
}

function acceptRevisions(root, doc) {
  for (const tr of revisedRows(root, 'del')) drop(tr);
  mergeDeletedParagraphMarks(root);
  // Deletions vanish entirely.
  for (const name of ['del', 'moveFrom']) {
    for (const el of [...X.descendants(root, name)]) {
      if (el.namespaceURI !== X.NS.w) continue;
      // <w:del> inside <w:rPr>/<w:pPr> marks a deleted paragraph mark; the
      // paragraph merges into the next one. Handled by the block builder, so
      // here we just remove the marker.
      const parentName = local(el.parentNode || {});
      if (parentName === 'rPr' || parentName === 'pPr') { drop(el); continue; }
      drop(el);
    }
  }
  // Insertions become ordinary content.
  for (const name of ['ins', 'moveTo']) {
    for (const el of [...X.descendants(root, name)]) {
      if (el.namespaceURI !== X.NS.w) continue;
      const parentName = local(el.parentNode || {});
      if (parentName === 'rPr' || parentName === 'pPr') { drop(el); continue; }
      unwrap(el);
    }
  }
  // Revision bookkeeping we never want to carry forward.
  for (const name of ['rPrChange', 'pPrChange', 'tblPrChange', 'trPrChange', 'tcPrChange',
    'sectPrChange', 'tblGridChange', 'customXmlDelRangeStart', 'customXmlDelRangeEnd',
    'customXmlInsRangeStart', 'customXmlInsRangeEnd', 'moveFromRangeStart', 'moveFromRangeEnd',
    'moveToRangeStart', 'moveToRangeEnd', 'commentRangeStart', 'commentRangeEnd',
    'proofErr', 'bookmarkStart', 'bookmarkEnd', 'lastRenderedPageBreak']) {
    for (const el of [...X.descendants(root, name)]) drop(el);
  }
  for (const el of [...X.descendants(root, 'commentReference')]) {
    const run = el.parentNode;
    drop(el);
    if (run && local(run) === 'r' && !X.textOf(run)) drop(run);
  }
  // Content controls: keep the content, lose the wrapper.
  for (let guard = 0; guard < 50; guard++) {
    const sdts = X.descendants(root, 'sdt').filter((s) => s.namespaceURI === X.NS.w);
    if (!sdts.length) break;
    for (const sdt of sdts) {
      const content = kid(sdt, 'sdtContent');
      const parent = sdt.parentNode;
      if (!parent) continue;
      if (content) while (content.firstChild) parent.insertBefore(content.firstChild, sdt);
      parent.removeChild(sdt);
    }
  }
  // Simple fields: keep the cached result text.
  for (const fld of [...X.descendants(root, 'fldSimple')]) unwrap(fld);
  return root;
}

/** Style ids defined in a package's styles.xml. */
function styleIds(pkg) {
  const out = new Set();
  const s = pkg.xml('word/styles.xml');
  if (!s) return out;
  for (const st of X.descendants(s.documentElement, 'style')) {
    const id = wAttr(st, 'styleId');
    if (id) out.add(id);
  }
  return out;
}

/** numId values defined in a package's numbering.xml. */
function numIds(pkg) {
  const out = new Set();
  const n = pkg.xml('word/numbering.xml');
  if (!n) return out;
  for (const num of X.descendants(n.documentElement, 'num')) {
    const id = wAttr(num, 'numId');
    if (id) out.add(id);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Parts beyond the main body
 * ------------------------------------------------------------------ */

const HEADER_FOOTER_RE = /^word\/(header|footer)(\d+)\.xml$/;

/**
 * Every container outside `word/document.xml` that can hold comparable text:
 * footnotes, endnotes, headers and footers.
 *
 * Returns a Map keyed so the same logical part in two documents lines up:
 * `footnote:3`, `endnote:2`, `header:1`, `footer:2`.
 */
function auxContainers(pkg) {
  const out = new Map();

  for (const [part, tag, kind] of [
    ['word/footnotes.xml', 'footnote', 'Footnote'],
    ['word/endnotes.xml', 'endnote', 'Endnote'],
  ]) {
    const doc = pkg.xml(part);
    if (!doc) continue;
    for (const note of X.descendants(doc.documentElement, tag)) {
      const type = wAttr(note, 'type');
      if (type && type !== 'normal') continue;          // separators carry no text
      const id = wAttr(note, 'id');
      if (id === null) continue;
      out.set(`${tag}:${id}`, { doc, container: note, label: `${kind} ${id}`, part });
    }
  }

  for (const part of pkg.files.keys()) {
    const m = HEADER_FOOTER_RE.exec(part);
    if (!m) continue;
    const doc = pkg.xml(part);
    if (!doc) continue;
    const kind = m[1] === 'header' ? 'Header' : 'Footer';
    out.set(`${m[1]}:${m[2]}`, { doc, container: doc.documentElement, label: `${kind} ${m[2]}`, part });
  }

  return out;
}

/**
 * Map every relationship id to a fingerprint of the bytes it points at, so a
 * picture swapped for a different picture is visible even though the id and the
 * surrounding text are unchanged.
 */
function mediaFingerprints(pkg) {
  const out = new Map();
  const crypto = require('crypto');
  for (const path of pkg.files.keys()) {
    if (!/^word\/(_rels\/.*\.rels)$/.test(path)) continue;
    let doc;
    try {
      doc = new DOMParser({ onError: () => {} }).parseFromString(pkg.files.get(path).toString('utf8'), 'text/xml');
    } catch { continue; }
    for (const rel of X.descendants(doc.documentElement, 'Relationship')) {
      const id = rel.getAttribute('Id');
      const target = rel.getAttribute('Target');
      if (!id || !target) continue;
      const clean = target.replace(/^\.\.\//, '').replace(/^\//, '');
      const part = clean.startsWith('word/') ? clean : 'word/' + clean;
      const bytes = pkg.files.get(part);
      if (!bytes) continue;
      out.set(id, crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 12));
    }
  }
  return out;
}

/** The document's own saved/created timestamps, not the file's mtime. */
function docDates(pkg) {
  const doc = pkg.xml('docProps/core.xml');
  const out = { modified: null, created: null };
  if (!doc) return out;
  const read = (name) => {
    for (const el of X.descendants(doc.documentElement, name)) {
      const v = (el.textContent || '').trim();
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return new Date(t);
    }
    return null;
  };
  out.modified = read('modified');
  out.created = read('created');
  return out;
}

module.exports = {
  loadDocx, DocPackage, UserError, acceptRevisions, rejectRevisions, countRevisions,
  mergeDeletedParagraphMarks, mergeInsertedParagraphMarks,
  styleIds, numIds, baseName, auxContainers, docDates, mediaFingerprints,
};
