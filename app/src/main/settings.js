'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  openAfterCreate: true,
  outputLocation: 'source',      // 'source' | 'desktop'
  defaultMode: 'both',           // 'word' | 'pdf' | 'both'
  contextMenuInstalled: false,
  contextMenuExe: null,
  seenWelcome: false,
  quoteIndex: 0,
  revisionAuthor: '',            // '' means "use the operating-system user name"
};

/** Every setting is validated on the way in — a corrupt file must not break the app. */
const SCHEMA = {
  openAfterCreate: (v) => (typeof v === 'boolean' ? v : DEFAULTS.openAfterCreate),
  outputLocation: (v) => (v === 'desktop' || v === 'source' ? v : DEFAULTS.outputLocation),
  defaultMode: (v) => (v === 'word' || v === 'pdf' || v === 'both' ? v : DEFAULTS.defaultMode),
  contextMenuInstalled: (v) => v === true,
  contextMenuExe: (v) => (typeof v === 'string' && v ? v : null),
  seenWelcome: (v) => v === true,
  quoteIndex: (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) % 100000 : 0;
  },
  revisionAuthor: (v) => (typeof v === 'string' ? v.slice(0, 64).trim() : ''),
};

let cache = null;
function file() { return path.join(app.getPath('userData'), 'settings.json'); }

function clean(raw) {
  const out = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(SCHEMA)) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) out[key] = SCHEMA[key](raw[key]);
    }
  }
  return out;
}

function read() {
  if (cache) return cache;
  try {
    cache = clean(JSON.parse(fs.readFileSync(file(), 'utf8')));
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

let lastPersisted = true;

/**
 * Write through a temp file and rename, so a crash mid-write cannot leave a
 * half-written settings file behind. Failure is never fatal, but it is
 * reported, so the UI can tell the user a preference will not stick.
 */
function write(patch) {
  const next = clean({ ...read(), ...(patch && typeof patch === 'object' ? patch : {}) });
  cache = next;
  const target = file();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
    lastPersisted = true;
  } catch {
    lastPersisted = false;
  }
  return next;
}

function persisted() { return lastPersisted; }

module.exports = { read, write, persisted, DEFAULTS };
