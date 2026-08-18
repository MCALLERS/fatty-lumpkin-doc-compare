'use strict';
/**
 * Aligns two block lists into a change plan.
 *
 * A plan entry is one of:
 *   { op:'equal',   a, b }
 *   { op:'changed', a, b, tokenOps }   paragraph pair with in-paragraph word edits
 *   { op:'insert',  b }
 *   { op:'delete',  a }
 *   { op:'table',   a, b, rows }       matched tables, rows is a nested plan
 *   { op:'row',     a, b, cells }      matched rows, cells is a list of nested plans
 */

const D = require('./diff');
const M = require('./model');

/** Minimum bigram similarity for two paragraphs to count as "the same paragraph, edited". */
const PAIR_THRESHOLD = 0.34;
/** Shared leading characters that also imply a pair (numbered clauses, defined terms). */
const PREFIX_HINT = 14;
/** Share of tokens two short paragraphs must have in common to count as a pair. */
const OVERLAP_THRESHOLD = 0.45;
/** Bigram similarity is blind below this many words, so fall back to token overlap. */
const SHORT_WORDS = 60;

function shouldPair(a, b) {
  if (a.kind !== b.kind) return 0;
  if (a.kind === 'tbl') return 1;                    // tables pair with tables positionally
  const sim = D.similarity(a.text, b.text);
  if (sim >= PAIR_THRESHOLD) return sim;

  // Dice over word bigrams cannot see a one-word edit in a five-word paragraph
  // ("Term: three years." -> "Term: five years." scores 0.00). Schedule lines,
  // table cells, defined terms and captions all live here, and treating them as
  // unrelated is what produces struck-and-retyped sentences.
  const wa = D.wordsOf(a.text).length, wb = D.wordsOf(b.text).length;
  if (wa && wb && Math.min(wa, wb) <= SHORT_WORDS) {
    const overlap = D.tokenOverlap(a.text, b.text);
    if (overlap >= OVERLAP_THRESHOLD) return Math.max(sim, overlap);
  }

  const ta = a.key, tb = b.key;
  if (ta.length >= 20 && tb.length >= 20 && ta.slice(0, PREFIX_HINT) === tb.slice(0, PREFIX_HINT)) {
    return Math.max(sim, PAIR_THRESHOLD);
  }
  // A paragraph that is entirely contained in the other is an edit, not a swap.
  if (ta.length > 12 && tb.length > 12 && (tb.indexOf(ta) === 0 || ta.indexOf(tb) === 0)) {
    return Math.max(sim, PAIR_THRESHOLD);
  }
  return 0;
}

/* ------------------------------------------------------------------ *
 * Paragraph splits and merges
 *
 * Splitting one clause into (a) and (b), or running two clauses together, is
 * one of the commonest contract edits. Handled naively it shows up as an
 * identical block of text struck through and immediately re-typed, which is
 * exactly what a redline must never do. Both cases are really a change to a
 * paragraph MARK, so that is how they are recorded.
 * ------------------------------------------------------------------ */

const MIN_JOIN_WORDS = 2;

function joinKey(blocks) {
  return M.normKey(blocks.map((b) => b.text).join(' '));
}

/**
 * Find runs where one block on one side equals several consecutive blocks on the
 * other. Returns a list of { kind:'split'|'merge', ai, aCount, bi, bCount }.
 */
function findSplitsAndMerges(olds, news) {
  const found = [];
  const usedA = new Set(), usedB = new Set();
  const paras = (arr) => arr.every((x) => x.kind === 'p');

  const scan = (kind, ones, manys, usedOne, usedMany) => {
    for (let i = 0; i < ones.length; i++) {
      if (usedOne.has(i)) continue;
      const one = ones[i];
      if (one.kind !== 'p' || D.wordsOf(one.text).length < MIN_JOIN_WORDS) continue;
      for (let j = 0; j < manys.length; j++) {
        if (usedMany.has(j)) continue;
        for (let n = 2; n <= 4 && j + n <= manys.length; n++) {
          const group = manys.slice(j, j + n);
          if (!paras(group)) break;
          if (group.some((_, k) => usedMany.has(j + k))) break;
          if (joinKey(group) !== one.key) continue;
          found.push(kind === 'split'
            ? { kind, ai: i, bi: j, bCount: n }
            : { kind, ai: j, aCount: n, bi: i });
          usedOne.add(i);
          for (let k = 0; k < n; k++) usedMany.add(j + k);
          return true;
        }
      }
    }
    return false;
  };

  // Repeat until nothing new is found; each pass claims at most one group.
  for (let guard = 0; guard < 64; guard++) {
    const before = found.length;
    scan('split', olds, news, usedA, usedB);
    scan('merge', news, olds, usedB, usedA);
    if (found.length === before) break;
  }
  return { found, usedA, usedB };
}

