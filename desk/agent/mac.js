const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { app, systemPreferences, shell, desktopCapturer } = require('electron');

const IS_MAC = process.platform === 'darwin';
const LAUNCH_AGENT_LABEL = 'com.kvspt.kvdesk';
const LAUNCHD_FLAG = '--launchd';
const SHOW_MARKER_MAX_AGE = 60000;
const PANES = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
};

function launchAgentPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}
function launchdDomain() {
  return `gui/${process.getuid()}`;
}
function launchdTarget() {
  return `${launchdDomain()}/${LAUNCH_AGENT_LABEL}`;
}
function launchedByLaunchd() {
  return IS_MAC && process.argv.includes(LAUNCHD_FLAG);
}
function appBundlePath() {
  return path.resolve(process.execPath, '..', '..', '..');
}
// Translocated or disk-image copies move or vanish, so a LaunchAgent must not point at them.
function launchAgentSupported() {
  return IS_MAC && app.isPackaged && !/\/AppTranslocation\/|^\/Volumes\//.test(process.execPath);
}
function xml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
}
function launchAgentPlist() {
  const args = [process.execPath, '--hidden', LAUNCHD_FLAG].map((arg) => `    <string>${xml(arg)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
`;
}
function launchctl(...args) {
  try {
    execFileSync('/bin/launchctl', args, { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function launchAgentLoaded() {
  return launchctl('print', launchdTarget());
}
function writeLaunchAgent() {
  const file = launchAgentPath();
  const content = launchAgentPlist();
  let current = '';
  try { current = fs.readFileSync(file, 'utf8'); } catch {}
  if (current === content) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o644 });
  return true;
}
// Called only from an instance launchd does not own: bootout/kickstart would otherwise kill the caller.
function startLaunchAgent() {
  const changed = writeLaunchAgent();
  let loaded = launchAgentLoaded();
  if (loaded && changed) {
    launchctl('bootout', launchdTarget());
    for (let i = 0; i < 20 && launchAgentLoaded(); i += 1) sleepSync(250);
    loaded = false;
  }
  if (!loaded) {
    for (let i = 0; i < 5; i += 1) {
      if (launchctl('bootstrap', launchdDomain(), launchAgentPath())) return true;
      sleepSync(500);
    }
    return false;
  }
  return launchctl('kickstart', launchdTarget());
}
function removeLaunchAgent() {
  try { fs.unlinkSync(launchAgentPath()); } catch {}
  if (!launchAgentLoaded()) return;
  if (launchedByLaunchd()) {
    // bootout terminates this process, so a detached shell does it and reopens the app outside launchd.
    spawn('/bin/sh', ['-c', `sleep 1; /bin/launchctl bootout "$1"; sleep 1; /usr/bin/open "$2"`, 'kvdesk', launchdTarget(), appBundlePath()],
      { detached: true, stdio: 'ignore' }).unref();
  } else {
    launchctl('bootout', launchdTarget());
  }
}
function showMarkerPath() {
  return path.join(app.getPath('userData'), 'show-window');
}
function markShowWindow() {
  try {
    fs.mkdirSync(path.dirname(showMarkerPath()), { recursive: true });
    fs.writeFileSync(showMarkerPath(), String(Date.now()));
  } catch {}
}
function consumeShowWindow() {
  try {
    const age = Date.now() - Number(fs.readFileSync(showMarkerPath(), 'utf8'));
    fs.unlinkSync(showMarkerPath());
    return age >= 0 && age < SHOW_MARKER_MAX_AGE;
  } catch {
    return false;
  }
}
// The launchd-owned instance is the one that gets restarted after a crash, so an instance opened from
// Finder hands over to it: release the single-instance lock, start the job, and exit.
function handOverToLaunchAgent(showWindow) {
  if (!launchAgentSupported() || launchedByLaunchd()) return false;
  if (showWindow) markShowWindow();
  app.releaseSingleInstanceLock();
  if (startLaunchAgent()) return true;
  consumeShowWindow();
  return !app.requestSingleInstanceLock();
}
function restartApp() {
  markShowWindow();
  if (launchedByLaunchd()) {
    spawn('/bin/launchctl', ['kickstart', '-k', launchdTarget()], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  app.relaunch({ args: process.argv.slice(1).filter((arg) => arg !== '--hidden') });
  app.exit(0);
}
function macPermissions() {
  if (!IS_MAC) return { required: false, screen: true, accessibility: true };
  return {
    required: true,
    screen: systemPreferences.getMediaAccessStatus('screen') === 'granted',
    accessibility: systemPreferences.isTrustedAccessibilityClient(false)
  };
}
// Triggers the system prompts once so Bainsla Remote is listed in both Privacy & Security panes.
function promptMacPermissions() {
  const status = macPermissions();
  if (!status.accessibility) systemPreferences.isTrustedAccessibilityClient(true);
  if (status.screen) return;
  // CGRequestScreenCaptureAccess is what adds Bainsla Remote to the Screen Recording list on current macOS.
  try { require('@nut-tree-fork/node-mac-permissions').askForScreenCaptureAccess(); } catch {}
  desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
}
function openPermissionPane(kind) {
  if (PANES[kind]) return shell.openExternal(PANES[kind]);
  return false;
}

module.exports = {
  IS_MAC, LAUNCH_AGENT_LABEL, launchAgentPath, launchAgentSupported, launchedByLaunchd, writeLaunchAgent,
  removeLaunchAgent, handOverToLaunchAgent, consumeShowWindow, restartApp, macPermissions, promptMacPermissions,
  openPermissionPane
};
