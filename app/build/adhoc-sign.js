// Ad-hoc code signing for the macOS build.
//
// electron-builder rewrites Electron's own binaries while packaging, which
// invalidates the ad-hoc signature they ship with. A quarantined app with a
// broken signature is reported by Gatekeeper as "damaged and can't be opened",
// whose only button is Move to Trash - an alarming message for a perfectly
// good download, and one that can only be cleared from a terminal.
//
// Re-signing with the ad-hoc identity ("-") costs nothing and needs no Apple
// certificate. It does not make the app trusted - it is still unsigned as far
// as notarisation is concerned - but Gatekeeper then shows the ordinary
// "macOS cannot verify this app is free of malware" prompt, which the user
// clears with System Settings -> Privacy & Security -> Open Anyway.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const app = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  console.log(`  * ad-hoc signing  ${app}`);
  execFileSync('codesign', [
    '--force', '--deep', '--sign', '-', '--timestamp=none', app,
  ], { stdio: 'inherit' });

  try {
    execFileSync('codesign', ['--verify', '--strict', '--verbose=2', app], { stdio: 'inherit' });
    console.log('  * ad-hoc signature verified');
  } catch {
    console.log('  * ad-hoc signature did not verify strictly (continuing)');
  }
};