/**
 * Character offsets in `text` immediately after each group's last visible token.
 * Used both to cut a merged paragraph back into its pieces and to find the
 * whitespace that a split threw away.
 */
function joinBoundaries(text, groups) {
  const tokens = D.tokenize(text);
  const wanted = groups.map((g) => D.tokenize(g.text).filter((t) => t.trim()));
  const out = [];
  let gi = 0, wi = 0, chars = 0;
  for (const tok of tokens) {
    chars += tok.length;
    if (!tok.trim()) continue;
    if (gi >= wanted.length) break;
    wi += 1;
    if (wi >= wanted[gi].length) {
      if (gi < groups.length - 1) out.push(chars);
      gi += 1; wi = 0;
      if (gi >= wanted.length) break;
    }
  }
  return out;
}

/** The run of whitespace in `text` starting at each boundary offset. */
function gapsAt(text, boundaries) {
  return boundaries.map((at) => {
    const m = /^\s*/.exec(text.slice(at));
    return m ? m[0] : '';
  });
}

/**
 * Given a run of deleted old blocks and inserted new blocks that sit next to each
 * other, work out which of them are really the same block edited. Pairings must
 * not cross (order is preserved).
 */
function pairUp(olds, news) {
  const cands = [];
  for (let i = 0; i < olds.length; i++) {
    for (let j = 0; j < news.length; j++) {
      const score = shouldPair(olds[i], news[j]);
      if (score > 0) cands.push({ i, j, score });
    }
  }
  cands.sort((x, y) => y.score - x.score || (Math.abs(x.i - x.j) - Math.abs(y.i - y.j)));
  const taken = [];
  for (const c of cands) {
    if (taken.some((t) => t.i === c.i || t.j === c.j)) continue;
    if (taken.some((t) => (t.i - c.i) * (t.j - c.j) < 0)) continue;   // would cross
    taken.push(c);
  }
  taken.sort((x, y) => x.i - y.i);
  return pairLeftovers(olds, news, taken);
}

/**
 * Whatever is left over after scoring: pair the remaining deletions and
 * insertions positionally. Two paragraphs at the same place in the document,
 * one removed and one added, are best shown as a single paragraph whose old
 * words are struck and whose new words are inserted -- and, unlike a separate
 * deleted paragraph followed by a separate inserted one, that round-trips
 * exactly under accept-all and reject-all.
 */
function pairLeftovers(olds, news, taken) {
  const usedI = new Set(taken.map((t) => t.i));
  const usedJ = new Set(taken.map((t) => t.j));
  const freeI = olds.map((_, i) => i).filter((i) => !usedI.has(i) && olds[i].kind === 'p');
  const freeJ = news.map((_, j) => j).filter((j) => !usedJ.has(j) && news[j].kind === 'p');
  const extra = [];
  for (let k = 0; k < Math.min(freeI.length, freeJ.length); k++) {
    const cand = { i: freeI[k], j: freeJ[k], score: 0.001 };
    if (taken.concat(extra).some((t) => (t.i - cand.i) * (t.j - cand.j) < 0)) continue;
    extra.push(cand);
  }
  return taken.concat(extra).sort((x, y) => x.i - y.i);
}

/** Interleave paired and unpaired blocks back into document order. */
function weave(olds, news, pairs) {
  const out = [];
  let i = 0, j = 0;
  for (const p of pairs) {
    while (i < p.i) out.push({ op: 'delete', a: olds[i++] });
    while (j < p.j) out.push({ op: 'insert', b: news[j++] });
    out.push({ op: 'pair', a: olds[i++], b: news[j++] });
  }
  while (i < olds.length) out.push({ op: 'delete', a: olds[i++] });
  while (j < news.length) out.push({ op: 'insert', b: news[j++] });
  return out;
}

