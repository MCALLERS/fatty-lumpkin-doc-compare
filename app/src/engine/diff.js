'use strict';
/**
 * Sequence diffing.
 *
 *  - `myers`    : classic O(ND) diff, used for short sequences (tokens in a paragraph).
 *  - `patience` : anchor-based diff, used for whole-document block alignment where
 *                 Myers can blow up and where "match the unique lines first" gives
 *                 far more human-looking results.
 *  - `tokenize` : word / whitespace / punctuation splitting. Never splits inside a word.
 */

const MAX_D = 3000;

// Chinese, Japanese and Korean text has no spaces, so a run of ideographs must
// tokenise one character at a time or a whole sentence becomes a single token
// and the "word-level" promise silently degrades to sentence level.
const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const TOKEN_RE = new RegExp(
  `\\s+|[${CJK}]|[0-9]+(?:[.,][0-9]+)*|[\\p{L}\\p{M}]+(?:['\u2019][\\p{L}\\p{M}]+)*|[^\\s\\p{L}\\p{M}0-9]+`,
  'gu',
);
// A "word" for counting purposes matches the tokenizer: 22,000 and forty-five
// and non-exclusive are each one word, not two.
const WORD_RE = new RegExp(
  `[${CJK}]|[\\p{L}\\p{M}0-9]+(?:[.,'\u2019\u2010-\u2015-][\\p{L}\\p{M}0-9]+)*`,
  'gu',
);

/** Split into word, whitespace and punctuation tokens. Never below word level. */
function tokenize(s) {
  return s.match(TOKEN_RE) || [];
}

/** Words only, lower-cased -- used for similarity scoring. */
function wordsOf(s) {
  return s.toLowerCase().match(WORD_RE) || [];
}

function opcode(op, aStart, aEnd, bStart, bEnd) {
  return { op, aStart, aEnd, bStart, bEnd };
}

/** Merge adjacent opcodes of the same kind and drop empties. */
function normalize(ops) {
  const out = [];
  for (const o of ops) {
    if (o.aStart === o.aEnd && o.bStart === o.bEnd) continue;
    const prev = out[out.length - 1];
    if (prev && prev.op === o.op && prev.aEnd === o.aStart && prev.bEnd === o.bStart) {
      prev.aEnd = o.aEnd; prev.bEnd = o.bEnd;
    } else out.push({ ...o });
  }
  return out;
}

/**
 * Myers greedy diff with a bounded edit budget.
 * Returns opcodes, or null when the sequences are too different to afford.
 */
function myers(a, b, key) {
  const k = key || ((x) => x);
  const N = a.length, M = b.length;
  if (!N && !M) return [];
  if (!N) return [opcode('insert', 0, 0, 0, M)];
  if (!M) return [opcode('delete', 0, N, 0, 0)];

  const ka = a.map(k), kb = b.map(k);
  const max = N + M;
  const budget = Math.min(max, MAX_D);
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace = [];

  for (let d = 0; d <= budget; d++) {
    trace.push(v.slice());
    for (let kk = -d; kk <= d; kk += 2) {
      let x;
      if (kk === -d || (kk !== d && v[kk - 1 + offset] < v[kk + 1 + offset])) x = v[kk + 1 + offset];
      else x = v[kk - 1 + offset] + 1;
      let y = x - kk;
      while (x < N && y < M && ka[x] === kb[y]) { x++; y++; }
      v[kk + offset] = x;
      if (x >= N && y >= M) return backtrack(trace, d, N, M, offset);
    }
  }
  return null; // over budget
}

