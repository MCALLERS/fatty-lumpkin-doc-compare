'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, nativeImage, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const settings = require('./settings');
const contextMenu = require('../shell/context-menu');
const { quoteAt } = require('../shared/quotes');
const { buildRedline, guessOlder, explainOlder, UserError } = require('../engine');

const DOC_EXT = new Set(['.docx', '.docm', '.doc']);
const COALESCE_MS = 700;

let win = null;
let ready = false;                 // renderer has asked for its pending files
let pending = { files: [], rejected: [], mode: null };
let coalesceTimer = null;
let brandDataUri = null;

/** Paths this session has actually produced — the only things we will open. */
const produced = new Set();

/**
 * Run tokens the renderer has abandoned. A cancelled run must not write files
 * into the user's deal folder, and must not launch Word on a document they
 * explicitly walked away from.
 */
const cancelled = new Set();
let activePrinter = null;

function isCancelled(token) { return token !== undefined && cancelled.has(token); }

/* ------------------------------------------------------------------ */
/* argument handling                                                   */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const files = [];
  const rejected = [];
  let mode = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a || a === '.' || a.startsWith('-')) {
      const m = /^--mode=(word|pdf|both)$/.exec(a || '');
      if (m) mode = m[1];
      continue;
    }
    let real;
    try { real = fs.statSync(a).isFile() ? path.resolve(a) : null; } catch { real = null; }
    if (!real) continue;
    if (DOC_EXT.has(path.extname(a).toLowerCase())) files.push(real);
    else rejected.push(path.basename(a));
  }
  return { files, rejected, mode };
}

/**
 * Explorer and Finder can deliver a multi-file selection as several separate
 * launches. Gather whatever arrives inside a short window, then hand the lot to
 * the renderer. Nothing is discarded until the renderer has taken it.
 */
function queue(files, rejected, mode) {
  if (mode && !pending.mode) pending.mode = mode;
  for (const f of files) if (!pending.files.includes(f)) pending.files.push(f);
  for (const r of rejected || []) if (!pending.rejected.includes(r)) pending.rejected.push(r);
  if (coalesceTimer) clearTimeout(coalesceTimer);
  coalesceTimer = setTimeout(deliver, COALESCE_MS);
}

function takePending() {
  const payload = {
    files: pending.files.map(describe),
    rejected: pending.rejected.slice(),
    mode: pending.mode || settings.read().defaultMode,
  };
  pending = { files: [], rejected: [], mode: null };
  return payload;
}

function deliver() {
  coalesceTimer = null;
  if (!ready || !win || win.isDestroyed()) return;   // the renderer will pull instead
  if (!pending.files.length && !pending.rejected.length) return;
  win.webContents.send('files:received', takePending());
}

