'use strict';
/**
 * Writes the change plan into the NEW document's XML as real Word tracked
 * changes (w:ins / w:del), so Word, Pages and Google Docs all show it as a
 * normal redline that a human can accept or reject.
 */

const X = require('./ooxml');
const M = require('./model');
const { local, kid, kids, mk, mkText, drop } = X;

const ATOMIC = M.ATOMIC;

class Emitter {
  constructor(newPkg, oldPkg, opts) {
    this.pkg = newPkg;
    this.oldPkg = oldPkg;
    this.doc = newPkg.document;
    this.author = opts.author || 'Fatty Lumpkin Doc Compare';
    this.date = opts.date || new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    this.styleIds = opts.styleIds || new Set();
    this.numIds = opts.numIds || new Set();
    this.id = 1;
  }

  nid() { return String(this.id++); }

  /** Point the emitter at another part of the same package (footnotes, headers...). */
  useDoc(doc) { this.doc = doc; return this; }

  rev(el) {
    X.setWAttr(el, 'id', this.nid());
    X.setWAttr(el, 'author', this.author);
    X.setWAttr(el, 'date', this.date);
    return el;
  }

  ins() { return this.rev(mk(this.doc, 'ins')); }
  del() { return this.rev(mk(this.doc, 'del')); }

  imported(node) {
    if (!node) return null;
    try {
      return this.doc.importNode(node, true);
    } catch {
      return node.cloneNode(true);
    }
  }

  /* ---------------- run building ---------------- */

  /** Append text to a run, turning tabs and line breaks into their own elements. */
  appendText(run, text, isDel) {
    const tag = isDel ? 'delText' : 't';
    let buf = '';
    const flush = () => { if (buf) { run.appendChild(mkText(this.doc, tag, buf)); buf = ''; } };
    for (const ch of text) {
      if (ch === '\t') { flush(); run.appendChild(mk(this.doc, 'tab')); }
      else if (ch === '\n') { flush(); run.appendChild(mk(this.doc, 'br')); }
      else if (ch === ATOMIC) { /* placeholder handled by caller */ }
      else buf += ch;
    }
    flush();
  }

  /**
   * Turn a segment list into run elements.
   * `mode` is 'equal' | 'ins' | 'del'; `fromOld` marks segments that came from the
   * old document (their hyperlinks and drawings can't be carried over safely).
   */
  runsFrom(segs, mode, fromOld) {
    const out = [];
    for (const seg of segs) {
      if (seg.atomic) {
        if (fromOld || mode === 'del') {
          // The picture itself lives in the old package and its relationship
          // cannot be carried across, but a deletion must never be silent.
          const run = mk(this.doc, 'r');
          if (seg.rPr) run.appendChild(this.imported(seg.rPr));
          this.appendText(run, '[image removed]', mode === 'del');
          out.push({ node: run, link: null });
          continue;
        }
        const clone = this.imported(seg.atomic);
        out.push({ node: clone, link: seg.link });
        continue;
      }
      const stripped = seg.text.split(ATOMIC).join('');
      if (!stripped) continue;
      const run = mk(this.doc, 'r');
      if (seg.rPr) run.appendChild(this.imported(seg.rPr));
      this.appendText(run, stripped, mode === 'del');
      if (!run.firstChild || (run.childNodes.length === 1 && local(run.firstChild) === 'rPr')) continue;
      out.push({ node: run, link: fromOld ? null : seg.link });
    }
    return out;
  }

  /**
   * Append runs to a paragraph, wrapping them in w:ins / w:del and re-creating
   * hyperlink wrappers where the source had them.
   */
  place(p, runs, mode) {
    let i = 0;
    while (i < runs.length) {
      const link = runs[i].link;
      const group = [];
      while (i < runs.length && runs[i].link === link) group.push(runs[i++].node);
      let holder = p;
      let linkEl = null;
      if (link) {
        linkEl = this.imported(link);
        while (linkEl.firstChild) linkEl.removeChild(linkEl.firstChild);
        p.appendChild(linkEl);
        holder = linkEl;
      }
      if (mode === 'equal') {
        for (const n of group) holder.appendChild(n);
      } else {
        const wrap = mode === 'ins' ? this.ins() : this.del();
        for (const n of group) wrap.appendChild(n);
        holder.appendChild(wrap);
      }
    }
  }

  /** Strip everything except w:pPr from a paragraph. */
  clearInline(p) {
    for (const c of kids(p)) if (local(c) !== 'pPr') drop(c);
  }

