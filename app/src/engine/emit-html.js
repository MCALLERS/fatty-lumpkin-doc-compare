'use strict';
/**
 * Renders the change plan as a print-ready HTML document. Electron prints this
 * to PDF, so it is the visual form of the redline: blue underline for
 * insertions, red strikethrough for deletions, change bars in the margin.
 */

const X = require('./ooxml');
const M = require('./model');
const { Numbering } = require('./numbering');
const { kid, kids, wAttr, local } = X;

const ATOMIC = M.ATOMIC;

/**
 * HTML-escape. Quotes are escaped too: some of this output lands in attribute
 * position, and the source is an untrusted document from a counterparty.
 */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------------- style table ---------------- */

function styleTable(pkg) {
  const map = new Map();
  const doc = pkg && pkg.xml('word/styles.xml');
  if (!doc) return map;
  for (const st of X.descendants(doc.documentElement, 'style')) {
    const id = wAttr(st, 'styleId');
    if (!id) continue;
    const nameEl = kid(st, 'name');
    const pPr = kid(st, 'pPr');
    const outline = pPr && kid(pPr, 'outlineLvl');
    const basedOn = kid(st, 'basedOn');
    const numPr = pPr && kid(pPr, 'numPr');
    const numIdEl = numPr && kid(numPr, 'numId');
    const ilvlEl = numPr && kid(numPr, 'ilvl');
    map.set(id, {
      id,
      name: (nameEl ? wAttr(nameEl, 'val') : '') || '',
      basedOn: basedOn ? wAttr(basedOn, 'val') : null,
      outline: outline ? Number(wAttr(outline, 'val')) : null,
      type: wAttr(st, 'type') || 'paragraph',
      numId: numIdEl ? wAttr(numIdEl, 'val') : null,
      ilvl: ilvlEl ? Number(wAttr(ilvlEl, 'val') || 0) : 0,
    });
  }
  return map;
}

/** Heading depth 1..6 for a paragraph style, or 0 when it isn't a heading. */
function headingLevel(styles, styleId, seen) {
  if (!styleId) return 0;
  const guard = seen || new Set();
  if (guard.has(styleId)) return 0;
  guard.add(styleId);
  const s = styles.get(styleId);
  if (!s) return 0;
  const name = (s.name || '').toLowerCase();
  if (name === 'title' || styleId === 'Title') return 1;
  if (name === 'subtitle' || styleId === 'Subtitle') return 2;
  let m = /^heading\s*(\d)/.exec(name) || /^h(\d)$/.exec(name);
  if (m) return Math.min(6, Number(m[1]));
  m = /^heading(\d)$/i.exec(styleId);
  if (m) return Math.min(6, Number(m[1]));
  if (s.outline !== null && s.outline >= 0 && s.outline <= 8) return Math.min(6, s.outline + 1);
  return headingLevel(styles, s.basedOn, guard);
}

/* ---------------- inline rendering ---------------- */

function rprFlags(rPr) {
  const f = {};
  if (!rPr) return f;
  const on = (name) => {
    const el = kid(rPr, name);
    if (!el) return false;
    const v = wAttr(el, 'val');
    return v === null || v === undefined || !(v === '0' || v === 'false' || v === 'none');
  };
  f.b = on('b'); f.i = on('i');
  const u = kid(rPr, 'u');
  f.u = !!u && wAttr(u, 'val') !== 'none';
  f.strike = on('strike') || on('dstrike');
  f.caps = on('caps'); f.smallCaps = on('smallCaps');
  const va = kid(rPr, 'vertAlign');
  f.va = va ? wAttr(va, 'val') : null;
  return f;
}

function wrapInline(html, f) {
  if (!html) return '';
  let out = html;
  if (f.b) out = '<b>' + out + '</b>';
  if (f.i) out = '<i>' + out + '</i>';
  if (f.u) out = '<u>' + out + '</u>';
  if (f.strike) out = '<s>' + out + '</s>';
  if (f.va === 'superscript') out = '<sup>' + out + '</sup>';
  else if (f.va === 'subscript') out = '<sub>' + out + '</sub>';
  if (f.caps) out = '<span class="caps">' + out + '</span>';
  else if (f.smallCaps) out = '<span class="smallcaps">' + out + '</span>';
  return out;
}

