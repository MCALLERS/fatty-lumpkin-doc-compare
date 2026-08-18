'use strict';
/* Fatty Lumpkin Doc Compare — renderer logic. */

const api = window.lumpkin;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const DOC_RE = /\.(docx|docm|doc)$/i;

const state = {
  files: [],          // everything staged so far, de-duplicated by path
  chosen: [],         // indexes into files of the two being compared
  mode: 'both',
  phase: 'older',     // 'pickTwo' | 'older'
  settings: {},
  platform: 'win32',
  defaultAuthor: '',
  contextMenuInstalled: false,
  guess: { index: 0, reason: 'order' },
  runToken: 0,
  running: false,
  lastPair: null,     // { oldPath, newPath } of the most recent run
  lastResult: null,
  booted: false,
};

/* ----------------------------- utilities ------------------------------ */

let suppressAutoFocus = false;

function screen(name) {
  const changed = document.body.dataset.screen !== name;
  document.body.dataset.screen = name;
  // Move the reading position without stealing focus onto a control the user
  // has not reached for yet -- and never on first paint, so the skip link stays
  // the first tab stop.
  if (changed && state.booted && !suppressAutoFocus) {
    setTimeout(() => $('#main').focus({ preventScroll: true }), 30);
  }
}

function fmtBytes(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(+d)) return '';
  const today = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `today, ${time}`;
  const yday = new Date(today); yday.setDate(today.getDate() - 1);
  if (d.toDateString() === yday.toDateString()) return `yesterday, ${time}`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function plural(n, one, many) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** Keep the tail of a long filename — that is where the extension lives. */
function middleTruncate(name, max) {
  if (name.length <= max) return name;
  const keepEnd = Math.max(14, Math.floor(max * 0.4));
  return name.slice(0, max - keepEnd - 1) + '…' + name.slice(-keepEnd);
}

/** Reveal the live region first, then write to it — otherwise nothing is announced. */
function announce(el, text) {
  el.hidden = false;
  requestAnimationFrame(() => { el.textContent = text; });
}

let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  el.hidden = false;
  requestAnimationFrame(() => { el.textContent = message; });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

function notice(html) {
  const el = $('#drop-notice');
  if (!html) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  requestAnimationFrame(() => { el.innerHTML = html; });
}

const FOLDER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h3.6l1.7 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
const ARROW_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13"/><path d="m12.5 6 6 6-6 6"/></svg>';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function basename(p) { return String(p).split(/[\\/]/).pop(); }

/* ------------------------------ staging ------------------------------- */

function resetToDrop(keepFiles) {
  if (!keepFiles) { state.files = []; state.chosen = []; notice(''); }
  paintDrop();
  screen('drop');
}

/** The drop screen states what it actually has, rather than always inviting two. */
function paintDrop() {
  const staged = $('#staged');
  const actions = $('#staged-actions');
  const n = state.files.length;

  if (n === 0) {
    staged.hidden = true; staged.innerHTML = '';
    actions.hidden = true;
    $('#drop-title').textContent = 'Drop two Word documents here';
    $('#drop-help').textContent = 'Word track changes, PDF, or both.';
    return;
  }

  staged.hidden = false;
  staged.innerHTML = state.files.slice(0, 6).map((f) => `<li><span class="doc-dot"></span>
    <span class="staged-name">${escapeHtml(f.name)}</span>
    <span class="staged-meta">${escapeHtml(f.folder || '')}</span></li>`).join('');

  if (n === 1) {
    actions.hidden = true;
    $('#drop-title').textContent = 'One more document';
    $('#drop-help').textContent = 'Drop the other version, or click to choose it.';
  } else {
    actions.hidden = false;
    $('#drop-title').textContent = n === 2 ? 'Two documents ready' : `${n} documents ready`;
    $('#drop-help').textContent = 'Drop different files to replace them.';
  }
}

/**
 * Add documents to whatever is already staged. Two separate drops, or two
 * separate right-click launches, have to add up to a pair — replacing the list
 * each time was a dead end the user could never escape.
 */
