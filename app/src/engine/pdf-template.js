'use strict';
/** Wraps rendered redline body HTML in the print stylesheet used for the PDF. */

const { esc } = require('./emit-html');

const DATE_FMT = { day: 'numeric', month: 'short', year: 'numeric' };
const TIME_FMT = { hour: 'numeric', minute: '2-digit' };

function fmtDate(d) {
  if (!d) return '';
  try { return new Intl.DateTimeFormat('en-GB', DATE_FMT).format(d); } catch { return ''; }
}
function fmtDateTime(d) {
  if (!d) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', DATE_FMT).format(d) + ', ' +
           new Intl.DateTimeFormat('en-GB', TIME_FMT).format(d);
  } catch { return ''; }
}
function plural(n, one, many) { return n === 1 ? `1 ${one}` : `${n.toLocaleString('en-US')} ${many}`; }

const CSS = `
:root{
  --ink:#16150F;
  --ink-soft:#5C574A;
  --rule:#DBD5C6;
  --rule-soft:#EDE8DB;
  --paper:#FFFFFF;
  --ins:#12489E;
  --del:#A81F13;
  --bar:#7A8496;
  --navy:#22406F;
  --gold:#B8862B;
}
@page{ margin:16mm 15mm 16mm 15mm; }
*{ box-sizing:border-box; }
html,body{ margin:0; padding:0; background:var(--paper); }
body{
  font-family:"Palatino Linotype","Book Antiqua",Palatino,Georgia,"Times New Roman",serif;
  font-size:10.5pt; line-height:1.55; color:var(--ink);
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
}
.sheet{ padding-left:18px; }

/* ---------- cover band ---------- */
header.cover{ margin:0 0 26px -18px; padding:0 0 16px 18px; border-bottom:1.5px solid var(--rule); break-inside:avoid; }
.brandrow{ display:flex; align-items:center; gap:12px; margin-bottom:14px; }
.pony{ width:44px; height:44px; border-radius:12px; object-fit:cover; background:#F4EFE2; flex:0 0 auto; }
.wordmark{ font-family:"Segoe UI",-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;
  font-size:12.5pt; font-weight:700; letter-spacing:-0.01em; color:var(--navy); line-height:1.15; }
.wordmark span{ color:var(--gold); }
.tagline{ font-family:"Segoe UI",-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;
  font-size:7.6pt; font-weight:600; letter-spacing:.13em; text-transform:uppercase; color:var(--ink-soft); margin-top:3px; }
.facts{ display:grid; grid-template-columns:auto 1fr; gap:5px 14px; font-family:"Segoe UI",-apple-system,Helvetica,Arial,sans-serif; font-size:8.6pt; }
.facts dt{ color:var(--ink-soft); font-weight:600; letter-spacing:.04em; text-transform:uppercase; font-size:7.4pt; padding-top:1.5px; white-space:nowrap; }
.facts dd{ margin:0; color:var(--ink); font-weight:600; word-break:break-word; }
.facts dd em{ font-style:normal; font-weight:400; color:var(--ink-soft); }
.tally{ display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:14px;
  font-family:"Segoe UI",-apple-system,Helvetica,Arial,sans-serif; font-size:8.4pt; }
.chip{ display:inline-flex; align-items:center; gap:6px; padding:3px 9px; border-radius:999px;
  border:1px solid var(--rule); background:#FBF9F4; font-weight:600; color:var(--ink-soft); }
.chip b{ color:var(--ink); font-weight:700; }
.chip .dot{ width:7px; height:7px; border-radius:50%; }
.chip.ins .dot{ background:var(--ins); } .chip.del .dot{ background:var(--del); }
.chip.key{ border-style:dashed; }
.chip.key ins,.chip.key del{ font-family:inherit; }

/* ---------- document body ---------- */
.p{ margin:0 0 7pt; orphans:2; widows:2; }
h1.p,h2.p,h3.p,h4.p,h5.p,h6.p{ font-weight:700; break-after:avoid; page-break-after:avoid; margin-top:14pt; }
h1.p{ font-size:15pt; letter-spacing:-0.005em; } h2.p{ font-size:12.5pt; } h3.p{ font-size:11.5pt; }
h1.p.ac{ font-size:16pt; margin-top:0; }
h4.p,h5.p,h6.p{ font-size:10.5pt; }
.ac{ text-align:center; } .ar{ text-align:right; } .aj{ text-align:justify; }
.num{ font-variant-numeric:tabular-nums; }
.tab{ display:inline-block; width:24pt; }
.caps{ text-transform:uppercase; } .smallcaps{ font-variant:small-caps; }
.obj{ font-size:8pt; color:var(--ink-soft); border:1px dashed var(--rule); padding:0 4px; border-radius:3px; }

ins{ color:var(--ins); text-decoration:underline; text-underline-offset:2px; text-decoration-thickness:from-font; }
del{ color:var(--del); text-decoration:line-through; text-decoration-thickness:from-font; }
ins .num,del .num{ color:inherit; }

.bar{ border-left:2px solid var(--bar); padding-left:14px; margin-left:-16px; margin-bottom:7pt; }
.bar > .p:last-child,.bar > h1:last-child,.bar > h2:last-child,.bar > h3:last-child{ margin-bottom:0; }
.pilc{ text-decoration:none; opacity:.85; padding-left:2px; }
.fmtmark{
  margin-left:6px; padding:0 5px; border-radius:3px; vertical-align:1px;
  font-family:"Segoe UI",-apple-system,Helvetica,Arial,sans-serif; font-size:7pt;
  font-weight:700; letter-spacing:.06em; text-transform:uppercase;
  color:var(--ink-soft); background:#F1EEE5; border:1px solid var(--rule);
}
del.pilc{ text-decoration:line-through; }

table.t{ border-collapse:collapse; width:100%; margin:0 0 10pt; font-size:9.6pt; break-inside:auto; }
table.t thead{ display:table-header-group; }
table.t tr{ break-inside:avoid; }
table.t td,table.t th{ border:0.75px solid var(--rule); padding:5pt 7pt; vertical-align:top; text-align:left; }
table.t th{ background:#F7F4ED; font-weight:700; }
/* A change inside a cell gets the same margin bar as any other change, so
   scanning the left edge of the page never misses one. */
tr.row-chg td:first-child{ position:relative; }
tr.row-chg td:first-child::before{
  content:""; position:absolute; left:-16px; top:0; bottom:0; width:2px; background:var(--bar);
}
/* Inside a cell the wrapper must not draw its own rule -- it bleeds into the
   neighbouring column. */
table.t .bar{ border-left:0; margin-left:0; padding-left:0; margin-bottom:0; }
table.t td > .p:last-child,table.t td > .bar:last-child > .p:last-child{ margin-bottom:0; }
tr.row-ins td{ background:#F2F6FD; } tr.row-del td{ background:#FDF3F2; }
td.cell-del,th.cell-del{ background:#FDF3F2; }
td.cell-ins,th.cell-ins{ background:#F2F6FD; }
.vmerge{ border-top:0; }

h2.aux{
  margin:26pt 0 10pt; padding-top:9pt; border-top:1px solid var(--rule);
  font-family:"Segoe UI",-apple-system,Helvetica,Arial,sans-serif;
  font-size:9pt; font-weight:700; letter-spacing:.11em; text-transform:uppercase; color:var(--ink-soft);
  break-after:avoid;
}
.caveat{
  margin:14px 0 0; padding:9px 12px; font-family:"Segoe UI",-apple-system,Helvetica,Arial,sans-serif;
  font-size:8.4pt; color:var(--ink-soft); background:#FBF7EF;
  border:1px solid var(--rule); border-left:3px solid var(--gold); border-radius:6px;
}
.empty{ margin:60px 0; padding:26px 24px; border:1px dashed var(--rule); border-radius:10px; background:#FBF9F4;
  font-family:"Segoe UI",-apple-system,Helvetica,Arial,sans-serif; text-align:center; }
.empty h2{ margin:0 0 6px; font-size:12pt; color:var(--navy); }
.empty p{ margin:0; font-size:9.5pt; color:var(--ink-soft); }
`;