function segsToHtml(segs) {
  let out = '';
  for (const seg of segs) {
    if (seg.atomic) { out += '<span class="obj" title="image or object">[image]</span>'; continue; }
    const text = seg.text.split(ATOMIC).join('');
    if (!text) continue;
    const parts = esc(text)
      .split('\t').join('<span class="tab"></span>')
      .split('\n').join('<br>');
    out += wrapInline(parts, rprFlags(seg.rPr));
  }
  return out;
}

const PILCROW_INS = '<ins class="pilc" title="paragraph break inserted">\u00b6</ins>';
const PILCROW_DEL = '<del class="pilc" title="paragraph break removed">\u00b6</del>';

function prefixOffsets(tokens) {
  const off = new Array(tokens.length + 1);
  off[0] = 0;
  for (let i = 0; i < tokens.length; i++) off[i + 1] = off[i] + tokens[i].length;
  return off;
}

/* ---------------- block rendering ---------------- */

class HtmlRenderer {
  constructor(newPkg, oldPkg) {
    this.styles = styleTable(newPkg);
    this.oldStyles = styleTable(oldPkg);
    this.numbering = new Numbering(newPkg);
    this.oldNumbering = new Numbering(oldPkg);
  }

  /** Start list numbering afresh for a new part (footnotes, headers...). */
  resetCounters() {
    this.numbering.reset();
    this.oldNumbering.reset();
  }

  paraAttrs(block, isOld) {
    const pPr = kid(block.el, 'pPr');
    const cls = [];
    const style = [];
    // Arabic and Hebrew paragraphs must keep their direction, or the marked-up
    // text reorders on the page and reads as nonsense.
    let dir = ' dir="auto"';
    const bidi = pPr && kid(pPr, 'bidi');
    if (bidi && wAttr(bidi, 'val') !== '0' && wAttr(bidi, 'val') !== 'false') dir = ' dir="rtl"';
    if (pPr) {
      const jc = kid(pPr, 'jc');
      const v = jc && wAttr(jc, 'val');
      if (v === 'center') cls.push('ac');
      else if (v === 'right') cls.push('ar');
      else if (v === 'both' || v === 'distribute') cls.push('aj');
      const ind = kid(pPr, 'ind');
      if (ind) {
        const left = Number(wAttr(ind, 'left') || wAttr(ind, 'start') || 0);
        const hanging = Number(wAttr(ind, 'hanging') || 0);
        const firstLine = Number(wAttr(ind, 'firstLine') || 0);
        if (left) style.push('margin-left:' + (left / 20).toFixed(1) + 'pt');
        if (hanging) style.push('text-indent:-' + (hanging / 20).toFixed(1) + 'pt');
        else if (firstLine) style.push('text-indent:' + (firstLine / 20).toFixed(1) + 'pt');
      }
    }
    const level = headingLevel(isOld ? this.oldStyles : this.styles, block.styleId);
    return { cls, style, level, dir };
  }

  /** numId/ilvl taken from the paragraph, or inherited from its style. */
  listRef(block, isOld) {
    if (block.numId) return { numId: block.numId, ilvl: block.ilvl || 0 };
    const styles = isOld ? this.oldStyles : this.styles;
    const seen = new Set();
    let id = block.styleId;
    while (id && !seen.has(id)) {
      seen.add(id);
      const s = styles.get(id);
      if (!s) return null;
      if (s.numId) return { numId: s.numId, ilvl: s.ilvl || 0 };
      id = s.basedOn;
    }
    return null;
  }

  listLabel(block, isOld) {
    const ref = this.listRef(block, isOld);
    if (!ref) return '';
    const n = isOld ? this.oldNumbering : this.numbering;
    const label = n.label(ref.numId, ref.ilvl);
    if (label === null || label === '') return '';
    // A struck clause keeps the number it had in the original, in brackets, so
    // it can never be mistaken for a live number in the new sequence.
    const shown = isOld ? '[' + label + ']' : label;
    return '<span class="num">' + esc(shown) + '</span><span class="tab"></span>';
  }

  /** Render a paragraph whose content is entirely one change class. */
  wholeParagraph(block, mode, isOld) {
    const { cls, style, level, dir } = this.paraAttrs(block, isOld);
    const tag = level ? 'h' + level : 'p';
    const inner = this.listLabel(block, isOld) + segsToHtml(block.segs);
    const body = mode === 'ins' ? '<ins>' + inner + '</ins>'
      : mode === 'del' ? '<del>' + inner + '</del>' : inner;
    const classes = ['p', ...cls];
    const el = `<${tag} class="${classes.join(' ')}"${dir}${style.length ? ` style="${style.join(';')}"` : ''}>${body || '&nbsp;'}</${tag}>`;
    return mode ? `<div class="bar">${el}</div>` : el;
  }

