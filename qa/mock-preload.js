// Stands in for the Electron preload bridge so the renderer can be driven and
// screenshotted in a plain browser during QA. Never shipped with the app.
//
// The change counts come from a real engine run injected as window.__REAL__ by
// the capture script, so every screenshot shows numbers that reconcile with the
// fixture documents.
(() => {
  const listeners = {};
  const on = (name) => (fn) => { (listeners[name] = listeners[name] || []).push(fn); return () => {}; };
  const emit = (name, payload) => (listeners[name] || []).forEach((fn) => fn(payload));

  const real = window.__REAL__ || {};
  const win = (window.__MOCK_PLATFORM__ || 'win32') === 'win32';
  const dir = win ? 'C:\\Users\\Michael\\Documents\\Deals' : '/Users/michael/Documents/Deals';
  const join = (name) => dir + (win ? '\\' : '/') + name;

  const FILES = [
    {
      path: join('Withywindle MSA v1.docx'), name: 'Withywindle MSA v1.docx',
      dir, folder: 'Deals', size: 148224,
      modified: new Date(Date.now() - 86400000 * 6).toISOString(),
    },
    {
      path: join('Withywindle MSA v2 (counsel comments).docx'),
      name: 'Withywindle MSA v2 (counsel comments).docx',
      dir, folder: 'Deals', size: 151998,
      modified: new Date(Date.now() - 3600000 * 5).toISOString(),
    },
    {
      path: join('Withywindle MSA v3 execution copy.docx'),
      name: 'Withywindle MSA v3 execution copy.docx',
      dir, folder: 'Deals', size: 152310,
      modified: new Date(Date.now() - 3600000).toISOString(),
    },
  ];

  const base = 'Redline - Withywindle MSA v2 (counsel comments) vs Withywindle MSA v1';
  const RESULT = {
    outputs: [
      { kind: 'word', name: base + '.docx', path: join(base + '.docx') },
      { kind: 'pdf', name: base + '.pdf', path: join(base + '.pdf') },
    ],
    stats: real.stats || { insertedWords: 100, deletedWords: 30, changedBlocks: 15, identical: false },
    partialError: null,
    quote: real.quote || {
      line: 'Sharp-ears, Wise-nose, Swish-tail and Bumpkin,\nWhite-socks my little lad, and old Fatty Lumpkin!',
      source: 'Fog on the Barrow-downs',
    },
    oldName: 'Withywindle MSA v1.docx',
    newName: 'Withywindle MSA v2 (counsel comments).docx',
    folder: dir,
  };

  const FAILURES = {
    busy: {
      ok: false, kind: null,
      error: 'The redline couldn’t be saved — the folder or an existing file is locked. Close the document in Word and try again.',
      detail: 'Error: EBUSY: resource busy or locked, open \'…\\Redline - Withywindle MSA v2.docx\'\n    at writeOutput (main.js:161:10)',
    },
    readonly: {
      ok: false, kind: 'readonly',
      error: '“Deals” is read-only, so the redline can’t be saved there.',
      detail: null,
    },
  };

  window.lumpkin = {
    getState: async () => ({
      platform: window.__MOCK_PLATFORM__ || 'win32',
      version: '1.0.0',
      settings: { openAfterCreate: true, outputLocation: 'source', defaultMode: 'both', revisionAuthor: '' },
      defaultAuthor: 'Michael',
      contextMenuSupported: true,
      packaged: true,
    }),
    pendingFiles: async () => ({ files: [], rejected: [], mode: null }),
    contextMenuStatus: async () => ({ installed: true }),
    cancelCompare: async () => true,
    chooseFiles: async () => ({ files: FILES.slice(0, 2), rejected: [] }),
    describeFiles: async (paths) => FILES.slice(0, paths.length),
    guessOlder: async () => ({ index: 0, reason: 'modified', days: 6, hours: 139 }),
    compare: async () => {
      if (window.__MOCK_FAIL__) return FAILURES[window.__MOCK_FAIL__] || FAILURES.busy;
      if (window.__MOCK_IDENTICAL__) {
        return { ok: true, result: { ...RESULT, stats: { insertedWords: 0, deletedWords: 0, changedBlocks: 0, identical: true } } };
      }
      return { ok: true, result: RESULT };
    },
    openFile: async () => {}, revealFile: async () => {},
    saveSettings: async (p) => ({
      settings: { openAfterCreate: true, outputLocation: 'source', defaultMode: 'both', revisionAuthor: '', ...p },
      persisted: true,
    }),
    installContextMenu: async () => ({ ok: true }),
    uninstallContextMenu: async () => ({ ok: true }),
    closeWindow: async () => {},
    pathForFile: (f) => join(f.name),
    onFiles: on('files'), onProgress: on('progress'),
    onMenuChoose: on('menuChoose'), onMenuSettings: on('menuSettings'),
  };

  window.__mock = { FILES, RESULT, emit };
})();
