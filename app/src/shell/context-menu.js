'use strict';
/**
 * Installs (and removes) the "Redline with Fatty Lumpkin" right-click menu.
 *
 *  Windows : per-user registry verbs under HKCU. No administrator rights needed.
 *            Explorer invokes the verb once per selected file; the app collects
 *            the launches that arrive within a short window and treats them as
 *            one selection. (MultiSelectModel=Player is deliberately NOT set:
 *            it changes the invocation contract in ways that vary by Windows
 *            build, and the coalescing path is predictable on every version.)
 *  macOS   : three Automator Quick Action workflows dropped into
 *            ~/Library/Services. Finder passes the whole selection as script
 *            arguments, so one invocation carries both documents.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const MENU_LABEL = 'Redline with Fatty Lumpkin';
const ITEMS = [
  { mode: 'word', label: 'Redline as Word (track changes)', service: 'Redline as Word (Fatty Lumpkin)' },
  { mode: 'pdf', label: 'Redline as PDF', service: 'Redline as PDF (Fatty Lumpkin)' },
  { mode: 'both', label: 'Redline as both Word and PDF', service: 'Redline as Word + PDF (Fatty Lumpkin)' },
];

const REG_ROOT = 'HKCU\\Software\\Classes\\SystemFileAssociations';
const EXTENSIONS = ['.docx', '.docm', '.doc'];
const KEY_NAME = 'FattyLumpkinRedline';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message)); else resolve(stdout);
    });
  });
}

/* --------------------------------- Windows -------------------------------- */

function winCommand(exe, mode) {
  return `"${exe}" --mode=${mode} "%1"`;
}

async function installWindows(exe, iconPath) {
  for (const ext of EXTENSIONS) {
    const base = `${REG_ROOT}\\${ext}\\shell\\${KEY_NAME}`;
    await run('reg', ['add', base, '/ve', '/t', 'REG_SZ', '/d', MENU_LABEL, '/f']);
    await run('reg', ['add', base, '/v', 'MUIVerb', '/t', 'REG_SZ', '/d', MENU_LABEL, '/f']);
    await run('reg', ['add', base, '/v', 'subcommands', '/t', 'REG_SZ', '/d', '', '/f']);
    if (iconPath) await run('reg', ['add', base, '/v', 'Icon', '/t', 'REG_SZ', '/d', iconPath, '/f']);

    for (const item of ITEMS) {
      const sub = `${base}\\shell\\${item.mode}`;
      await run('reg', ['add', sub, '/ve', '/t', 'REG_SZ', '/d', item.label, '/f']);
      if (iconPath) await run('reg', ['add', sub, '/v', 'Icon', '/t', 'REG_SZ', '/d', iconPath, '/f']);
      await run('reg', ['add', `${sub}\\command`, '/ve', '/t', 'REG_SZ', '/d', winCommand(exe, item.mode), '/f']);
    }
  }
}

async function uninstallWindows() {
  for (const ext of EXTENSIONS) {
    try { await run('reg', ['delete', `${REG_ROOT}\\${ext}\\shell\\${KEY_NAME}`, '/f']); } catch { /* not present */ }
  }
}

async function isInstalledWindows() {
  try {
    await run('reg', ['query', `${REG_ROOT}\\.docx\\shell\\${KEY_NAME}`]);
    return true;
  } catch { return false; }
}

/* ---------------------------------- macOS --------------------------------- */

function servicesDir() { return path.join(os.homedir(), 'Library', 'Services'); }

function workflowPlist(name) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSServices</key>
  <array>
    <dict>
      <key>NSMenuItem</key>
      <dict><key>default</key><string>${name}</string></dict>
      <key>NSMessage</key><string>runWorkflowAsService</string>
      <key>NSRequiredContext</key>
      <dict><key>NSApplicationIdentifier</key><string>com.apple.finder</string></dict>
      <key>NSSendFileTypes</key>
      <array>
        <string>org.openxmlformats.wordprocessingml.document</string>
        <string>com.microsoft.word.doc</string>
        <string>org.openxmlformats.wordprocessingml.document.macroenabled</string>
      </array>
    </dict>
  </array>