  /** Mark a paragraph's own paragraph mark as inserted or deleted. */
  markParagraphMark(p, mode) {
    let pPr = kid(p, 'pPr');
    if (!pPr) { pPr = mk(this.doc, 'pPr'); p.insertBefore(pPr, p.firstChild); }
    let rPr = kid(pPr, 'rPr');
    if (!rPr) {
      rPr = mk(this.doc, 'rPr');
      const anchorNames = ['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'numPr',
        'pBdr', 'shd', 'tabs', 'spacing', 'ind', 'jc', 'outlineLvl'];
      let ref = null;
      for (const c of kids(pPr)) if (anchorNames.includes(local(c))) ref = c;
      if (ref && ref.nextSibling) pPr.insertBefore(rPr, ref.nextSibling);
      else pPr.appendChild(rPr);
    }
    const mark = this.rev(mk(this.doc, mode === 'ins' ? 'ins' : 'del'));
    rPr.insertBefore(mark, rPr.firstChild);
  }

  /** Remove style / numbering references the new document doesn't define. */
  sanitizePPr(pPr) {
    if (!pPr) return;
    const st = kid(pPr, 'pStyle');
    if (st && !this.styleIds.has(X.wAttr(st, 'val'))) drop(st);
    const numPr = kid(pPr, 'numPr');
    if (numPr) {
      const numId = kid(numPr, 'numId');
      if (!numId || !this.numIds.has(X.wAttr(numId, 'val'))) drop(numPr);
    }
    for (const name of ['sectPr', 'rPr']) {
      const el = kid(pPr, name);
      if (name === 'sectPr' && el) drop(el);
    }
  }

  /* ---------------- block emitters ---------------- */

  /** Rewrite a matched paragraph so its word-level edits are tracked. */
  emitChanged(entry) {
    const { a, b, tokenOps } = entry;
    const { ta, tb, ops } = tokenOps;
    const offA = prefixOffsets(ta), offB = prefixOffsets(tb);
    const p = b.el;
    this.clearInline(p);
    for (const o of ops) {
      if (o.op === 'equal') {
        this.place(p, this.runsFrom(M.sliceSegments(b.segs, offB[o.bStart], offB[o.bEnd]), 'equal', false), 'equal');
      } else if (o.op === 'insert') {
        this.place(p, this.runsFrom(M.sliceSegments(b.segs, offB[o.bStart], offB[o.bEnd]), 'ins', false), 'ins');
      } else {
        this.place(p, this.runsFrom(M.sliceSegments(a.segs, offA[o.aStart], offA[o.aEnd]), 'del', true), 'del');
      }
    }
  }

  /**
   * Text is unchanged but its formatting is not. Emitted as w:rPrChange, which
   * Word shows in the review pane as "Formatted: ..." and can reject.
   */
  emitFormatChange(entry) {
    const { a, b } = entry;
    const p = b.el;
    this.clearInline(p);
    let pos = 0;
    for (const seg of b.segs) {
      const start = pos; pos += seg.text.length;
      const runs = this.runsFrom([seg], 'equal', false);
      const oldSlice = M.sliceSegments(a.segs, start, pos);
      const oldRPr = oldSlice.length ? oldSlice[0].rPr : null;
      if (M.rPrSignature(oldRPr) !== M.rPrSignature(seg.rPr)) {
        for (const r of runs) {
          let rPr = kid(r.node, 'rPr');
          if (!rPr) { rPr = mk(this.doc, 'rPr'); r.node.insertBefore(rPr, r.node.firstChild); }
          const change = this.rev(mk(this.doc, 'rPrChange'));
          change.appendChild(oldRPr ? this.imported(oldRPr) : mk(this.doc, 'rPr'));
          rPr.appendChild(change);
        }
      }
      this.place(p, runs, 'equal');
    }
  }

  /** Mark a whole new paragraph as inserted. */
  emitInsertedParagraph(b) {
    const p = b.el;
    this.clearInline(p);
    this.place(p, this.runsFrom(b.segs, 'ins', false), 'ins');
    this.markParagraphMark(p, 'ins');
  }

  /** Build a deleted-paragraph element for a paragraph that exists only in the old doc. */
  buildDeletedParagraph(a) {
    const p = mk(this.doc, 'p');
    const oldPPr = kid(a.el, 'pPr');
    if (oldPPr) {
      const pPr = this.imported(oldPPr);
      this.sanitizePPr(pPr);
      p.appendChild(pPr);
    }
    this.place(p, this.runsFrom(a.segs, 'del', true), 'del');
    return p;
  }

