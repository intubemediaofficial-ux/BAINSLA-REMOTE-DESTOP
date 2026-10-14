const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Unsigned builds (identity: null) keep Electron's stale signature, which arm64 macOS refuses to run.
// An ad-hoc signature lets Gatekeeper offer "Open Anyway" instead of reporting the app as damaged.
exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