</dict>
</plist>`;
}

function workflowDocument(script) {
  const encoded = script
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AMApplicationBuild</key><string>521</string>
  <key>AMApplicationVersion</key><string>2.10</string>
  <key>AMDocumentVersion</key><string>2</string>
  <key>actions</key>
  <array>
    <dict>
      <key>action</key>
      <dict>
        <key>AMAccepts</key>
        <dict>
          <key>Container</key><string>List</string>
          <key>Optional</key><false/>
          <key>Types</key><array><string>com.apple.applescript.object</string></array>
        </dict>
        <key>AMActionVersion</key><string>2.0.3</string>
        <key>AMApplication</key><array><string>Automator</string></array>
        <key>AMParameterProperties</key>
        <dict>
          <key>COMMAND_STRING</key><dict/>
          <key>CheckedForUserDefaultShell</key><dict/>
          <key>inputMethod</key><dict/>
          <key>shell</key><dict/>
          <key>source</key><dict/>
        </dict>
        <key>AMProvides</key>
        <dict>
          <key>Container</key><string>List</string>
          <key>Types</key><array><string>com.apple.applescript.object</string></array>
        </dict>
        <key>ActionBundlePath</key><string>/System/Library/Automator/Run Shell Script.action</string>
        <key>ActionName</key><string>Run Shell Script</string>
        <key>ActionParameters</key>
        <dict>
          <key>COMMAND_STRING</key><string>${encoded}</string>
          <key>CheckedForUserDefaultShell</key><true/>
          <key>inputMethod</key><integer>1</integer>
          <key>shell</key><string>/bin/bash</string>
          <key>source</key><string></string>
        </dict>
        <key>BundleIdentifier</key><string>com.apple.Automator.RunShellScript</string>
        <key>CFBundleVersion</key><string>2.0.3</string>
        <key>CanShowSelectedItemsWhenRun</key><false/>
        <key>CanShowWhenRun</key><true/>
        <key>Category</key><array><string>AMCategoryUtilities</string></array>
        <key>Class Name</key><string>RunShellScriptAction</string>
        <key>InputUUID</key><string>1D6D5C1B-0000-4000-8000-000000000001</string>
        <key>Keywords</key><array><string>Shell</string></array>
        <key>OutputUUID</key><string>1D6D5C1B-0000-4000-8000-000000000002</string>
        <key>UUID</key><string>1D6D5C1B-0000-4000-8000-000000000003</string>
        <key>UnlocalizedApplications</key><array><string>Automator</string></array>
        <key>arguments</key>
        <dict>
          <key>0</key>
          <dict>
            <key>default value</key><string></string>
            <key>name</key><string>inputMethod</string>
            <key>required</key><string>0</string>
            <key>type</key><string>0</string>
            <key>uuid</key><string>0</string>
          </dict>
        </dict>
        <key>isViewVisible</key><integer>1</integer>
        <key>location</key><string>309.000000:253.000000</string>
        <key>nibPath</key><string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
      </dict>
      <key>isViewVisible</key><integer>1</integer>
    </dict>
  </array>
  <key>connectors</key><dict/>
  <key>workflowMetaData</key>
  <dict>
    <key>serviceInputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject</string>
    <key>serviceOutputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
    <key>serviceApplicationBundleID</key><string>com.apple.finder</string>
    <key>serviceProcessesInput</key><integer>0</integer>
    <key>workflowTypeIdentifier</key><string>com.apple.Automator.servicesMenu</string>
  </dict>
</dict>
</plist>`;
}

function macScript(exe, mode) {
  // Automator passes the selection as positional arguments (inputMethod = 1),
  // so "$@" carries every file, spaces, quotes, unicode and all.
  return [
    '#!/bin/bash',
    `EXE=${JSON.stringify(exe)}`,
    'if [ ! -x "$EXE" ]; then',
    '  osascript -e \'display alert "Fatty Lumpkin Doc Compare was not found" message "The app has moved or been removed. Open it once from your Applications folder and the right-click menu will be repaired automatically."\' >/dev/null 2>&1',
    '  exit 1',
    'fi',
    `"$EXE" --mode=${mode} "$@" >/dev/null 2>&1 &`,
    'exit 0',
  ].join('\n');
}

async function installMac(exe) {
  const dir = servicesDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const item of ITEMS) {
    const wf = path.join(dir, item.service + '.workflow');
    const contents = path.join(wf, 'Contents');
    fs.mkdirSync(contents, { recursive: true });
    fs.writeFileSync(path.join(contents, 'Info.plist'), workflowPlist(item.service));
    fs.writeFileSync(path.join(contents, 'document.wflow'), workflowDocument(macScript(exe, item.mode)));
  }
  try { await run('/System/Library/CoreServices/pbs', ['-flush']); } catch { /* best effort */ }
}

async function uninstallMac() {
  for (const item of ITEMS) {
    const wf = path.join(servicesDir(), item.service + '.workflow');
    try { fs.rmSync(wf, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { await run('/System/Library/CoreServices/pbs', ['-flush']); } catch { /* ignore */ }
}

function isInstalledMac() {
  return ITEMS.every((i) => fs.existsSync(path.join(servicesDir(), i.service + '.workflow')));
}

/* --------------------------------- public --------------------------------- */

async function install(exe, iconPath) {
  if (process.platform === 'win32') return installWindows(exe, iconPath);
  if (process.platform === 'darwin') return installMac(exe);
  throw new Error('The right-click menu is only available on Windows and macOS.');
}

async function uninstall() {
  if (process.platform === 'win32') return uninstallWindows();
  if (process.platform === 'darwin') return uninstallMac();
}

async function isInstalled() {
  if (process.platform === 'win32') return isInstalledWindows();
  if (process.platform === 'darwin') return isInstalledMac();
  return false;
}

module.exports = { install, uninstall, isInstalled, ITEMS, MENU_LABEL };
