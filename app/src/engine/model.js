'use strict';
/**
 * Turns a WordprocessingML body into a flat, comparable block model, and
 * paragraphs into character-addressable "segments" that remember their own
 * run formatting. Everything the diff and the emitters need lives here.
 */

const X = require('./ooxml');
const { local, kids, kid, wAttr, textOf } = X;

/** Placeholder character standing in for an image / shape / equation. */
const ATOMIC = '';

const INLINE_CONTAINERS = new Set(['hyperlink', 'smartTag', 'dir', 'bdo', 'customXml']);
const ATOMIC_RUN_CHILDREN = new Set(['drawing', 'pict', 'object', 'AlternateContent']);

function normKey(s) {
  return s.replace(/\s+/g, ' ').trim();
}

const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Stable signature of a run's formatting, so a bold-only edit is still an edit. */
function rPrSignature(rPr) {
  if (!rPr) return '';
  const parts = [];
  for (const c of kids(rPr)) {
    const name = local(c);
    if (name === 'rPrChange' || name === 'ins' || name === 'del') continue;
    const val = wAttr(c, 'val');
    parts.push(val === null || val === undefined ? name : name + '=' + val);
  }
  parts.sort();
  return parts.join(',');
}

/** Relationship ids of any pictures or objects inside a node. */
function embedIds(node, media) {
  const out = [];
  (function walk(n) {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      if (c.getAttributeNS) {
        for (const a of ['embed', 'link', 'id']) {
          const v = c.getAttributeNS(R_NS, a);
          // A relationship id is meaningless across two packages -- rId4 in one
          // document is a different picture from rId4 in the other -- so it is
          // resolved to a fingerprint of the actual bytes where possible.
          if (v) out.push(a + ':' + ((media && media.get(v)) || v));
        }
      }
      walk(c);
    }
  })(node);
  return out;
}

/* ------------------------------------------------------------------ */
/* Paragraph segments                                                  */
/* ------------------------------------------------------------------ */

/**
 * Flatten a paragraph's inline content into ordered segments.
 * Each segment: { text, rPr, link, atomic }
 *   rPr    - the run's <w:rPr> element (not cloned; clone before reuse)
 *   link   - enclosing <w:hyperlink>, when the text sits inside one
 *   atomic - the original <w:r> element for images/shapes/equations
 */
function segmentsOf(p) {
  const segs = [];
  const push = (text, rPr, link, atomic) => {
    if (!text) return;
    const last = segs[segs.length - 1];
    if (last && !atomic && !last.atomic && last.rPr === rPr && last.link === link) last.text += text;
    else segs.push({ text, rPr: rPr || null, link: link || null, atomic: atomic || null });
  };

  (function walk(node, link) {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      const ln = local(c);
      if (ln === 'pPr') continue;
      if (ln === 'r') {
        const rPr = kid(c, 'rPr');
        for (let rc = c.firstChild; rc; rc = rc.nextSibling) {
          if (rc.nodeType !== 1) continue;
          const rn = local(rc);
          if (rn === 'rPr') continue;
          if (rn === 't' || rn === 'delText') push(rc.textContent || '', rPr, link, null);
          else if (rn === 'tab') push('\t', rPr, link, null);
          else if (rn === 'br' || rn === 'cr') push('\n', rPr, link, null);
          else if (rn === 'noBreakHyphen') push('-', rPr, link, null);
          else if (rn === 'softHyphen') push('', rPr, link, null);
          else if (rn === 'sym') push(' ', rPr, link, null);
          else if (ATOMIC_RUN_CHILDREN.has(rn)) push(ATOMIC, rPr, link, c);
        }
      } else if (INLINE_CONTAINERS.has(ln)) {
        walk(c, ln === 'hyperlink' ? c : link);
      } else if (ln === 'oMath' || ln === 'oMathPara') {
        push(ATOMIC, null, link, c);
      }
    }
  })(p, null);

  return segs;
}

/** Concatenated text of a segment list. */
function segText(segs) {
  let s = '';
  for (const g of segs) s += g.text;
  return s;
}

/** Slice a segment list by character range, preserving formatting. */
function sliceSegments(segs, start, end) {
  const out = [];
  let pos = 0;
  for (const g of segs) {
    const s = pos, e = pos + g.text.length;
    pos = e;
    if (e <= start || s >= end) continue;
    const from = Math.max(0, start - s), to = Math.min(g.text.length, end - s);
    const text = g.text.slice(from, to);
    if (!text) continue;
    out.push({ text, rPr: g.rPr, link: g.link, atomic: g.atomic && from === 0 && to === g.text.length ? g.atomic : null });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Block model                                                         */
/* ------------------------------------------------------------------ */

function paragraphBlock(p, media) {
  const pPr = kid(p, 'pPr');
  const styleEl = pPr && kid(pPr, 'pStyle');
  const numPr = pPr && kid(pPr, 'numPr');
  const segs = segmentsOf(p);
  const text = segText(segs);
  // Text alone cannot see a picture swapped for a different picture, or a
  // clause turned bold. Both are changes a lawyer needs to know about.
  const fmt = segs.map((g) => `${g.text.length}|${rPrSignature(g.rPr)}`
    + (g.atomic ? '|' + embedIds(g.atomic, media).join('+') : '')).join(';');
  return {
    kind: 'p',
    el: p,
    segs,
    fmt,
    text,
    key: normKey(text),
    styleId: styleEl ? wAttr(styleEl, 'val') : null,
    numId: numPr ? (kid(numPr, 'numId') ? wAttr(kid(numPr, 'numId'), 'val') : null) : null,
    ilvl: numPr ? (kid(numPr, 'ilvl') ? Number(wAttr(kid(numPr, 'ilvl'), 'val') || 0) : 0) : null,
  };
}

function tableBlock(tbl, media) {
  const rows = [];
  for (const tr of kids(tbl, 'tr')) {
    const cells = [];
    for (const tc of kids(tr, 'tc')) {
      cells.push({ el: tc, blocks: blocksOf(tc, media) });
    }
    // Cell texts are joined with a separator: without one, "Training" + "$1,200"
    // becomes "Training$1,200" and the word count is silently wrong.
    rows.push({ el: tr, cells, key: normKey(kids(tr, 'tc').map((tc) => textOf(tc)).join(' \u00b7 ')) });
  }
  const text = rows.map((r) => r.key).join('\n');
  return { kind: 'tbl', el: tbl, rows, text, key: 'TBL:' + normKey(text) };
}

/** Ordered block children of a body / table cell. */
function blocksOf(container, media) {
  const out = [];
  for (const c of kids(container)) {
    const ln = local(c);
    if (ln === 'p') out.push(paragraphBlock(c, media));
    else if (ln === 'tbl') out.push(tableBlock(c, media));
  }
  return out;
}

/** Flat text of a block, for similarity scoring. */
function blockText(b) {
  return b.kind === 'p' ? b.text : b.text;
}

module.exports = {
  ATOMIC, segmentsOf, segText, sliceSegments, rPrSignature, embedIds,
  blocksOf, paragraphBlock, tableBlock, blockText, normKey,
};