function stageFiles(incoming, mode, rejected) {
  if (mode) state.mode = mode;
  paintMode();

  const byPath = new Map(state.files.map((f) => [f.path, f]));
  for (const f of incoming || []) byPath.set(f.path, f);
  let files = [...byPath.values()];
  // A fresh batch of two supersedes a single leftover from an earlier attempt.
  if ((incoming || []).length >= 2) files = incoming.slice();
  state.files = files;

  notice(rejected && rejected.length
    ? `<b>Only Word documents can be compared.</b> Ignored: ${rejected.map(escapeHtml).join(', ')}.`
    : '');

  if (files.length < 2) { paintDrop(); screen('drop'); return; }

  if (files.length > 2) {
    state.phase = 'pickTwo';
    state.chosen = [];
    renderPicker();
    return;
  }

  state.phase = 'older';
  state.chosen = [0, 1];
  updateGuess().then(() => renderPicker());
}

async function updateGuess() {
  if (!api || state.chosen.length !== 2) { state.guess = { index: state.chosen[0] || 0, reason: 'order' }; return; }
  try {
    const g = await api.guessOlder([state.files[state.chosen[0]], state.files[state.chosen[1]]]);
    state.guess = { ...g, index: state.chosen[g && g.index === 1 ? 1 : 0] };
  } catch { state.guess = { index: state.chosen[0], reason: 'order' }; }
}

/* ------------------------------- picker ------------------------------- */

function badgeFor(fileIndex) {
  const g = state.guess;
  if (fileIndex !== g.index) return '';
  if (g.reason === 'modified') {
    if (g.days >= 1) return `Saved ${g.days === 1 ? 'a day' : g.days + ' days'} earlier`;
    if (g.hours >= 1) return `Saved ${g.hours === 1 ? 'an hour' : g.hours + ' hours'} earlier`;
    return 'Saved earlier';
  }
  if (g.reason === 'filename') return 'Looks like the earlier draft';
  return '';
}

function renderPicker(focusPosition) {
  const pickTwo = state.phase === 'pickTwo';
  const multi = state.files.length > 2;

  $('#picker-title').innerHTML = pickTwo
    ? 'Pick the <em>two</em> documents to compare'
    : 'Which one is the <em>older</em> version?';
  $('#picker-sub').textContent = pickTwo
    ? 'Then you will say which of the two is older.'
    : 'Click it and the redline starts.';

  const step = $('#picker-step');
  step.hidden = !multi;
  if (multi) step.textContent = pickTwo ? 'Step 1 of 2' : 'Step 2 of 2';

  const list = pickTwo ? state.files.map((_, i) => i) : state.chosen;
  const cards = $('#cards');
  cards.innerHTML = '';
  cards.classList.toggle('many', pickTwo && list.length > 2);
  cards.classList.toggle('pair', list.length === 2);

  list.forEach((fileIndex, position) => {
    const f = state.files[fileIndex];
    const selected = pickTwo && state.chosen.includes(fileIndex);
    const badge = pickTwo ? '' : badgeFor(fileIndex);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'card';
    btn.dataset.index = String(fileIndex);
    if (pickTwo) btn.setAttribute('aria-pressed', String(selected));
    btn.setAttribute('aria-keyshortcuts', String(position + 1));

    const cta = pickTwo
      ? (selected ? 'Selected — click to unselect' : 'Compare this one')
      : 'This is the older one';
    btn.setAttribute('aria-label', pickTwo
      ? `${f.name} — ${selected ? 'selected, click to unselect' : 'select to compare'}`
      : `${f.name} is the older one — start the redline`);

    btn.innerHTML = `
      ${position < 9 ? `<span class="key" aria-hidden="true">${position + 1}</span>` : ''}
      <span class="card-top">${badge ? `<span class="badge">${escapeHtml(badge)}</span>` : ''}</span>
      <span class="card-name">${escapeHtml(f.name)}</span>
      <span class="card-folder">${FOLDER_ICON}<span>${escapeHtml(f.folder || f.dir)}</span></span>
      <span class="card-meta">${[fmtWhen(f.modified) && 'Saved ' + fmtWhen(f.modified), fmtBytes(f.size)].filter(Boolean).join(' · ')}</span>
      <span class="card-cta">${escapeHtml(cta)}${ARROW_ICON}</span>`;
    btn.addEventListener('click', () => onCardClick(fileIndex, position));
    cards.appendChild(btn);
  });

  const hint = $('#key-hint');
  const count = Math.min(list.length, 9);
  hint.hidden = count < 2;
  hint.innerHTML = count === 2
    ? 'Press <b>1</b> or <b>2</b> to choose'
    : `Press <b>1</b>–<b>${count}</b> to choose`;

  $('#pick-other').textContent = pickTwo ? 'Start over' : 'Choose different documents';

  // Rebuilding the list destroys focus; put it back where the user left it,
  // and stop the screen change from pulling focus away again.
  suppressAutoFocus = focusPosition !== undefined;
  screen('picker');
  suppressAutoFocus = false;
  if (focusPosition !== undefined) {
    const card = cards.children[Math.min(focusPosition, cards.children.length - 1)];
    if (card) card.focus();
  }
}

