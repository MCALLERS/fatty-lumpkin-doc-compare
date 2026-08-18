/* Download page behaviour.
   - Point the main button at the installer for the visitor's platform, while
     keeping all three builds visible so a wrong guess costs nothing.
   - Show the install steps for that platform the moment the download starts,
     which is when they are actually needed.
   - Shade the sticky nav once the page scrolls. */
(() => {
  'use strict';

  const REPO = 'https://github.com/MCALLERS/fatty-lumpkin-doc-compare';
  const LATEST = `${REPO}/releases/latest`;
  const VERSION = '1.0.0';
  const asset = (file) => `${LATEST}/download/${file}`;

  const APPLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.2 12.6c0-2.2 1.8-3.3 1.9-3.4-1-1.5-2.6-1.7-3.2-1.7-1.4-.1-2.7.8-3.3.8s-1.7-.8-2.8-.8c-1.5 0-2.8.9-3.6 2.2-1.5 2.6-.4 6.5 1.1 8.6.7 1 1.6 2.2 2.7 2.2s1.5-.7 2.8-.7 1.7.7 2.8.7 1.9-1 2.6-2a9 9 0 0 0 1.2-2.4c-.1 0-2.2-.9-2.2-3.5Z"/><path d="M14.3 5.9c.6-.7 1-1.7.9-2.7-.9 0-2 .6-2.6 1.3-.6.6-1.1 1.6-.9 2.6 1 .1 2-.5 2.6-1.2Z"/></svg>';
  const WINDOWS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5.6 10.4 4.5v6.9H3Zm0 12.8L10.4 19.5v-6.8H3ZM11.6 4.3 21 3v8.4h-9.4Zm0 8.4H21V21l-9.4-1.3Z"/></svg>';
  const DOWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 5-5m-5 5-5-5M4 20h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const BUILDS = {
    macArm: {
      id: 'dl-mac-arm', icon: APPLE,
      label: 'Download for Mac', note: 'Apple Silicon (M1 and later) · .dmg',
      file: `Fatty-Lumpkin-Doc-Compare-${VERSION}-arm64.dmg`,
    },
    macIntel: {
      id: 'dl-mac-intel', icon: APPLE,
      label: 'Download for Mac', note: 'Intel · .dmg',
      file: `Fatty-Lumpkin-Doc-Compare-${VERSION}-x64.dmg`,
    },
    win: {
      id: 'dl-win', icon: WINDOWS,
      label: 'Download for Windows', note: '64-bit installer · .exe',
      file: `Fatty-Lumpkin-Doc-Compare-Setup-${VERSION}.exe`,
    },
  };

  const STEPS = {
    win: [
      'Open <b>Fatty-Lumpkin-Doc-Compare-Setup-1.0.0.exe</b> from your Downloads folder.',
      'Windows shows a blue <b>“Windows protected your PC”</b> box. Click <b>More info</b>, then <b>Run anyway</b>.',
      'Finish the installer — no administrator password is needed.',
      'Select two Word documents, right-click, and choose <b>Redline with Fatty Lumpkin</b>. On Windows 11 it is under <b>Show more options</b>.',
    ],
    mac: [
      'Open the <b>.dmg</b> and drag the pony into <b>Applications</b>.',
      'Double-click the app. macOS refuses the first time — that is expected.',
      'Open <b>System Settings → Privacy &amp; Security</b>, scroll down, and click <b>Open Anyway</b>.',
      'Select two Word documents in Finder, right-click, and look under <b>Quick Actions</b>.',
    ],
  };

  /**
   * Work out the operating system. Deliberately NOT the Mac's architecture:
   * every way of probing that from a browser fails silently on Firefox, on
   * Safari, and with hardware acceleration off, and being served the wrong
   * .dmg produces an app that simply refuses to open. Macs get the Apple
   * Silicon build with the Intel build offered as a visible sibling link.
   */
  function detect() {
    const ua = navigator.userAgent || '';
    const uaPlatform = (navigator.userAgentData && navigator.userAgentData.platform) || '';
    const platform = uaPlatform || navigator.platform || '';
    const touch = navigator.maxTouchPoints || 0;

    if (/Android/i.test(ua)) return 'mobile';
    if (/iPhone|iPod/i.test(ua)) return 'mobile';
    // iPadOS reports itself as a Mac; a Mac with touch points is an iPad.
    if (/iPad/i.test(ua) || (/Mac/i.test(platform) && touch > 1)) return 'mobile';

    if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'win';
    if (/Mac/i.test(platform) || /Mac OS X/i.test(ua)) return 'macArm';
    return null;
  }

  const primary = document.getElementById('dl-primary');
  if (!primary) return;

  // Every build gets a real link, whatever the detection says.
  for (const key of Object.keys(BUILDS)) {
    const el = document.getElementById(BUILDS[key].id);
    if (el) el.href = asset(BUILDS[key].file);
  }

  const detected = detect();
  const build = BUILDS[detected];
  const icon = document.getElementById('dl-primary-icon');
  const label = document.getElementById('dl-primary-label');
  const note = document.getElementById('dl-primary-note');

  if (build) {
    primary.href = asset(build.file);
    icon.innerHTML = build.icon;
    label.textContent = build.label;
    note.textContent = build.note;
    const current = document.getElementById(build.id);
    if (current && current.parentElement) current.parentElement.classList.add('is-current');
  } else if (detected === 'mobile') {
    // The button must not navigate somewhere unhelpful; it hands over the link.
    icon.innerHTML = DOWN;
    label.textContent = 'Copy the link to your computer';
    note.textContent = 'Fatty Lumpkin is a Mac and Windows app';
    primary.href = 'mailto:?subject=Fatty%20Lumpkin%20Doc%20Compare&body=' + encodeURIComponent(location.href);
    primary.removeAttribute('download');
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-quiet btn-small';
    copy.textContent = 'Copy link';
    copy.style.marginLeft = '12px';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(location.href); copy.textContent = 'Copied'; }
      catch { copy.textContent = location.href; }
    });
    primary.after(copy);
  } else {
    icon.innerHTML = DOWN;
    label.textContent = 'Download';
    note.textContent = 'Mac and Windows installers';
  }

  // The install warning matters at the moment the file lands, not 3,000px away.
  const panel = document.getElementById('after-download');
  const steps = document.getElementById('after-steps');
  const title = document.getElementById('after-title');
  const showSteps = (key) => {
    if (!panel || !steps || !title) return;
    const which = key === 'win' ? 'win' : 'mac';
    // Reveal first, then fill: a live region populated while hidden is not
    // announced. And do not assert the download succeeded -- on a managed
    // machine it may well have been blocked.
    panel.hidden = false;
    requestAnimationFrame(() => {
      title.textContent = `If the download started, here is what ${which === 'win' ? 'Windows' : 'macOS'} will ask next`;
      steps.innerHTML = STEPS[which].map((line) => `<li>${line}</li>`).join('')
        + '<li>Nothing in your Downloads folder? Your IT policy may have blocked it — '
        + '<a href="#faq">here is what to ask for</a>.</li>';
      title.setAttribute('tabindex', '-1');
      title.focus({ preventScroll: true });
    });
  };

  primary.addEventListener('click', () => { if (build) showSteps(detected === 'win' ? 'win' : 'mac'); });
  for (const [key, b] of Object.entries(BUILDS)) {
    const el = document.getElementById(b.id);
    if (el) el.addEventListener('click', () => showSteps(key === 'win' ? 'win' : 'mac'));
  }

  // The one command a stuck Mac user has to transcribe exactly.
  for (const block of document.querySelectorAll('code.block')) {
    const row = document.createElement('div');
    row.className = 'copy-row';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-quiet';
    btn.textContent = 'Copy command';
    const ok = document.createElement('span');
    ok.className = 'copy-ok';
    ok.hidden = true;
    ok.textContent = 'Copied';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(block.textContent.trim());
        ok.hidden = false;
        setTimeout(() => { ok.hidden = true; }, 2500);
      } catch { block.focus(); }
    });
    row.append(btn, ok);
    block.after(row);
  }

  const nav = document.querySelector('.nav');
  if (nav) {
    const paint = () => nav.classList.toggle('stuck', window.scrollY > 8);
    paint();
    window.addEventListener('scroll', paint, { passive: true });
  }
})();