  /**
   * A paragraph that was split in two (or more). The words did not change; the
   * paragraph MARK is what was inserted, so that is all that gets tracked.
   */
  emitSplit(entry) {
    const last = entry.bs[entry.bs.length - 1];
    entry.bs.forEach((b, i) => {
      if (b === last) return;
      const gap = (entry.gaps || [])[i];
      if (gap) {
        const src = b.segs.length ? b.segs[b.segs.length - 1] : { rPr: null, link: null };
        this.place(b.el, this.runsFrom([{ text: gap, rPr: src.rPr, link: null, atomic: null }], 'del', false), 'del');
      }
      this.markParagraphMark(b.el, 'ins');
    });
  }

  /**
   * Paragraphs that were run together. The merged paragraph is split back into
   * its original pieces, and the marks that used to end them are struck out --
   * so accepting gives the merged text and rejecting gives the originals back.
   */
  emitMerge(entry) {
    const { b, boundaries } = entry;
    const p = b.el;
    const cuts = [0, ...boundaries.filter((n) => n > 0 && n < b.text.length), b.text.length];
    const pieces = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      pieces.push(M.sliceSegments(b.segs, cuts[i], cuts[i + 1]));
    }
    if (pieces.length < 2) return;
    const pPr = kid(p, 'pPr');
    this.clearInline(p);
    // Whitespace at the join exists only in the merged version, so it is an
    // insertion; without this, rejecting the merge leaves a stray leading space.
    const last = stripLeadingGap(pieces[pieces.length - 1]);
    this.place(p, this.runsFrom(last.gap, 'ins', false), 'ins');
    this.place(p, this.runsFrom(last.rest, 'equal', false), 'equal');
    for (let i = 0; i < pieces.length - 1; i++) {
      const np = mk(this.doc, 'p');
      if (pPr) np.appendChild(pPr.cloneNode(true));
      const piece = i === 0 ? { gap: [], rest: pieces[i] } : stripLeadingGap(pieces[i]);
      this.place(np, this.runsFrom(piece.gap, 'ins', false), 'ins');
      this.place(np, this.runsFrom(piece.rest, 'equal', false), 'equal');
      this.markParagraphMark(np, 'del');
      p.parentNode.insertBefore(np, p);
    }
  }

  /** Whole table present only in one document. */
  buildDeletedTable(a) {
    const tbl = this.imported(a.el);
    for (const tr of kids(tbl, 'tr')) this.markRow(tr, 'del');
    return tbl;
  }

  markRow(tr, mode) {
    let trPr = kid(tr, 'trPr');
    if (!trPr) { trPr = mk(this.doc, 'trPr'); tr.insertBefore(trPr, tr.firstChild); }
    trPr.appendChild(this.rev(mk(this.doc, mode === 'ins' ? 'ins' : 'del')));
    for (const tc of kids(tr, 'tc')) {
      for (const p of kids(tc, 'p')) {
        const block = M.paragraphBlock(p);
        this.clearInline(p);
        const pPr = kid(p, 'pPr');
        if (mode === 'del') this.sanitizePPr(pPr);
        this.place(p, this.runsFrom(block.segs, mode === 'ins' ? 'ins' : 'del', mode === 'del'), mode === 'ins' ? 'ins' : 'del');
        this.markParagraphMark(p, mode);
      }
      for (const t of kids(tc, 'tbl')) {
        for (const inner of kids(t, 'tr')) this.markRow(inner, mode);
      }
    }
  }

  /* ---------------- plan walker ---------------- */

  run(container, entries) {
    let anchor = null;
    const deletedTail = [];
    const allDeleted = [];
    const insertAt = (node) => {
      if (anchor) X.after(anchor, node);
      else {
        const first = kids(container).find((c) => local(c) === 'p' || local(c) === 'tbl');
        if (first) container.insertBefore(node, first);
        else {
          const sect = kid(container, 'sectPr');
          if (sect) container.insertBefore(node, sect); else container.appendChild(node);
        }
      }
      anchor = node;
    };

    for (const e of entries) {
      switch (e.op) {
        case 'equal':
          anchor = e.b.el; break;
        case 'changed':
          this.emitChanged(e); anchor = e.b.el; break;
        case 'insert':
          if (e.b.kind === 'p') this.emitInsertedParagraph(e.b);
          else for (const tr of kids(e.b.el, 'tr')) this.markRow(tr, 'ins');
          anchor = e.b.el; break;
        case 'delete': {
          if (e.a.kind === 'p') {
            const node = this.buildDeletedParagraph(e.a);
            insertAt(node);
            // A deleted paragraph mark merges the paragraph into the NEXT one.
            // At the very end of a container there is no next one, so the mark
            // to strike is the previous paragraph's -- otherwise accepting the
            // change leaves an empty paragraph behind.
            deletedTail.push(node); allDeleted.push(node);
          } else {
            insertAt(this.buildDeletedTable(e.a));
          }
          break;
        }
        case 'split':
          this.emitSplit(e); anchor = e.bs[e.bs.length - 1].el; break;
        case 'merge':
          this.emitMerge(e); anchor = e.b.el; break;
        case 'table':
          this.emitTable(e); anchor = e.b.el; break;
        case 'format':
          this.emitFormatChange(e); anchor = e.b.el; break;
        default: break;
      }
      if (e.op !== 'delete') deletedTail.length = 0;
    }

    // Mark the paragraph marks for every deleted paragraph. A run of deletions
    // that reaches the end of the container marks one paragraph earlier, so
    // acceptance merges backwards into surviving text.
    for (const node of allDeleted) {
      const trailing = deletedTail.includes(node) && !nextParagraph(node);
      this.markParagraphMark(trailing ? previousParagraph(node) || node : node, 'del');
    }
  }

  emitTable(entry) {
    const tbl = entry.b.el;
    let anchor = null;
    for (const r of entry.rows) {
      if (r.op === 'rowInsert') { this.markRow(r.b.el, 'ins'); anchor = r.b.el; continue; }
      if (r.op === 'rowDelete') {
        const node = this.imported(r.a.el);
        this.markRow(node, 'del');
        if (anchor) X.after(anchor, node);
        else {
          const firstRow = kids(tbl, 'tr')[0];
          if (firstRow) tbl.insertBefore(node, firstRow); else tbl.appendChild(node);
        }
        anchor = node;
        continue;
      }
      for (const c of r.cells) {
        if (c.op === 'cell') this.run(c.b.el, c.blocks);
        else if (c.op === 'cellInsert') {
          for (const p of kids(c.b.el, 'p')) {
            const block = M.paragraphBlock(p);
            this.clearInline(p);
            this.place(p, this.runsFrom(block.segs, 'ins', false), 'ins');
            this.markParagraphMark(p, 'ins');
          }
        } else if (c.op === 'cellDelete') {
          // A column removed from the revised table still has to be shown as
          // struck through, not silently dropped.
          const cell = this.imported(c.a.el);
          for (const p of kids(cell, 'p')) {
            const block = M.paragraphBlock(p);
            this.clearInline(p);
            this.sanitizePPr(kid(p, 'pPr'));
            this.place(p, this.runsFrom(block.segs, 'del', true), 'del');
            this.markParagraphMark(p, 'del');
          }
          const rowEl = r.b.el;
          const cells = kids(rowEl, 'tc');
          const at = cells[Math.min(r.cells.indexOf(c), cells.length - 1)];
          if (at) X.after(at, cell); else rowEl.appendChild(cell);
        }
      }
      anchor = r.b.el;
    }
  }
}