function onCardClick(fileIndex, position) {
  if (state.phase === 'pickTwo') {
    const at = state.chosen.indexOf(fileIndex);
    if (at >= 0) state.chosen.splice(at, 1);
    else if (state.chosen.length < 2) state.chosen.push(fileIndex);
    else state.chosen = [state.chosen[1], fileIndex];
    if (state.chosen.length === 2) {
      state.phase = 'older';
      updateGuess().then(() => renderPicker(0));
      return;
    }
    renderPicker(position);
    return;
  }
  const olderPath = state.files[fileIndex].path;
  const otherIndex = state.chosen.find((i) => i !== fileIndex);
  run(olderPath, state.files[otherIndex].path, state.mode);
}

/* -------------------------------- run --------------------------------- */

const MIN_VISIBLE_MS = 250;

async function run(oldPath, newPath, mode) {
  state.lastPair = { oldPath, newPath };
  const token = ++state.runToken;
  state.running = true;
  $('#working-files').textContent = `${basename(oldPath)}  →  ${basename(newPath)}`;
  screen('working');
  announce($('#working-step'), 'Reading both documents');
  setTimeout(() => { const b = $('#cancel-btn'); if (b) b.focus(); }, 60);

  const started = Date.now();
  let res;
  try {
    res = await api.compare({ oldPath, newPath, mode: mode || state.mode, token });
  } catch (err) {
    res = { ok: false, error: 'The comparison stopped unexpectedly. Please try again.', detail: String(err) };
  }
  if (token !== state.runToken) return;                 // cancelled, or superseded
  state.running = false;

  const wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - started));
  await new Promise((r) => setTimeout(r, wait));
  if (token !== state.runToken) return;

  if (res.cancelled) { resetToDrop(true); return; }
  if (res.ok) renderDone(res.result);
  else renderError(res.error, res.detail, res.kind);

  // Anything the shell handed us while the run was in flight.
  if (queuedWhileBusy) {
    const q = queuedWhileBusy; queuedWhileBusy = null;
    toast('Picking up the documents you sent while that was running.');
    stageFiles(q.files, q.mode, q.rejected);
  }
}

function cancelRun() {
  const token = state.runToken;
  state.runToken += 1;
  state.running = false;
  if (api.cancelCompare) api.cancelCompare(token);
  if (state.chosen.length === 2) renderPicker(0);
  else resetToDrop(true);
}

/* -------------------------------- done -------------------------------- */

