'use strict';
/** Resolves Word's automatic list numbering so the PDF shows real clause numbers. */

const X = require('./ooxml');
const { kid, kids, wAttr, descendants } = X;

const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
  [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];

function roman(n) {
  let out = '';
  for (const [v, s] of ROMAN) while (n >= v) { out += s; n -= v; }
  return out;
}

function letters(n) {
  let out = '';
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(97 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

function format(n, fmt) {
  switch (fmt) {
    case 'decimalZero': return n < 10 ? '0' + n : String(n);
    case 'lowerLetter': return letters(n);
    case 'upperLetter': return letters(n).toUpperCase();
    case 'lowerRoman': return roman(n);
    case 'upperRoman': return roman(n).toUpperCase();
    case 'none': return '';
    case 'bullet': return '';
    default: return String(n);
  }
}

const BULLETS = ['•', '◦', '▪', '•', '◦', '▪', '•', '◦', '▪'];

class Numbering {
  constructor(pkg) {
    this.abstract = new Map();   // abstractNumId -> level index -> {fmt,text,start}
    this.numToAbstract = new Map();
    this.overrides = new Map();  // numId -> level -> start
    this.counters = new Map();   // abstractNumId -> array of counters

    const doc = pkg && pkg.xml('word/numbering.xml');
    if (!doc) return;
    for (const an of descendants(doc.documentElement, 'abstractNum')) {
      const id = wAttr(an, 'abstractNumId');
      const levels = {};
      for (const lvl of kids(an, 'lvl')) {
        const i = Number(wAttr(lvl, 'ilvl') || 0);
        const fmtEl = kid(lvl, 'numFmt'), textEl = kid(lvl, 'lvlText'), startEl = kid(lvl, 'start');
        levels[i] = {
          fmt: fmtEl ? wAttr(fmtEl, 'val') : 'decimal',
          text: textEl ? (wAttr(textEl, 'val') || '') : '',
          start: startEl ? Number(wAttr(startEl, 'val') || 1) : 1,
        };
      }
      this.abstract.set(id, levels);
    }
    for (const num of descendants(doc.documentElement, 'num')) {
      const id = wAttr(num, 'numId');
      const a = kid(num, 'abstractNumId');
      if (id && a) this.numToAbstract.set(id, wAttr(a, 'val'));
      for (const ov of kids(num, 'lvlOverride')) {
        const i = Number(wAttr(ov, 'ilvl') || 0);
        const st = kid(ov, 'startOverride');
        if (st) {
          if (!this.overrides.has(id)) this.overrides.set(id, {});
          this.overrides.get(id)[i] = Number(wAttr(st, 'val') || 1);
        }
      }
    }
  }

  reset() { this.counters = new Map(); }

  /** Label text for the next item of list `numId` at indent level `ilvl`. */
  label(numId, ilvl) {
    const absId = this.numToAbstract.get(String(numId));
    if (absId === undefined) return null;
    const levels = this.abstract.get(absId);
    if (!levels) return null;
    const lvl = levels[ilvl] || levels[0];
    if (!lvl) return null;
    if (lvl.fmt === 'bullet') return BULLETS[Math.min(ilvl, BULLETS.length - 1)];

    if (!this.counters.has(absId)) this.counters.set(absId, []);
    const c = this.counters.get(absId);
    const ov = this.overrides.get(String(numId));
    for (let i = 0; i <= ilvl; i++) {
      if (c[i] === undefined) c[i] = ((ov && ov[i] !== undefined) ? ov[i] : (levels[i] ? levels[i].start : 1)) - 1;
    }
    c[ilvl] += 1;
    for (let i = ilvl + 1; i < c.length; i++) c[i] = undefined;

    return (lvl.text || '').replace(/%(\d)/g, (_, d) => {
      const idx = Number(d) - 1;
      const lv = levels[idx] || { fmt: 'decimal' };
      const n = c[idx] === undefined ? (lv.start || 1) : c[idx];
      return format(n, lv.fmt);
    });
  }
}

module.exports = { Numbering };