  changedParagraph(entry) {
    const { a, b, tokenOps } = entry;
    const { ta, tb, ops } = tokenOps;
    const offA = prefixOffsets(ta), offB = prefixOffsets(tb);
    const { cls, style, level, dir } = this.paraAttrs(b, false);
    const tag = level ? 'h' + level : 'p';
    let inner = this.listLabel(b, false);
    for (const o of ops) {
      if (o.op === 'equal') inner += segsToHtml(M.sliceSegments(b.segs, offB[o.bStart], offB[o.bEnd]));
      else if (o.op === 'insert') inner += '<ins>' + segsToHtml(M.sliceSegments(b.segs, offB[o.bStart], offB[o.bEnd])) + '</ins>';
      else inner += '<del>' + segsToHtml(M.sliceSegments(a.segs, offA[o.aStart], offA[o.aEnd])) + '</del>';
    }
    const el = `<${tag} class="${['p', ...cls].join(' ')}"${dir}${style.length ? ` style="${style.join(';')}"` : ''}>${inner || '&nbsp;'}</${tag}>`;
    return `<div class="bar">${el}</div>`;
  }

  /**
   * Advance the old document's list counters for a block that survived, so that
   * a deleted clause is numbered by where it actually sat in the old document
   * rather than by how many deletions came before it.
   */
  syncOld(block) {
    if (!block || block.kind !== 'p') return;
    const ref = this.listRef(block, true);
    if (ref) this.oldNumbering.label(ref.numId, ref.ilvl);
  }

  blocks(entries) {
    let out = '';
    for (const e of entries) {
      switch (e.op) {
        case 'equal':
          this.syncOld(e.a);
          out += e.b.kind === 'p' ? this.wholeParagraph(e.b, null, false) : this.table(e.b, null);
          break;
        case 'changed':
          this.syncOld(e.a);
          out += this.changedParagraph(e); break;
        case 'insert':
          out += e.b.kind === 'p' ? this.wholeParagraph(e.b, 'ins', false) : this.table(e.b, 'ins');
          break;
        case 'delete':
          out += e.a.kind === 'p' ? this.wholeParagraph(e.a, 'del', true) : this.table(e.a, 'del', true);
          break;
        case 'format':
          this.syncOld(e.a);
          out += this.formattedParagraph(e); break;
        case 'split': out += this.splitParagraphs(e); break;
        case 'merge': out += this.mergedParagraph(e); break;
        case 'table':
          this.syncOld(e.a);
          out += this.changedTable(e); break;
        default: break;
      }
    }
    return out;
  }

  /** Same words, different formatting. */
  formattedParagraph(entry) {
    const b = entry.b;
    const { cls, style, level, dir } = this.paraAttrs(b, false);
    const tag = level ? 'h' + level : 'p';
    const inner = this.listLabel(b, false) + segsToHtml(b.segs)
      + '<span class="fmtmark">formatting changed</span>';
    const el = `<${tag} class="${['p', ...cls].join(' ')}"${dir}${style.length ? ` style="${style.join(';')}"` : ''}>${inner}</${tag}>`;
    return `<div class="bar">${el}</div>`;
  }

  /** One old paragraph shown as the several new ones it became. */
  splitParagraphs(entry) {
    this.syncOld(entry.a);
    const last = entry.bs[entry.bs.length - 1];
    let out = '';
    for (const b of entry.bs) {
      const { cls, style, level, dir } = this.paraAttrs(b, false);
      const tag = level ? 'h' + level : 'p';
      const mark = b === last ? '' : PILCROW_INS;
      out += `<${tag} class="${['p', ...cls].join(' ')}"${dir}${style.length ? ` style="${style.join(';')}"` : ''}>`
        + this.listLabel(b, false) + segsToHtml(b.segs) + mark + `</${tag}>`;
    }
    return `<div class="bar">${out}</div>`;
  }