function pdfDocument(bodyHtml, meta, brandImage) {
  const s = meta.stats;
  const title = `Redline — ${meta.newName}`;
  const pony = brandImage
    ? `<img class="pony" src="${brandImage}" alt="">`
    : '<div class="pony"></div>';

  const tally = s.identical
    ? '<span class="chip"><b>No changes found</b></span>'
    : `<span class="chip ins"><span class="dot"></span><b>${plural(s.insertedWords, 'word added', 'words added')}</b></span>
       <span class="chip del"><span class="dot"></span><b>${plural(s.deletedWords, 'word deleted', 'words deleted')}</b></span>
       <span class="chip"><b>${plural(s.changedBlocks, 'passage changed', 'passages changed')}</b></span>
       ${s.paragraphBreaks ? `<span class="chip"><b>${plural(s.paragraphBreaks, 'paragraph split or merged', 'paragraphs split or merged')}</b></span>` : ''}
       ${s.formatChanges ? `<span class="chip"><b>${plural(s.formatChanges, 'formatting change', 'formatting changes')}</b></span>` : ''}
       <span class="chip key"><ins>inserted</ins> &nbsp;<del>deleted</del></span>`;

  const caveats = [];
  if (s.skippedParts && s.skippedParts.length) {
    caveats.push(`<b>Not compared:</b> ${esc(s.skippedParts.join('; '))}.`);
  }
  if (s.acceptedRevisions) {
    caveats.push(`<b>Note:</b> ${plural(s.acceptedRevisions, 'tracked change was', 'tracked changes were')} already present in the source documents and treated as accepted before comparing.`);
  }
  const skipped = caveats.length ? `<div class="caveat">${caveats.join('<br>')}</div>` : '';

  const body = s.identical
    ? `<div class="empty"><h2>No differences found</h2>
        <p>Every word, table, footnote, header and footer that could be compared matches.
        There is nothing to mark up.</p></div>`
    : bodyHtml;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>${CSS}</style></head>
<body><div class="sheet">
<header class="cover">
  <div class="brandrow">
    ${pony}
    <div>
      <div class="wordmark">Fatty Lumpkin <span>Doc Compare</span></div>
      <div class="tagline">Redline</div>
    </div>
  </div>
  <dl class="facts">
    <dt>Original</dt><dd>${esc(meta.oldName)}${meta.oldModified ? ` <em>&middot; saved ${esc(fmtDate(meta.oldModified))}</em>` : ''}</dd>
    <dt>Revised</dt><dd>${esc(meta.newName)}${meta.newModified ? ` <em>&middot; saved ${esc(fmtDate(meta.newModified))}</em>` : ''}</dd>
    <dt>Compared</dt><dd><em>${esc(fmtDateTime(meta.generated))}</em></dd>
  </dl>
  <div class="tally">${tally}</div>
  ${skipped}
</header>
${body}
</div></body></html>`;
}

module.exports = { pdfDocument, CSS };