/** Word-level opcodes for a paragraph pair, or null when the text is identical. */
function paragraphOps(a, b) {
  if (a.text === b.text) return null;
  return D.diffText(a.text, b.text);
}

function refine(entry) {
  if (entry.op !== 'pair') return entry;
  const { a, b } = entry;
  if (a.kind === 'tbl') return { op: 'table', a, b, rows: planRows(a, b) };
  const tok = paragraphOps(a, b);
  if (!tok) return (a.fmt !== b.fmt) ? { op: 'format', a, b } : { op: 'equal', a, b };
  return { op: 'changed', a, b, tokenOps: tok };
}

/** Align the block lists of two containers. */
function plan(oldBlocks, newBlocks) {
  const ops = D.patience(oldBlocks, newBlocks, (x) => x.kind + ' ' + x.key);
  const out = [];
  let pendingDel = [], pendingIns = [];

  const flush = () => {
    if (!pendingDel.length && !pendingIns.length) return;

    const { found, usedA, usedB } = findSplitsAndMerges(pendingDel, pendingIns);
    if (found.length) {
      const restDel = pendingDel.filter((_, i) => !usedA.has(i));
      const restIns = pendingIns.filter((_, i) => !usedB.has(i));
      const pairs = pairUp(restDel, restIns);
      const woven = weave(restDel, restIns, pairs).map(refine);
      // Splits and merges go back in document order, ahead of the leftovers that
      // sit after them; simple ordering is enough because both groups are
      // contiguous runs inside one pending region.
      for (const f of found) {
        if (f.kind === 'split') {
          const a = pendingDel[f.ai];
          const bs = pendingIns.slice(f.bi, f.bi + f.bCount);
          // The whitespace that used to join the pieces is itself deleted; keep
          // it so rejecting the change restores the original paragraph exactly.
          const cuts = joinBoundaries(a.text, bs);
          out.push({ op: 'split', a, bs, gaps: gapsAt(a.text, cuts) });
        } else {
          const as = pendingDel.slice(f.ai, f.ai + f.aCount);
          const b = pendingIns[f.bi];
          out.push({ op: 'merge', as, b, boundaries: joinBoundaries(b.text, as) });
        }
      }
      for (const e of woven) out.push(e);
      pendingDel = []; pendingIns = [];
      return;
    }

    const pairs = pairUp(pendingDel, pendingIns);
    for (const e of weave(pendingDel, pendingIns, pairs)) out.push(refine(e));
    pendingDel = []; pendingIns = [];
  };

  for (const o of ops) {
    if (o.op === 'delete') { pendingDel.push(...oldBlocks.slice(o.aStart, o.aEnd)); continue; }
    if (o.op === 'insert') { pendingIns.push(...newBlocks.slice(o.bStart, o.bEnd)); continue; }
    flush();
    for (let k = 0; k < o.aEnd - o.aStart; k++) {
      const a = oldBlocks[o.aStart + k], b = newBlocks[o.bStart + k];
      if (a.kind === 'tbl') { out.push({ op: 'table', a, b, rows: planRows(a, b) }); continue; }
      // Same words is not the same paragraph if the bold moved or the picture
      // was swapped.
      out.push(a.fmt !== b.fmt ? { op: 'format', a, b } : { op: 'equal', a, b });
    }
  }
  flush();
  return out;
}