  /** Several old paragraphs shown as the single new one they became. */
  mergedParagraph(entry) {
    for (const a of entry.as) this.syncOld(a);
    const b = entry.b;
    const { cls, style, level, dir } = this.paraAttrs(b, false);
    const tag = level ? 'h' + level : 'p';
    const cuts = [0, ...entry.boundaries.filter((n) => n > 0 && n < b.text.length), b.text.length];
    let inner = this.listLabel(b, false);
    for (let i = 0; i < cuts.length - 1; i++) {
      inner += segsToHtml(M.sliceSegments(b.segs, cuts[i], cuts[i + 1]));
      if (i < cuts.length - 2) inner += PILCROW_DEL;
    }
    const el = `<${tag} class="${['p', ...cls].join(' ')}"${dir}${style.length ? ` style="${style.join(';')}"` : ''}>${inner}</${tag}>`;
    return `<div class="bar">${el}</div>`;
  }

  table(block, mode, isOld) {
    let out = `<table class="t">`;
    let first = true;
    for (const row of block.rows) {
      const tag = first ? 'th' : 'td';
      let cells = '';
      for (const cell of row.cells) {
        cells += `<${tag}${cellAttrs(cell.el)}>` + this.cellBlocks(cell.blocks, mode, isOld) + `</${tag}>`;
      }
      out += first ? `<thead><tr>${cells}</tr></thead><tbody>` : `<tr>${cells}</tr>`;
      first = false;
    }
    out += '</tbody></table>';
    return mode ? `<div class="bar">${out}</div>` : out;
  }

  cellBlocks(blocks, mode, isOld) {
    let out = '';
    for (const b of blocks) {
      out += b.kind === 'p' ? this.wholeParagraph(b, mode, isOld) : this.table(b, mode, isOld);
    }
    return out || '<p class="p">&nbsp;</p>';
  }

  changedTable(entry) {
    let out = '<table class="t">';
    let first = true;
    for (const r of entry.rows) {
      if (r.op === 'rowInsert') {
        out += '<tr class="row-ins">';
        for (const c of r.b.cells) out += `<td${cellAttrs(c.el)}>` + this.cellBlocks(c.blocks, 'ins', false) + '</td>';
        out += '</tr>'; continue;
      }
      if (r.op === 'rowDelete') {
        out += '<tr class="row-del">';
        for (const c of r.a.cells) out += `<td${cellAttrs(c.el)}>` + this.cellBlocks(c.blocks, 'del', true) + '</td>';
        out += '</tr>'; continue;
      }
      // Header rows repeat on every printed page; changed rows get a margin mark
      // so scanning the left edge never misses an edit buried in a cell.
      const tag = first ? 'th' : 'td';
      let cells = '';
      let touched = false;
      for (const c of r.cells) {
        if (c.op === 'cell') {
          const inner = this.blocks(c.blocks);
          if (inner.indexOf('<ins') >= 0 || inner.indexOf('<del') >= 0) touched = true;
          cells += `<${tag}${cellAttrs(c.b.el)}>${inner}</${tag}>`;
        } else if (c.op === 'cellInsert') {
          cells += `<${tag}${cellAttrs(c.b.el, ['cell-ins'])}>` + this.cellBlocks(c.b.blocks, 'ins', false) + `</${tag}>`;
          touched = true;
        } else {
          cells += `<${tag}${cellAttrs(c.a.el, ['cell-del'])}>` + this.cellBlocks(c.a.blocks, 'del', true) + `</${tag}>`;
          touched = true;
        }
      }
      out += first
        ? `<thead><tr>${cells}</tr></thead><tbody>`
        : `<tr${touched ? ' class="row-chg"' : ''}>${cells}</tr>`;
      first = false;
    }
    return out + '</tbody></table>';
  }
}

/**
 * Attributes for a table cell. Classes are returned separately and composed by
 * the caller: emitting `class=` here as well produced two class attributes on a
 * deleted merged cell, and the browser kept only the first -- so the deletion
 * highlight silently disappeared.
 */
function cellAttrs(tc, extraClasses) {
  const classes = [...(extraClasses || [])];
  let out = '';
  const tcPr = tc && kid(tc, 'tcPr');
  if (tcPr) {
    const span = kid(tcPr, 'gridSpan');
    if (span) out += ` colspan="${esc(wAttr(span, 'val') || 1)}"`;
    const w = kid(tcPr, 'tcW');
    if (w && wAttr(w, 'type') === 'dxa') out += ` style="width:${(Number(wAttr(w, 'w') || 0) / 20).toFixed(0)}pt"`;
    const vMerge = kid(tcPr, 'vMerge');
    if (vMerge && wAttr(vMerge, 'val') !== 'restart') classes.push('vmerge');
  }
  if (classes.length) out += ` class="${classes.join(' ')}"`;
  return out;
}

module.exports = { HtmlRenderer, esc };
