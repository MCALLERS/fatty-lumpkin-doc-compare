import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire('/home/claude/fatty-lumpkin/app/package.json');
const { buildRedline } = require('/home/claude/fatty-lumpkin/app/src/engine');
const JSZip = require('jszip');

async function revs(buf) {
  const zip = await JSZip.loadAsync(buf);
  const out = { ins: [], del: [], marks: { ins: 0, del: 0 } };
  for (const name of Object.keys(zip.files)) {
    if (!/^word\/(document|footnotes|endnotes|header\d+|footer\d+)\.xml$/.test(name)) continue;
    const xml = await zip.file(name).async('string');
    for (const m of xml.matchAll(/<w:ins\b[^>]*>([\s\S]*?)<\/w:ins>/g)) {
      const t = [...m[1].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((x) => x[1]).join('');
      if (t) out.ins.push(t);
    }
    for (const m of xml.matchAll(/<w:del\b[^>]*>([\s\S]*?)<\/w:del>/g)) {
      const t = [...m[1].matchAll(/<w:delText[^>]*>([\s\S]*?)<\/w:delText>/g)].map((x) => x[1]).join('');
      if (t) out.del.push(t);
    }
    out.marks.ins += (xml.match(/<w:rPr><w:ins /g) || []).length;
    out.marks.del += (xml.match(/<w:rPr><w:del /g) || []).length;
  }
  return out;
}

const cases = [['short'], ['split'], ['merge'], ['list'], ['parts'], ['heading'], ['table'], ['empty'], ['longtable']];
for (const [name] of cases) {
  try {
    const r = await buildRedline({ oldPath: `fixtures/edge/${name}_v1.docx`, newPath: `fixtures/edge/${name}_v2.docx` });
    const v = await revs(r.docx);
    console.log(`\n== ${name}`, JSON.stringify({ i: r.stats.insertedWords, d: r.stats.deletedWords, b: r.stats.changedBlocks, pb: r.stats.paragraphBreaks || 0, same: r.stats.identical, skipped: r.stats.skippedParts }));
    console.log('   ins:', JSON.stringify(v.ins.slice(0, 8)));
    console.log('   del:', JSON.stringify(v.del.slice(0, 8)));
    console.log('   paraMarks:', JSON.stringify(v.marks));
    fs.writeFileSync(`out/edge-${name}.html`, r.html);
    fs.writeFileSync(`out/edge-${name}.docx`, r.docx);
  } catch (e) { console.log(`\n== ${name} ERROR: ${e.message}`); }
}