function renderDone(result) {
  state.lastResult = result;
  const s = result.stats;
  const same = !!s.identical;

  document.body.classList.toggle('is-identical', same);
  $('#done-title').textContent = same ? 'No changes found' : 'Redline ready';

  const summary = $('#done-summary');
  summary.innerHTML = same
    ? '<span>These two documents match word for word — body text, tables, footnotes and headers.</span>'
    : `<span><span class="done-summary-dot dot-ins"></span>${plural(s.insertedWords, 'word added', 'words added')}</span>
       <span><span class="done-summary-dot dot-del"></span>${plural(s.deletedWords, 'word deleted', 'words deleted')}</span>
       <span><span class="done-summary-dot dot-neutral"></span>${plural(s.changedBlocks, 'passage changed', 'passages changed')}</span>`;

  $('#dir-old').textContent = result.oldName;
  $('#dir-new').textContent = result.newName;

  const list = $('#outputs');
  list.innerHTML = '';
  for (const out of result.outputs) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="file-icon" aria-hidden="true">${out.kind === 'pdf' ? 'PDF' : 'DOCX'}</span>
      <span class="file-text">
        <span class="file-name">${escapeHtml(middleTruncate(out.name, 96))}</span>
        <span class="file-where">${escapeHtml(result.folder)}</span>
      </span>
      <span class="file-actions">
        <button type="button" class="btn btn-quiet btn-small" data-open>Open</button>
        <button type="button" class="btn btn-quiet btn-small" data-reveal>${state.platform === 'darwin' ? 'Show in Finder' : 'Show in folder'}</button>
      </span>`;
    const open = li.querySelector('[data-open]');
    const reveal = li.querySelector('[data-reveal]');
    open.setAttribute('aria-label', `Open ${out.name}`);
    reveal.setAttribute('aria-label', `Show ${out.name} in its folder`);
    open.addEventListener('click', () => api.openFile(out.path));
    reveal.addEventListener('click', () => api.revealFile(out.path));
    list.appendChild(li);
  }

  // Primary action: open the thing we just made, unless it opened itself.
  const openBtn = $('#open-btn');
  const first = result.outputs[0];
  const autoOpened = state.settings.openAfterCreate && !same && first;
  if (first && !autoOpened) {
    openBtn.hidden = false;
    openBtn.textContent = result.outputs.length > 1 ? 'Open the Word redline' : 'Open the redline';
    openBtn.onclick = () => api.openFile(first.path);
  } else {
    openBtn.hidden = true;
    openBtn.onclick = null;
  }

  // The other format, without going back to the file manager for it.
  const also = $('#also-btn');
  const made = new Set(result.outputs.map((o) => o.kind));
  const missing = !made.has('pdf') ? 'pdf' : (!made.has('word') ? 'word' : null);
  if (missing && state.lastPair && !same) {
    also.hidden = false;
    also.textContent = missing === 'pdf' ? 'Also make the PDF' : 'Also make the Word version';
    also.onclick = () => run(state.lastPair.oldPath, state.lastPair.newPath, missing === 'pdf' ? 'pdf' : 'word');
  } else {
    also.hidden = true;
    also.onclick = null;
  }

  $('#reward').hidden = same;
  if (!same) {
    $('#quote-line').textContent = result.quote.line;
    $('#quote-source').textContent = `Tom Bombadil · “${result.quote.source}” · The Fellowship of the Ring`;
  }

  screen('done');
  if (result.partialError) toast(result.partialError);
}

/* ------------------------------- error -------------------------------- */

function renderError(message, detail, kind) {
  announce($('#error-message'), message);

  const alt = $('#error-alt-btn');
  if (kind === 'readonly') {
    alt.hidden = false;
    alt.textContent = 'Save it to my Desktop instead';
    alt.onclick = async () => {
      await saveSettings({ outputLocation: 'desktop' });
      if (state.lastPair) run(state.lastPair.oldPath, state.lastPair.newPath, state.mode);
    };
  } else {
    alt.hidden = true;
    alt.onclick = null;
  }

  const box = $('#error-details');
  if (detail) { $('#error-detail-text').textContent = detail; box.hidden = false; box.open = false; }
  else box.hidden = true;
  screen('error');
}

/* ------------------------------ settings ------------------------------ */

async function saveSettings(patch) {
  const res = await api.saveSettings(patch);
  const value = res && res.settings ? res.settings : res;
  state.settings = value;
  if (res && res.persisted === false) {
    toast('That preference could not be saved — it will reset when the app restarts.');
  }
  return value;
}

function paintMode() {
  $$('input[name=mode]').forEach((i) => { i.checked = i.value === state.mode; });
}

function openSheet() {
  $('#opt-open').checked = !!state.settings.openAfterCreate;
  $('#opt-desktop').checked = state.settings.outputLocation === 'desktop';
  const author = $('#opt-author');
  author.value = state.settings.revisionAuthor || '';
  author.placeholder = state.defaultAuthor || 'Fatty Lumpkin Doc Compare';
  paintContextRow();
  $('#sheet').hidden = false;
  $('#sheet-backdrop').hidden = false;
  $('#settings-btn').setAttribute('aria-expanded', 'true');
  $('#main').inert = true;
  $('#sheet-close').focus();
  document.addEventListener('keydown', sheetKeys, true);
}

function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
  $('#settings-btn').setAttribute('aria-expanded', 'false');
  $('#main').inert = false;
  document.removeEventListener('keydown', sheetKeys, true);
  $('#settings-btn').focus();
}

function sheetOpen() { return !$('#sheet').hidden; }

function sheetKeys(e) {
  if (!sheetOpen()) return;
  if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeSheet(); return; }
  if (e.key !== 'Tab') return;
  const items = $$('#sheet button, #sheet input').filter((el) => !el.disabled && el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function paintContextRow() {
  const supported = state.platform === 'win32' || state.platform === 'darwin';
  $('#ctx-row').hidden = !supported;
  if (!supported) return;
  const where = state.platform === 'darwin' ? 'Finder' : 'File Explorer';
  $('#ctx-note').textContent = state.contextMenuInstalled
    ? `Active. Select two documents in ${where}, right-click, and choose Redline with Fatty Lumpkin.`
    : `Adds “Redline with Fatty Lumpkin” to the ${where} right-click menu.`;
  $('#ctx-btn').textContent = state.contextMenuInstalled ? 'Remove' : 'Add';
}

/* -------------------------------- wiring ------------------------------- */

let queuedWhileBusy = null;

async function chooseFiles() {
  const res = await api.chooseFiles();
  if (!res.files.length && !(res.rejected || []).length) return;
  stageFiles(res.files, null, res.rejected);
  // One file chosen from a dialog whose button said "Compare" is a dead end;
  // ask for the other one straight away.
  if (state.files.length === 1) {
    toast('Now choose the other version.');
    setTimeout(chooseFiles, 350);
  }
}

function wire() {
  $('#dropzone').addEventListener('click', chooseFiles);
  $('#staged-continue').addEventListener('click', () => {
    if (state.files.length >= 2) stageFiles([], null, null);
  });
  $('#staged-clear').addEventListener('click', () => resetToDrop(false));

  $('#pick-other').addEventListener('click', () => resetToDrop(false));
  $('#again-btn').addEventListener('click', () => resetToDrop(false));
  $('#close-btn').addEventListener('click', () => api.closeWindow());
  $('#cancel-btn').addEventListener('click', cancelRun);
  $('#error-choose-btn').addEventListener('click', () => resetToDrop(false));
  $('#swap-btn').addEventListener('click', () => {
    if (state.lastPair) run(state.lastPair.newPath, state.lastPair.oldPath, state.mode);
  });
  $('#retry-btn').addEventListener('click', () => {
    if (state.lastPair) run(state.lastPair.oldPath, state.lastPair.newPath, state.mode);
    else resetToDrop(true);
  });
  $('#copy-detail-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#error-detail-text').textContent);
      toast('Details copied to the clipboard.');
    } catch { toast('Could not copy — select the text and press Ctrl+C.'); }
  });

  $$('input[name=mode]').forEach((input) => {
    input.addEventListener('change', async () => {
      state.mode = input.value;
      await saveSettings({ defaultMode: input.value });
    });
  });

  $('#settings-btn').addEventListener('click', openSheet);
  $('#sheet-close').addEventListener('click', closeSheet);
  $('#sheet-backdrop').addEventListener('click', closeSheet);
  $('#opt-open').addEventListener('change', (e) => saveSettings({ openAfterCreate: e.target.checked }));
  $('#opt-desktop').addEventListener('change', (e) => saveSettings({ outputLocation: e.target.checked ? 'desktop' : 'source' }));
  $('#opt-author').addEventListener('change', (e) => saveSettings({ revisionAuthor: e.target.value.trim() }));
  $('#ctx-btn').addEventListener('click', async () => {
    const btn = $('#ctx-btn');
    btn.disabled = true;
    const res = state.contextMenuInstalled ? await api.uninstallContextMenu() : await api.installContextMenu();
    btn.disabled = false;
    if (res.ok) {
      state.contextMenuInstalled = !state.contextMenuInstalled;
      paintContextRow();
      toast(state.contextMenuInstalled ? 'Right-click menu added.' : 'Right-click menu removed.');
    } else {
      toast(res.error || 'Could not change the right-click menu.');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (sheetOpen()) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const where = document.body.dataset.screen;
    if (e.key === 'Escape') {
      if (where === 'working') { cancelRun(); return; }
      if (where === 'picker' || where === 'error') { resetToDrop(true); return; }
      return;                                                  // never on done or drop
    }
    if (where !== 'picker' || !/^[1-9]$/.test(e.key)) return;
    // Digits must not fire while the user is inside another control.
    if (e.target && e.target.closest && e.target.closest('input, textarea, [contenteditable], #mode-group')) return;
    const card = $$('#cards .card')[Number(e.key) - 1];
    if (card) card.click();
  });

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault(); dragDepth++; document.body.classList.add('dragging');
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0; document.body.classList.remove('dragging');
    const dropped = Array.from(e.dataTransfer.files);
    const paths = dropped.map((f) => api.pathForFile(f)).filter(Boolean);
    const rejected = dropped.filter((f) => !DOC_RE.test(f.name)).map((f) => f.name);
    const files = paths.length ? await api.describeFiles(paths) : [];
    if (!files.length && !rejected.length) return;
    stageFiles(files, null, rejected);
  });

  api.onFiles((payload) => {
    // A second right-click mid-run must not yank the screen away from the job
    // that is still running.
    if (state.running) { queuedWhileBusy = payload; toast('Two more documents are waiting — finishing this one first.'); return; }
    stageFiles(payload.files, payload.mode, payload.rejected);
  });

  api.onProgress(({ step, token }) => {
    if (token !== undefined && token !== state.runToken) return;
    const text = step === 'writing' ? 'Writing your redline'
      : step === 'pdf' ? 'Laying out the PDF'
        : step === 'comparing' ? 'Finding every change'
          : 'Reading both documents';
    announce($('#working-step'), text);
  });
  api.onMenuChoose(chooseFiles);
  api.onMenuSettings(openSheet);
}

async function boot() {
  if (!api) { document.body.dataset.screen = 'drop'; return; }
  const s = await api.getState();
  state.settings = s.settings;
  state.platform = s.platform;
  state.defaultAuthor = s.defaultAuthor || '';
  state.mode = s.settings.defaultMode || 'both';
  document.body.classList.toggle('is-mac', s.platform === 'darwin');
  $('[data-file-manager]').textContent = s.platform === 'darwin' ? 'Finder' : 'File Explorer';
  $('#version-line').textContent = `Fatty Lumpkin Doc Compare ${s.version}`;
  paintMode();
  paintDrop();
  wire();
  screen('drop');
  state.booted = true;

  // Anything the shell handed us before the window finished booting.
  const waiting = await api.pendingFiles();
  if (waiting && ((waiting.files && waiting.files.length) || (waiting.rejected && waiting.rejected.length))) {
    stageFiles(waiting.files, waiting.mode, waiting.rejected);
  }

  // The registry / Services check can be slow behind endpoint security, so it
  // never blocks first paint.
  if (api.contextMenuStatus) {
    api.contextMenuStatus().then((r) => {
      state.contextMenuInstalled = !!(r && r.installed);
      if (sheetOpen()) paintContextRow();
    }).catch(() => {});
  }
}

window.addEventListener('error', (e) => console.error('renderer error', e.message));

boot();