/** Split a segment list into its leading whitespace and the rest. */
function stripLeadingGap(segs) {
  const gap = [], rest = [];
  let done = false;
  for (const seg of segs) {
    if (done) { rest.push(seg); continue; }
    const m = /^\s*/.exec(seg.text)[0];
    if (m.length === seg.text.length) { gap.push(seg); continue; }
    if (m.length) gap.push({ ...seg, text: m, atomic: null });
    rest.push({ ...seg, text: seg.text.slice(m.length) });
    done = true;
  }
  return { gap, rest };
}

function nextParagraph(node) {
  for (let n = node.nextSibling; n; n = n.nextSibling) {
    if (n.nodeType === 1 && local(n) === 'p') return n;
  }
  return null;
}

function previousParagraph(node) {
  for (let n = node.previousSibling; n; n = n.previousSibling) {
    if (n.nodeType === 1 && local(n) === 'p') return n;
  }
  return null;
}

/** Character offset of each token boundary. */
function prefixOffsets(tokens) {
  const off = new Array(tokens.length + 1);
  off[0] = 0;
  for (let i = 0; i < tokens.length; i++) off[i + 1] = off[i] + tokens[i].length;
  return off;
}

function emitTrackedDocx(newPkg, oldPkg, entries, opts) {
  const em = new Emitter(newPkg, oldPkg, opts || {});
  em.run(newPkg.body, entries);
  return em;
}

module.exports = { emitTrackedDocx, Emitter };