function describe(p) {
  let size = 0, modified = null;
  try { const st = fs.statSync(p); size = st.size; modified = st.mtime.toISOString(); } catch { /* ignore */ }
  return { path: p, name: path.basename(p), dir: path.dirname(p), folder: path.basename(path.dirname(p)), size, modified };
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/* ------------------------------------------------------------------ */
/* window                                                              */
/* ------------------------------------------------------------------ */

function createWindow() {
  win = new BrowserWindow({
    width: 820,
    height: 640,
    minWidth: 620,
    minHeight: 560,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#15141A' : '#FBF7EE',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 18 } : undefined,
    autoHideMenuBar: process.platform !== 'darwin',
    icon: process.platform === 'linux' ? path.join(__dirname, '../../build/icon.png') : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; ready = false; });

  // The renderer has no links; nothing may open a browser on its say-so.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

/* ------------------------------------------------------------------ */
/* output paths                                                        */
/* ------------------------------------------------------------------ */

function sanitize(name) {
  return name.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
}

function stem(p) { return path.basename(p, path.extname(p)); }

function outputDir(newPath) {
  if (settings.read().outputLocation === 'desktop') {
    try { return app.getPath('desktop'); } catch { /* fall through */ }
  }
  return path.dirname(newPath);
}

function baseNameFor(oldPath, newPath) {
  let base = sanitize(`Redline - ${stem(newPath)} vs ${stem(oldPath)}`);
  if (base.length > 110) base = base.slice(0, 110).trim();
  return base;
}

/**
 * Write `data` next to the newer document, never clobbering an existing file.
 * The exclusive-create flag closes the gap between "does it exist" and "write".
 */
function writeOutput(dir, base, ext, data) {
  for (let n = 1; n <= 200; n++) {
    const name = n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`;
    const dest = path.join(dir, name);
    try {
      fs.writeFileSync(dest, data, { flag: 'wx', mode: 0o600 });
      produced.add(dest);
      return dest;
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new UserError('There are already 200 redlines of this pair in that folder. Tidy some away and try again.');
}

function writable(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}

/* ------------------------------------------------------------------ */
/* PDF rendering                                                       */
/* ------------------------------------------------------------------ */

async function htmlToPdf(html, pageSize) {
  // mkdtemp already creates the directory 0700 on POSIX; on Windows the temp
  // directory is per-user. The file itself is written 0600.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fatty-lumpkin-'));
  const tmp = path.join(dir, 'redline.html');
  fs.writeFileSync(tmp, html, { encoding: 'utf8', mode: 0o600 });

  // A private, cacheless session so the request filter applies to the print
  // view alone and cannot be clobbered by, or leak into, the app's session.
  const printSession = session.fromPartition('fatty-lumpkin-print', { cache: false });
  printSession.webRequest.onBeforeRequest((details, cb) => {
    cb({ cancel: !/^(file|data|devtools):/.test(details.url) });
  });
  printSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  const printer = new BrowserWindow({
    show: false,
    webPreferences: {
      offscreen: true, contextIsolation: true, nodeIntegration: false,
      javascript: false, sandbox: true, images: true, webSecurity: true,
      session: printSession,
    },
  });
  activePrinter = printer;
  printer.webContents.on('will-navigate', (e) => e.preventDefault());
  printer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  try {
    await printer.loadFile(tmp);
    // The temp file holds the full text of both documents; drop it as soon as
    // Chromium has parsed it rather than waiting for the print to finish.
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    return await printer.webContents.printToPDF({
      pageSize: pageSize === 'A4' ? 'A4' : 'Letter',
      printBackground: true,
      margins: { top: 0.63, bottom: 0.63, left: 0.59, right: 0.59 },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate:
        '<div style="width:100%;font:8px -apple-system,\'Segoe UI\',Helvetica,Arial,sans-serif;color:#7A7364;padding:0 15mm;display:flex;justify-content:space-between;">'
        + '<span>Fatty Lumpkin Doc Compare</span>'
        + '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>',
    });
  } finally {
    activePrinter = null;
    if (!printer.isDestroyed()) printer.destroy();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
/* compare                                                             */
/* ------------------------------------------------------------------ */

function validDocPath(p) {
  if (typeof p !== 'string' || !p) return false;
  if (!DOC_EXT.has(path.extname(p).toLowerCase())) return false;
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

class Cancelled extends Error {
  constructor() { super('cancelled'); this.name = 'Cancelled'; this.cancelled = true; }
}

async function runCompare({ oldPath, newPath, mode, token }) {
  const stop = () => { if (isCancelled(token)) throw new Cancelled(); };
  if (!validDocPath(oldPath) || !validDocPath(newPath)) {
    throw new UserError('One of those documents has moved or been renamed. Choose them again.');
  }
  const wantDocx = mode === 'word' || mode === 'both';
  const wantPdf = mode === 'pdf' || mode === 'both';

  const dir = outputDir(newPath);
  if (!writable(dir)) {
    const err = new UserError(`“${path.basename(dir)}” is read-only, so the redline can’t be saved there.`);
    err.kind = 'readonly';
    throw err;
  }

  stop();
  send('compare:progress', { step: 'comparing', token });
  const result = await buildRedline({
    oldPath, newPath,
    docx: wantDocx,
    html: wantPdf,
    brandImage: brandDataUri,
    author: settings.read().revisionAuthor || defaultAuthor(),
  });

  stop();
  const base = baseNameFor(oldPath, newPath);
  const outputs = [];
  let partialError = null;
  try {
    if (wantDocx && result.docx) {
      send('compare:progress', { step: 'writing', token });
      stop();
      const dest = writeOutput(dir, base, '.docx', result.docx);
      outputs.push({ kind: 'word', path: dest, name: path.basename(dest) });
    }
    if (wantPdf && result.html) {
      send('compare:progress', { step: 'pdf', token });
      stop();
      const pdf = await htmlToPdf(result.html, result.meta.pageSize);
      stop();
      const dest = writeOutput(dir, base, '.pdf', pdf);
      outputs.push({ kind: 'pdf', path: dest, name: path.basename(dest) });
    }
  } catch (err) {
    if (err && err.cancelled) throw err;
    if (!outputs.length) {
      if (err && err.userFacing) throw err;
      if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
        throw new UserError('The redline couldn’t be saved — the folder or an existing file is locked. Close the document in Word and try again.');
      }
      throw err;
    }
    // One format succeeded: report that honestly rather than discarding it.
    partialError = err && err.userFacing
      ? err.message
      : 'The PDF could not be laid out, so only the Word version was produced.';
  }

  stop();
  const s = settings.read();
  settings.write({ quoteIndex: (Number(s.quoteIndex) || 0) + 1 });

  // Never launch anything for a run the user cancelled, or for two documents
  // that turned out to be identical.
  if (s.openAfterCreate && outputs.length && !result.stats.identical && !isCancelled(token)) {
    shell.openPath(outputs[0].path).catch(() => {});
  }

  return {
    outputs,
    partialError,
    stats: result.stats,
    quote: quoteAt(Number(s.quoteIndex) || 0),
    oldName: path.basename(oldPath),
    newName: path.basename(newPath),
    folder: path.dirname(outputs.length ? outputs[0].path : newPath),
  };
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc() {
  // Deliberately synchronous: the first paint must not wait on a registry query
  // that can take seconds behind endpoint security software.
  ipcMain.handle('app:state', () => ({
    platform: process.platform,
    version: app.getVersion(),
    settings: settings.read(),
    defaultAuthor: defaultAuthor(),
    contextMenuSupported: process.platform === 'win32' || process.platform === 'darwin',
    packaged: app.isPackaged,
  }));

  ipcMain.handle('contextMenu:status', async () => ({
    installed: await contextMenu.isInstalled().catch(() => false),
  }));

  ipcMain.handle('compare:cancel', (_e, token) => {
    if (typeof token === 'number') cancelled.add(token);
    if (activePrinter && !activePrinter.isDestroyed()) {
      try { activePrinter.destroy(); } catch { /* already gone */ }
      activePrinter = null;
    }
    return true;
  });

  // Pull model: the renderer asks once it is listening, so nothing handed over
  // by the shell can be lost to a slow cold start.
  ipcMain.handle('files:pending', () => {
    ready = true;
    return takePending();
  });

  ipcMain.handle('files:choose', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose two Word documents',
      buttonLabel: 'Compare',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Word documents', extensions: ['docx', 'docm', 'doc'] }],
    });
    if (res.canceled) return { files: [], rejected: [] };
    const files = res.filePaths.filter((p) => DOC_EXT.has(path.extname(p).toLowerCase()));
    const rejected = res.filePaths.filter((p) => !DOC_EXT.has(path.extname(p).toLowerCase())).map((p) => path.basename(p));
    return { files: files.map(describe), rejected };
  });

  ipcMain.handle('files:describe', (_e, paths) =>
    (Array.isArray(paths) ? paths : [])
      .filter((p) => typeof p === 'string' && DOC_EXT.has(path.extname(p).toLowerCase()))
      .filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } })
      .map(describe));

  ipcMain.handle('files:guessOlder', (_e, pair) => {
    if (!Array.isArray(pair) || pair.length !== 2) return { index: 0, reason: 'order' };
    return explainOlder(pair[0], pair[1]);
  });

  ipcMain.handle('compare:run', async (_e, payload) => {
    const token = payload && payload.token;
    try {
      return { ok: true, result: await runCompare(payload || {}) };
    } catch (err) {
      if (err && err.cancelled) return { ok: false, cancelled: true };
      console.error('compare failed:', err);
      return {
        ok: false,
        kind: (err && err.kind) || null,
        error: err && err.userFacing
          ? err.message
          : 'Something went wrong while building the redline. If one of the documents is open in Word, close it and try again.',
        // Enough for an IT desk to act on, without putting client-matter paths
        // on the user's clipboard.
        detail: [err && err.name, err && err.code, err && err.message].filter(Boolean).join(' · ') || 'unknown error',
      };
    } finally {
      if (typeof token === 'number') cancelled.delete(token);
    }
  });

  // Only files this session created can be opened or revealed: a renderer must
  // never be able to talk the main process into launching an arbitrary path.
  ipcMain.handle('file:open', (_e, p) => {
    if (!produced.has(p)) return null;
    return shell.openPath(p);
  });
  ipcMain.handle('file:reveal', (_e, p) => {
    if (!produced.has(p)) return null;
    return shell.showItemInFolder(p);
  });

  ipcMain.handle('settings:set', (_e, patch) => {
    const value = settings.write(patch);
    return { settings: value, persisted: settings.persisted() };
  });

  ipcMain.handle('contextMenu:install', async () => {
    try {
      await contextMenu.install(process.execPath, iconPathForShell());
      settings.write({ contextMenuInstalled: true, contextMenuExe: process.execPath });
      return { ok: true };
    } catch (err) {
      settings.write({ contextMenuInstalled: false });
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('contextMenu:uninstall', async () => {
    try {
      await contextMenu.uninstall();
      settings.write({ contextMenuInstalled: false, contextMenuExe: null });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('window:close', () => { if (win) win.close(); });
}

/** A sensible default name to attribute tracked changes to. */
function defaultAuthor() {
  try {
    const name = (os.userInfo().username || '').trim();
    if (name && name.toLowerCase() !== 'user') return name;
  } catch { /* fall through */ }
  return 'Fatty Lumpkin Doc Compare';
}

function iconPathForShell() {
  const candidates = [
    path.join(process.resourcesPath || '', 'icon.ico'),
    path.join(process.resourcesPath || '', 'icon.png'),
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  return null;
}

/* ------------------------------------------------------------------ */
/* startup                                                             */
/* ------------------------------------------------------------------ */

function loadBrandImage() {
  const p = path.join(__dirname, '../renderer/assets/pony-mark.png');
  try {
    const img = nativeImage.createFromPath(p).resize({ width: 96, height: 96, quality: 'best' });
    brandDataUri = img.isEmpty() ? null : img.toDataURL();
  } catch { brandDataUri = null; }
}

/**
 * Keep the shell integration pointing at wherever the app now lives. Users
 * routinely run the app once from Downloads and then drag it to Applications.
 */
async function refreshContextMenu() {
  const s = settings.read();
  if (!s.contextMenuInstalled) return;
  if (s.contextMenuExe === process.execPath) return;
  try {
    await contextMenu.install(process.execPath, iconPathForShell());
    settings.write({ contextMenuExe: process.execPath });
  } catch { settings.write({ contextMenuInstalled: false }); }
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection in the main process:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception in the main process:', err);
});

const cliArgs = parseArgs(process.argv);

if (process.argv.includes('--install-context-menu')) {
  app.whenReady().then(async () => {
    await contextMenu.install(process.execPath, iconPathForShell()).catch(() => {});
    app.quit();
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // On macOS the app stays alive with no window; a Quick Action must be able to
  // bring one back, or the right-click menu silently stops working.
  function surface() {
    if (!win || win.isDestroyed()) { createWindow(); return; }
    if (win.isMinimized()) win.restore();
    win.focus();
  }

  app.on('second-instance', (_e, argv) => {
    const parsed = parseArgs(argv);
    surface();
    if (parsed.files.length || parsed.rejected.length) queue(parsed.files, parsed.rejected, parsed.mode);
  });

  app.on('open-file', (event, filePath) => {           // macOS drag-onto-icon / Open With
    event.preventDefault();
    surface();
    const ok = DOC_EXT.has(path.extname(filePath).toLowerCase());
    queue(ok ? [filePath] : [], ok ? [] : [path.basename(filePath)], null);
  });

  app.whenReady().then(async () => {
    loadBrandImage();
    registerIpc();
    Menu.setApplicationMenu(buildMenu());
    createWindow();
    if (cliArgs.files.length || cliArgs.rejected.length) {
      queue(cliArgs.files, cliArgs.rejected, cliArgs.mode);
    }

    const s = settings.read();
    if (!s.seenWelcome && (process.platform === 'win32' || process.platform === 'darwin')) {
      settings.write({ seenWelcome: true });
      const already = await contextMenu.isInstalled().catch(() => false);
      if (already) {
        settings.write({ contextMenuInstalled: true, contextMenuExe: process.execPath });
      } else {
        try {
          await contextMenu.install(process.execPath, iconPathForShell());
          settings.write({ contextMenuInstalled: true, contextMenuExe: process.execPath });
        } catch {
          // Managed machines can block this; never claim it worked when it did not.
          settings.write({ contextMenuInstalled: false });
        }
      }
    } else {
      await refreshContextMenu();
    }
  }).catch((err) => {
    console.error('Startup failed:', err);
    dialog.showErrorBox('Fatty Lumpkin Doc Compare', 'The app could not start.\n\n' + String(err && err.message ? err.message : err));
    app.quit();
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (!win) createWindow(); });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Choose Documents…', accelerator: 'CmdOrCtrl+O', click: () => send('menu:choose') },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send('menu:settings') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'copy' }, { role: 'selectAll' }] },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }]),
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Fatty Lumpkin on the web', click: () => shell.openExternal('https://redline.bombadillo-ai.com') },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