function backtrack(trace, d, N, M, offset) {
  const ops = [];
  let x = N, y = M;
  for (let step = d; step > 0; step--) {
    const v = trace[step];
    const k = x - y;
    let prevK;
    if (k === -step || (k !== step && v[k - 1 + offset] < v[k + 1 + offset])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = v[prevK + offset];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; ops.push(opcode('equal', x, x + 1, y, y + 1)); }
    if (prevX < x) ops.push(opcode('delete', x - 1, x, y, y));
    else ops.push(opcode('insert', x, x, y - 1, y));
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) { x--; y--; ops.push(opcode('equal', x, x + 1, y, y + 1)); }
  if (x > 0) ops.push(opcode('delete', 0, x, 0, 0));
  if (y > 0) ops.push(opcode('insert', 0, 0, 0, y));
  return normalize(ops.reverse());
}

/** Longest increasing subsequence over an array of numbers; returns indices. */
function lis(seq) {
  const piles = [], back = new Array(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0, hi = piles.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[piles[mid]] < seq[i]) lo = mid + 1; else hi = mid;
    }
    if (lo > 0) back[i] = piles[lo - 1];
    piles[lo] = i;
  }
  const out = [];
  let cur = piles.length ? piles[piles.length - 1] : -1;
  while (cur !== -1) { out.push(cur); cur = back[cur]; }
  return out.reverse();
}

function uniqueAnchors(a, b, a0, a1, b0, b1, key) {
  const ca = new Map(), cb = new Map();
  for (let i = a0; i < a1; i++) { const k = key(a[i]); const e = ca.get(k); ca.set(k, e ? { n: e.n + 1, i: e.i } : { n: 1, i }); }
  for (let i = b0; i < b1; i++) { const k = key(b[i]); const e = cb.get(k); cb.set(k, e ? { n: e.n + 1, i: e.i } : { n: 1, i }); }
  const pairs = [];
  for (const [k, ea] of ca) {
    if (ea.n !== 1) continue;
    const eb = cb.get(k);
    if (!eb || eb.n !== 1) continue;
    if (!k) continue;                       // blank paragraphs are never anchors
    pairs.push([ea.i, eb.i]);
  }
  pairs.sort((x, y) => x[0] - y[0]);
  const keep = lis(pairs.map((p) => p[1]));
  return keep.map((i) => pairs[i]);
}

/**
 * Patience diff. Anchors on elements whose key is unique in both sequences,
 * recurses between the anchors, and uses Myers on the small leftovers.
 */
function patience(a, b, key) {
  const k = key || ((x) => x);
  const ops = [];
  (function rec(a0, a1, b0, b1) {
    while (a0 < a1 && b0 < b1 && k(a[a0]) === k(b[b0])) { ops.push(opcode('equal', a0, a0 + 1, b0, b0 + 1)); a0++; b0++; }
    const tail = [];
    while (a1 > a0 && b1 > b0 && k(a[a1 - 1]) === k(b[b1 - 1])) { a1--; b1--; tail.push(opcode('equal', a1, a1 + 1, b1, b1 + 1)); }

    if (a0 === a1 || b0 === b1) {
      if (a0 < a1) ops.push(opcode('delete', a0, a1, b0, b0));
      if (b0 < b1) ops.push(opcode('insert', a1, a1, b0, b1));
    } else {
      const anchors = uniqueAnchors(a, b, a0, a1, b0, b1, k);
      if (!anchors.length) {
        const sub = myers(a.slice(a0, a1), b.slice(b0, b1), k);
        if (sub) {
          for (const o of sub) ops.push(opcode(o.op, o.aStart + a0, o.aEnd + a0, o.bStart + b0, o.bEnd + b0));
        } else {
          ops.push(opcode('delete', a0, a1, b0, b0));
          ops.push(opcode('insert', a1, a1, b0, b1));
        }
      } else {
        let pa = a0, pb = b0;
        for (const anchor of anchors) {
          rec(pa, anchor[0], pb, anchor[1]);
          ops.push(opcode('equal', anchor[0], anchor[0] + 1, anchor[1], anchor[1] + 1));
          pa = anchor[0] + 1; pb = anchor[1] + 1;
        }
        rec(pa, a1, pb, b1);
      }
    }
    for (let i = tail.length - 1; i >= 0; i--) ops.push(tail[i]);
  })(0, a.length, 0, b.length);

  ops.sort((x, y) => (x.aStart - y.aStart) || (x.bStart - y.bStart));
  return normalize(ops);
}