/** Align the rows of two matched tables, then the blocks inside matched cells. */
function planRows(oldTbl, newTbl) {
  const ops = D.patience(oldTbl.rows, newTbl.rows, (r) => r.key);
  const out = [];
  let pd = [], pi = [];
  const flush = () => {
    if (!pd.length && !pi.length) return;
    const cands = [];
    for (let i = 0; i < pd.length; i++) {
      for (let j = 0; j < pi.length; j++) {
        let s = D.similarity(pd[i].key, pi[j].key);
        // Same reason as shouldPair: a two-cell row reading "Term | 12 months"
        // scores 0 against "Term | 24 months" on bigrams, and without this the
        // whole row is struck and retyped.
        if (s < 0.25) {
          const wa = D.wordsOf(pd[i].key).length, wb = D.wordsOf(pi[j].key).length;
          if (wa && wb && Math.min(wa, wb) <= SHORT_WORDS) {
            const overlap = D.tokenOverlap(pd[i].key, pi[j].key);
            if (overlap >= OVERLAP_THRESHOLD) s = overlap;
          }
        }
        if (s >= 0.25 || (!pd[i].key && !pi[j].key)) cands.push({ i, j, score: s || 0.25 });
      }
    }
    cands.sort((x, y) => y.score - x.score);
    const taken = [];
    for (const c of cands) {
      if (taken.some((t) => t.i === c.i || t.j === c.j)) continue;
      if (taken.some((t) => (t.i - c.i) * (t.j - c.j) < 0)) continue;
      taken.push(c);
    }
    taken.sort((x, y) => x.i - y.i);
    let i = 0, j = 0;
    for (const p of taken) {
      while (i < p.i) out.push({ op: 'rowDelete', a: pd[i++] });
      while (j < p.j) out.push({ op: 'rowInsert', b: pi[j++] });
      out.push(matchedRow(pd[i++], pi[j++]));
    }
    while (i < pd.length) out.push({ op: 'rowDelete', a: pd[i++] });
    while (j < pi.length) out.push({ op: 'rowInsert', b: pi[j++] });
    pd = []; pi = [];
  };
  for (const o of ops) {
    if (o.op === 'delete') { pd.push(...oldTbl.rows.slice(o.aStart, o.aEnd)); continue; }
    if (o.op === 'insert') { pi.push(...newTbl.rows.slice(o.bStart, o.bEnd)); continue; }
    flush();
    for (let k = 0; k < o.aEnd - o.aStart; k++) {
      out.push(matchedRow(oldTbl.rows[o.aStart + k], newTbl.rows[o.bStart + k]));
    }
  }
  flush();
  return out;
}

function matchedRow(a, b) {
  const cells = [];
  const n = Math.max(a.cells.length, b.cells.length);
  for (let i = 0; i < n; i++) {
    const ca = a.cells[i], cb = b.cells[i];
    if (ca && cb) cells.push({ op: 'cell', a: ca, b: cb, blocks: plan(ca.blocks, cb.blocks) });
    else if (cb) cells.push({ op: 'cellInsert', b: cb });
    else cells.push({ op: 'cellDelete', a: ca });
  }
  return { op: 'row', a, b, cells };
}

/** Walk a plan, counting inserted and deleted words. */
function countChanges(entries, acc) {
  const stats = acc || { insertedWords: 0, deletedWords: 0, changedBlocks: 0, formatChanges: 0, paragraphBreaks: 0 };
  for (const e of entries) {
    switch (e.op) {
      case 'insert':
        stats.insertedWords += D.wordsOf(M.blockText(e.b)).length; stats.changedBlocks++; break;
      case 'delete':
        stats.deletedWords += D.wordsOf(M.blockText(e.a)).length; stats.changedBlocks++; break;
      case 'changed': {
        const { ta, tb, ops } = e.tokenOps;
        for (const o of ops) {
          if (o.op === 'delete') stats.deletedWords += D.wordsOf(ta.slice(o.aStart, o.aEnd).join('')).length;
          else if (o.op === 'insert') stats.insertedWords += D.wordsOf(tb.slice(o.bStart, o.bEnd).join('')).length;
        }
        stats.changedBlocks++; break;
      }
      case 'split':
      case 'merge':
        stats.changedBlocks++; stats.paragraphBreaks = (stats.paragraphBreaks || 0) + 1; break;
      case 'format':
        stats.changedBlocks++; stats.formatChanges = (stats.formatChanges || 0) + 1; break;
      case 'table':
        for (const r of e.rows) {
          if (r.op === 'rowInsert') { stats.insertedWords += D.wordsOf(r.b.key).length; stats.changedBlocks++; }
          else if (r.op === 'rowDelete') { stats.deletedWords += D.wordsOf(r.a.key).length; stats.changedBlocks++; }
          else for (const c of r.cells) {
            if (c.op === 'cell') countChanges(c.blocks, stats);
            else if (c.op === 'cellInsert') {
              stats.insertedWords += D.wordsOf(c.b.blocks.map(M.blockText).join(' ')).length;
              stats.changedBlocks++;
            } else if (c.op === 'cellDelete') {
              stats.deletedWords += D.wordsOf(c.a.blocks.map(M.blockText).join(' ')).length;
              stats.changedBlocks++;
            }
          }
        }
        break;
      default: break;
    }
  }
  return stats;
}

module.exports = { plan, planRows, countChanges, paragraphOps };