/** Dice coefficient over word bigrams -- 0..1 similarity between two strings. */
function similarity(s1, s2) {
  const w1 = wordsOf(s1), w2 = wordsOf(s2);
  if (!w1.length && !w2.length) return 1;
  if (!w1.length || !w2.length) return 0;
  const grams = (w) => {
    const m = new Map();
    if (w.length === 1) { m.set(w[0], 1); return m; }
    for (let i = 0; i < w.length - 1; i++) {
      const g = w[i] + ' ' + w[i + 1];
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const g1 = grams(w1), g2 = grams(w2);
  let inter = 0, n1 = 0, n2 = 0;
  for (const v of g1.values()) n1 += v;
  for (const entry of g2) { n2 += entry[1]; if (g1.has(entry[0])) inter += Math.min(entry[1], g1.get(entry[0])); }
  return (2 * inter) / (n1 + n2);
}

/**
 * Collapse each contiguous run of edits into at most one delete followed by one
 * insert, absorbing whitespace-only `equal` runs that sit between two edits.
 *
 * Without this, Myers is free to pick an equal-cost alignment that renders
 * "New York" -> "Delaware" as [-New-]{+Delaware+}[-York-], which reads as
 * nonsense. Afterwards it always reads as one struck span then one added span.
 */
function groupChanges(ops, a, b) {
  const isBlank = (op) => op.op === 'equal'
    && a.slice(op.aStart, op.aEnd).join('').trim() === '';

  const out = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op === 'equal' && !isBlank(ops[i])) { out.push(ops[i++]); continue; }

    // Gather a maximal region of edits, hopping over whitespace-only equals that
    // have an edit on both sides.
    let j = i, lastEdit = -1;
    while (j < ops.length) {
      if (ops[j].op !== 'equal') { lastEdit = j; j++; continue; }
      if (!isBlank(ops[j])) break;
      let k = j + 1;
      while (k < ops.length && ops[k].op === 'equal' && isBlank(ops[k])) k++;
      if (k < ops.length && ops[k].op !== 'equal' && lastEdit >= 0) { j = k; continue; }
      break;
    }
    if (lastEdit < 0) { out.push(ops[i++]); continue; }

    const region = ops.slice(i, lastEdit + 1);
    const aStart = region[0].aStart, aEnd = region[region.length - 1].aEnd;
    const bStart = region[0].bStart, bEnd = region[region.length - 1].bEnd;
    if (aEnd > aStart) out.push(opcode('delete', aStart, aEnd, bStart, bStart));
    if (bEnd > bStart) out.push(opcode('insert', aEnd, aEnd, bStart, bEnd));
    i = lastEdit + 1;
  }
  return normalize(out);
}

/** Word-level opcodes for two strings, already tidied for human reading. */
function diffText(oldText, newText) {
  const ta = tokenize(oldText), tb = tokenize(newText);
  let ops = myers(ta, tb);
  if (!ops) ops = patience(ta, tb);
  return { ta, tb, ops: groupChanges(ops, ta, tb) };
}

/** Fraction of the longer token stream that both strings share, ignoring blanks. */
function tokenOverlap(s1, s2) {
  const a = tokenize(s1).filter((t) => t.trim());
  const b = tokenize(s2).filter((t) => t.trim());
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const ops = myers(a, b) || patience(a, b);
  let shared = 0;
  for (const o of ops) if (o.op === 'equal') shared += o.aEnd - o.aStart;
  return shared / Math.max(a.length, b.length);
}

module.exports = {
  tokenize, wordsOf, myers, patience, similarity, normalize, opcode,
  groupChanges, diffText, tokenOverlap,
};
