const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, desktopCapturer, screen, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { io } = require('socket.io-client');
const { mouse, keyboard, Key, Button, Point } = require('@nut-tree-fork/nut-js');
const { readConfig, saveConfig, readAddressBook, saveAddressBook } = require('./config');
const { agentHeartbeatFilePath, configDirectory, isMachineWideConfig } = require('./config-path');
const mac = require('./mac');

const PRODUCT = 'Bainsla Remote';
const DEFAULT_SERVER = process.env.KVDESK_SERVER_URL || 'https://remote.bainslamusic.com';
const SERVICE_MODE = process.argv.includes('--service');
const SESSION_AGENT_MODE = process.argv.includes('--host');
const HEARTBEAT_INTERVAL = 5000;
const HEARTBEAT_STALE_AFTER = 15000;
mouse.config.autoDelayMs = 0;
keyboard.config.autoDelayMs = 0;
let mainWindow;
let tray;
let hostSocket;
let supervisorSocket;
let hostStatus = 'Offline';
let inputQueue = Promise.resolve();
let mainRendererReady = false;
let heartbeatTimer;
let supervisorTimer;
let lastHeartbeatValue = '';
let heartbeatWriteFailed = false;
let lastHeartbeatFresh;
let lastTaskRunAt = 0;
let nextSupervisorAttemptAt = 0;
let quitting = false;
let hostIceServers = [];
const requestWindows = new Map();
const pendingRequests = new Map();
const requestTimers = new Map();
const activeSessions = new Map();
const incomingFiles = new Map();
const socketClients = new Map();
const socketOwners = new Map();
const viewerWindows = new Map();
const pendingMainEvents = [];
const lastClick = { button: -1, at: 0, x: 0, y: 0 };
let lastPointer = { x: 0, y: 0 };
let pressedButton = -1;
let pendingDoubleClick = false;
function platformName() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}
function applyAutostart(enabled) {
  if (!mac.IS_MAC) {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--hidden'] });
    return;
  }
  if (!mac.launchAgentSupported()) return;
  if (!enabled) return mac.removeLaunchAgent();
  if (mac.launchedByLaunchd()) return mac.writeLaunchAgent();
  if (mac.handOverToLaunchAgent(true)) {
    quitting = true;
    app.exit(0);
  }
}
function safeLogText(value) {
  return String(value ?? 'unknown')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/(password|secret|token|hash)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]')
    .replace(/(["']?(?:password|secret|token|hash)[^"']*["']\s*:\s*["'])[^"']*/gi, '$1[redacted]')
    .replace(/([?&](?:password|secret|token|hash|devicesecret|unattendedpassword)=)[^&\s]*/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[redacted]@')
    .slice(0, 500);
}
function logEvent(message) {
  try {
    const directory = configDirectory();
    const file = path.join(directory, 'kvdesk.log');
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
      const rotated = path.join(directory, 'kvdesk.log.1');
      fs.rmSync(rotated, { force: true });
      fs.renameSync(file, rotated);
    }
    const mode = SERVICE_MODE ? 'service' : SESSION_AGENT_MODE ? 'host' : 'app';
    const line = `${new Date().toISOString()} [${process.pid} ${mode}] ${safeLogText(message)}\n`;
    fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
  } catch {}
}
function sessionIdPrefix(sessionId) {
  return String(sessionId || '').slice(0, 8);
}
function serverRoot(value = readConfig().serverUrl) {
  return String(value || DEFAULT_SERVER).replace(/\/+$/, '');
}
function socketOrigin(value = readConfig().serverUrl) {
  try { return new URL(value || DEFAULT_SERVER).origin; } catch { return ''; }
}
function cookiePath(value = readConfig().serverUrl) {
  try { return new URL(value).pathname.replace(/\/+$/, ''); } catch { return ''; }
}
function sendToMain(name, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainRendererReady) {
    pendingMainEvents.push([name, payload]);
    return;
  }
  mainWindow.webContents.send(name, payload);
}
function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  const active = activeSessions.size > 0;
  if (mac.IS_MAC) {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'trayTemplate.png'));
    icon.setTemplateImage(true);
    tray.setImage(icon);
    tray.setTitle(active ? ' ● Remote session active' : '');
  } else {
    const iconPath = path.join(__dirname, 'build', active ? 'icon-active.png' : 'icon.png');
    tray.setImage(nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 }));
  }
  tray.setToolTip(active ? 'Bainsla Remote — remote session active' : 'Bainsla Remote');
  const menu = [
    { label: 'Open', click: showMainWindow },
    { label: 'Copy ID', click: () => {
      const config = readConfig();
      if (config.id) clipboard.writeText(config.id);
    } }
  ];
  if (active) {
    menu.push({ type: 'separator' });
    menu.push({
      label: 'Disconnect all',
      click: () => {
        for (const sessionId of [...activeSessions.keys()]) disconnectHostSession(sessionId);
      }
    });
  }
  menu.push({ type: 'separator' }, { label: 'Quit', click: () => { quitting = true; app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(menu));
}
function updateHostSessions() {
  sendToMain('host-sessions', [...activeSessions.entries()]);
  updateTray();
}
function removeHostSession(sessionId, reason) {
  if (!activeSessions.delete(sessionId)) return;
  updateHostSessions();
  sendToMain('session-kill', { sessionId, reason });
}
function disconnectHostSession(sessionId) {
  if (!activeSessions.has(sessionId)) return;
  logEvent(`session in-app disconnect id=${sessionIdPrefix(sessionId)}`);
  hostSocket?.emit('session:end', { sessionId, reason: 'host_disconnect' });
  removeHostSession(sessionId, 'host_disconnect');
}
function endAllHostSessions(reason = 'disconnect') {
  const sessionIds = [...activeSessions.keys()];
  activeSessions.clear();
  logEvent(`session local cleanup reason=${safeLogText(reason)} count=${sessionIds.length}`);
  updateHostSessions();
  for (const sessionId of sessionIds) sendToMain('session-kill', { sessionId, reason });
}
let updater = null;
let updateState = { state: 'idle' };
function setUpdateState(next) {
  updateState = next;
  sendToMain('update-state', updateState);
}
function getUpdater() {
  if (updater || !app.isPackaged || process.platform !== 'win32') return updater;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (error) {
    logEvent(`updater unavailable ${safeLogText(error.message)}`);
    return null;
  }
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.on('update-available', (info) => setUpdateState({ state: 'available', version: info.version }));
  updater.on('update-not-available', () => setUpdateState({ state: 'latest', version: app.getVersion() }));
  updater.on('download-progress', (progress) => setUpdateState({ state: 'downloading', version: updateState.version, percent: Math.round(progress.percent || 0) }));
  updater.on('update-downloaded', (info) => {
    setUpdateState({ state: 'installing', version: info.version });
    logEvent(`update install version=${safeLogText(info.version)}`);
    quitting = true;
    setTimeout(() => updater.quitAndInstall(true, true), 500);
  });
  updater.on('error', (error) => {
    logEvent(`update error ${safeLogText(error?.message || String(error))}`);
    setUpdateState({ state: 'error', version: updateState.version, message: 'Update failed. Check your internet and try again.' });
  });
  return updater;
}
async function checkForUpdate() {
  const instance = getUpdater();
  if (!instance) return { state: 'unsupported' };
  if (['downloading', 'installing'].includes(updateState.state)) return updateState;
  try { await instance.checkForUpdates(); } catch { /* reported via error event */ }
  return updateState;
}
function createMainWindow(hidden = false) {
  mainWindow = new BrowserWindow({
    width: 900, height: 600, minWidth: 720, minHeight: 500, show: !hidden,
    title: PRODUCT, backgroundColor: '#0f172a',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  mainRendererReady = false;
  mainWindow.webContents.once('did-finish-load', () => {
    mainRendererReady = true;
    for (const [name, payload] of pendingMainEvents.splice(0)) mainWindow.webContents.send(name, payload);
    mainWindow.webContents.send('host-sessions', [...activeSessions.entries()]);
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}
function openViewer(target, password = '') {
  const key = String(target).toLowerCase();
  const existing = viewerWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return existing;
  }
  const viewer = new BrowserWindow({
    width: 1200, height: 800, minWidth: 760, minHeight: 520, title: 'Bainsla Remote · Viewer',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  viewerWindows.set(key, viewer);
  const query = { id: target, password };
  if (process.argv.some((arg) => arg === '--relay' || arg === '--relay=1')) query.relay = '1';
  viewer.loadFile(path.join(__dirname, 'viewer.html'), { query });
  viewer.on('closed', () => viewerWindows.delete(key));
  return viewer;
}
function destroyTray() {
  if (tray && !tray.isDestroyed()) { tray.destroy(); }
  tray = null;
}
function ensureTray() {
  if (readConfig().hidden) { destroyTray(); return; }
  if (tray && !tray.isDestroyed()) { updateTray(); return; }
  createTray();
}
function createTray() {
  if (readConfig().hidden) { destroyTray(); return; }
  let icon;
  if (mac.IS_MAC) {
    // Template image: macOS tints it for light and dark menu bars; @2x is picked up for Retina.
    icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'trayTemplate.png'));
    icon.setTemplateImage(true);
  } else {
    icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 18, height: 18 });
  }
  tray = new Tray(icon);
  updateTray();
  tray.on('double-click', showMainWindow);
  if (!mac.IS_MAC) tray.on('click', showMainWindow);
}
function connectHost(caller = 'unspecified') {
  logEvent(`connectHost caller=${caller}`);
  endAllHostSessions('disconnect');
  hostSocket?.disconnect();
  let blocked = false;
  hostStatus = 'Connecting';
  sendToMain('host-status', { status: 'Connecting' });
  const socket = io(socketOrigin(), {
    path: `${cookiePath()}/socket.io` || '/socket.io',
    reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 10000
  });
  hostSocket = socket;
  const reportStatus = (status, id) => {
    if (hostSocket === socket) {
      hostStatus = status;
      sendToMain('host-status', { status, ...(id ? { id } : {}) });
    }
  };
  socket.on('connect', () => {
    logEvent(`host socket connect id=${socket.id || 'unknown'}`);
    const currentConfig = readConfig();
    blocked = false;
    reportStatus('Connecting');
    socket.emit('agent:hello', {
      ...(currentConfig.id && currentConfig.secret ? { id: currentConfig.id, secret: currentConfig.secret } : {}),
      role: 'agent', name: currentConfig.deviceName,
      platform: platformName(),
      os: `${process.platform} ${require('node:os').release()}`, version: app.getVersion()
    }, (result) => {
      if (result?.ok) logEvent(`host agent:hello ok=true id=${safeLogText(result.id || 'unknown')}`);
      else logEvent(`host agent:hello ok=false error=${safeLogText(result?.error || result?.reason || 'unknown')}`);
      if (!result?.ok) {
        blocked = result?.error === 'blocked';
        reportStatus(blocked ? 'Blocked' : 'Offline');
        if (blocked) socket.disconnect();
        return;
      }
      if (currentConfig.id && result.id !== currentConfig.id) return reportStatus('Offline');
      if (result.secret) saveConfig({ ...currentConfig, id: result.id, secret: result.secret });
      hostIceServers = result.iceServers || [];
      reportStatus('Online', result.id);
      if (SESSION_AGENT_MODE) startSessionAgentHeartbeat();
    });
  });
  socket.on('connect_error', (error) => {
    logEvent(`host socket connect_error message=${safeLogText(error?.message)}`);
    reportStatus(blocked ? 'Blocked' : socket.active ? 'Connecting' : 'Offline');
  });
  socket.on('disconnect', (reason) => {
    logEvent(`host socket disconnect reason=${safeLogText(reason)}`);
    if (hostSocket === socket) endAllHostSessions('disconnect');
    reportStatus(blocked ? 'Blocked' : socket.active ? 'Connecting' : 'Offline');
  });
  socket.on('agent:blocked', () => {
    blocked = true;
    reportStatus('Blocked');
    socket.disconnect();
    stopSessionAgentHeartbeat();
  });
  socket.on('agent:replaced', () => {
    logEvent('host socket agent:replaced');
    if (hostSocket !== socket) return;
    endAllHostSessions('disconnect');
    reportStatus('Connecting');
    if (SESSION_AGENT_MODE) stopSessionAgentHeartbeat();
  });
  socket.on('agent:renamed', ({ name }) => sendToMain('host-name', name));
  socket.on('session:request', (request) => showRequest(request));
  socket.on('signal', (payload) => sendToMain('host-signal', payload));
  socket.on('session:closed', ({ sessionId, reason }) => {
    logEvent(`session:closed id=${sessionIdPrefix(sessionId)} reason=${safeLogText(reason)}`);
    removeHostSession(sessionId, reason);
  });
  socket.on('session:kill', ({ sessionId, reason }) => {
    logEvent(`session:kill id=${sessionIdPrefix(sessionId)} reason=${safeLogText(reason)}`);
    removeHostSession(sessionId, reason);
  });
}

function agentHeartbeatIsFresh() {
  let age = null;
  let fresh = false;
  try {
    const timestamp = Number(fs.readFileSync(agentHeartbeatFilePath(), 'utf8'));
    age = Date.now() - timestamp;
    fresh = Number.isFinite(timestamp) && age >= 0 && age <= HEARTBEAT_STALE_AFTER;
  } catch {}
  if (lastHeartbeatFresh !== fresh) {
    logEvent(`supervisor heartbeat ${fresh ? 'fresh' : 'stale'} ageMs=${Number.isFinite(age) ? age : 'unknown'}`);
    lastHeartbeatFresh = fresh;
  }
  return fresh;
}

function writeAgentHeartbeat() {
  const file = agentHeartbeatFilePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    lastHeartbeatValue = String(Date.now());
    fs.writeFileSync(file, lastHeartbeatValue);
    if (heartbeatWriteFailed) {
      heartbeatWriteFailed = false;
      logEvent('heartbeat write recovered');
    }
  } catch (error) {
    console.warn(`Could not write session-agent heartbeat: ${error.message}`);
    if (!heartbeatWriteFailed) {
      heartbeatWriteFailed = true;
      logEvent(`heartbeat write failed code=${safeLogText(error.code || error.name || 'unknown')}`);
    }
  }
}

function startSessionAgentHeartbeat() {
  if (heartbeatTimer) return;
  logEvent('heartbeat started');
  writeAgentHeartbeat();
  heartbeatTimer = setInterval(writeAgentHeartbeat, HEARTBEAT_INTERVAL);
  heartbeatTimer.unref();
}

function stopSessionAgentHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    logEvent('heartbeat stopped');
  }
  heartbeatTimer = null;
  if (!lastHeartbeatValue) return;
  try {
    const file = agentHeartbeatFilePath();
    if (fs.readFileSync(file, 'utf8') === lastHeartbeatValue) fs.unlinkSync(file);
  } catch {}
  lastHeartbeatValue = '';
}

function runSessionAgentTask() {
  if (process.platform !== 'win32') {
    logEvent('supervisor runSessionAgentTask skipped=unsupported_platform');
    return;
  }
  const now = Date.now();
  if (now - lastTaskRunAt < HEARTBEAT_STALE_AFTER) {
    logEvent('supervisor runSessionAgentTask skipped=throttled');
    return;
  }
  lastTaskRunAt = now;
  // Node cannot use CreateProcessAsUser; Task Scheduler launches the agent in the interactive desktop session.
  execFile('schtasks', ['/run', '/tn', 'Bainsla Remote Agent'], (error) => {
    if (error) {
      if (Number.isInteger(error.code)) logEvent(`supervisor runSessionAgentTask exitCode=${error.code}`);
      else logEvent(`supervisor runSessionAgentTask error=${safeLogText(error.code || error.message)}`);
      console.warn(`Could not start Bainsla Remote Agent task: ${error.message}`);
    } else {
      logEvent('supervisor runSessionAgentTask exitCode=0');
    }
  });
}

function connectSupervisor() {
  if (supervisorSocket) return;
  logEvent('supervisor socket connecting');
  const config = readConfig();
  const socket = io(socketOrigin(config.serverUrl), {
    path: `${cookiePath(config.serverUrl)}/socket.io` || '/socket.io',
    reconnection: false, timeout: 10000
  });
  supervisorSocket = socket;
  const relinquish = (reason = 'unspecified') => {
    logEvent(`supervisor relinquish reason=${safeLogText(reason)}`);
    if (supervisorSocket === socket) supervisorSocket = null;
    socket.disconnect();
  };
  socket.on('connect', () => {
    logEvent(`supervisor socket connected id=${socket.id || 'unknown'}`);
    socket.emit('agent:hello', {
      ...(config.id && config.secret ? { id: config.id, secret: config.secret } : {}),
      role: 'service', name: config.deviceName,
      platform: platformName(),
      os: `${process.platform} ${require('node:os').release()}`, version: app.getVersion()
    }, (result) => {
      const helloResult = result?.ok ? 'ok' : result?.reason === 'agent_active' ? 'agent_active' : 'error';
      logEvent(`supervisor hello result=${helloResult}${helloResult === 'error' ? ` code=${safeLogText(result?.error || result?.reason || 'unknown')}` : ''}`);
      if (!result?.ok) {
        if (result?.reason === 'agent_active') nextSupervisorAttemptAt = Date.now() + HEARTBEAT_STALE_AFTER;
        relinquish(result?.reason || result?.error || 'hello_rejected');
        return;
      }
      if (config.id && result.id !== config.id) return relinquish('id_mismatch');
      if (result.secret) saveConfig({ ...config, id: result.id, secret: result.secret });
      hostIceServers = result.iceServers || [];
      if (!agentHeartbeatIsFresh()) runSessionAgentTask();
    });
  });
  socket.on('session:request', () => {
    if (!agentHeartbeatIsFresh()) runSessionAgentTask();
  });
  socket.on('agent:replaced', () => relinquish('agent:replaced'));
  socket.on('disconnect', (reason) => {
    logEvent(`supervisor socket disconnect reason=${safeLogText(reason)}`);
    if (supervisorSocket === socket) supervisorSocket = null;
  });
  socket.on('connect_error', (error) => {
    logEvent(`supervisor socket connect_error message=${safeLogText(error?.message)}`);
    console.warn(`Service supervisor connection failed: ${error.message}`);
    if (supervisorSocket === socket) supervisorSocket = null;
  });
}

function startServiceSupervisor() {
  logEvent('supervisor started');
  const supervise = () => {
    if (agentHeartbeatIsFresh()) {
      supervisorSocket?.disconnect();
      supervisorSocket = null;
      return;
    }
    if (!supervisorSocket && Date.now() >= nextSupervisorAttemptAt) connectSupervisor();
  };
  supervise();
  supervisorTimer = setInterval(supervise, HEARTBEAT_INTERVAL);
  supervisorTimer.unref();
}
function showRequest(request) {
  const config = readConfig();
  pendingRequests.set(request.sessionId, request);
  if (!mac.macPermissions().screen) {
    answerRequest(request.sessionId, false, 'mac_screen_recording_not_allowed');
    sendToMain('toast', 'Connection refused: allow Screen Recording for Bainsla Remote in System Settings.');
    return;
  }
  if (config.passwordHash && config.passwordSalt) {
    if (!request.password) {
      logEvent(`session request mode=rejected id=${sessionIdPrefix(request.sessionId)} reason=password_required`);
      answerRequest(request.sessionId, false, 'password_required');
      return;
    }
    const actual = crypto.scryptSync(String(request.password), config.passwordSalt, 64);
    const expected = Buffer.from(config.passwordHash, 'hex');
    const valid = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    logEvent(`session request mode=${valid ? 'auto-accept' : 'rejected'} id=${sessionIdPrefix(request.sessionId)} reason=${valid ? 'password_verified' : 'bad_password'}`);
    answerRequest(request.sessionId, valid, valid ? '' : 'bad_password', undefined, valid ? 'unattended' : undefined);
    return;
  }
  logEvent(`session request mode=popup id=${sessionIdPrefix(request.sessionId)} reason=no_password_configured`);
  const requestWindow = new BrowserWindow({
    width: 370, height: 360, resizable: false, minimizable: false, maximizable: false,
    alwaysOnTop: true, center: true, title: 'Incoming connection',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  requestWindow.loadFile(path.join(__dirname, 'request.html'), { query: {
    viewer: request.viewerName || 'Viewer', viewerId: request.viewerId || '',
    unattended: 'false', sessionId: request.sessionId
  } });
  requestWindows.set(request.sessionId, requestWindow);
  requestWindow.on('closed', () => requestWindows.delete(request.sessionId));
  requestTimers.set(request.sessionId, setTimeout(() => answerRequest(request.sessionId, false, 'timeout'), 30000));
}
async function answerRequest(sessionId, accept, reason = 'rejected', permissions, mode) {
  const req = pendingRequests.get(sessionId);
  if (!req) return;
  clearTimeout(requestTimers.get(sessionId));
  requestTimers.delete(sessionId);
  pendingRequests.delete(sessionId);
  let iceServers = hostIceServers;
  if (accept && !mac.macPermissions().accessibility) {
    const config = readConfig();
    permissions = { clipboard: config.allowClipboard, files: config.allowFiles, ...(permissions || {}), control: false };
    sendToMain('toast', 'View only: allow Accessibility for Bainsla Remote to enable remote control.');
  }
  if (accept) {
    try {
      const response = await fetch(`${serverRoot()}/api/ice`);
      if (response.ok) iceServers = (await response.json()).iceServers;
    } catch {}
  }
  hostSocket?.emit('session:answer', {
    sessionId: req.sessionId, accept, reason, mode, permissions: permissions || {
      control: readConfig().allowControl, clipboard: readConfig().allowClipboard, files: readConfig().allowFiles
    }
  });
  if (accept) {
    activeSessions.set(req.sessionId, req.viewerName || 'Remote user');
    logEvent(`session accepted id=${sessionIdPrefix(req.sessionId)} viewer=${safeLogText(req.viewerName || 'Remote user')}`);
    updateHostSessions();
    sendToMain('host-accepted', {
      sessionId: req.sessionId, viewerName: req.viewerName,
      permissions: permissions || { control: readConfig().allowControl, clipboard: readConfig().allowClipboard, files: readConfig().allowFiles },
      iceServers, request: req
    });
  }
  requestWindows.get(req.sessionId)?.close();
  requestWindows.delete(req.sessionId);
}
function makeViewerSocket(clientId, options) {
  const config = readConfig();
  const socket = io(socketOrigin(), {
    path: `${cookiePath()}/socket.io` || '/socket.io',
    reconnection: true, reconnectionDelayMax: 10000, ...options
  });
  socketClients.set(clientId, socket);
  socket.onAny((event, ...args) => {
    const acknowledgement = args.at(-1);
    const data = typeof acknowledgement === 'function' ? args.slice(0, -1) : args;
    const recipient = socketOwners.get(clientId);
    if (recipient && !recipient.isDestroyed()) recipient.send(`socket-event:${clientId}:${event}`, ...data);
  });
  socket.on('connect', () => {
    const recipient = socketOwners.get(clientId);
    if (recipient && !recipient.isDestroyed()) recipient.send(`socket-event:${clientId}:connect`);
  });
  socket.on('disconnect', (reason) => {
    const recipient = socketOwners.get(clientId);
    if (recipient && !recipient.isDestroyed()) recipient.send(`socket-event:${clientId}:disconnect`, reason);
  });
  return socket;
}
function destroyViewerSocket(clientId) {
  socketClients.get(clientId)?.disconnect();
  socketClients.delete(clientId);
  socketOwners.delete(clientId);
}

function registerIpc() {
  ipcMain.handle('config:get', () => readConfig());
  ipcMain.handle('host:status', () => ({ status: hostStatus, id: readConfig().id }));
  ipcMain.handle('permissions:get', () => ({
    ...mac.macPermissions(),
    autostartSupported: !mac.IS_MAC || !app.isPackaged || mac.launchAgentSupported()
  }));
  ipcMain.handle('permissions:open', (_event, kind) => mac.openPermissionPane(kind));
  ipcMain.handle('app:restart', () => mac.restartApp());
  ipcMain.handle('book:get', () => readAddressBook());
  ipcMain.handle('book:save', (_event, entries) => saveAddressBook(entries));
  ipcMain.handle('viewer:open', (_event, target, password) => {
    openViewer(target, password);
    return true;
  });
  ipcMain.handle('password:hash', (_event, password, salt) => new Promise((resolve, reject) => {
    crypto.scrypt(String(password), String(salt), 64, (error, key) => error ? reject(error) : resolve(key.toString('hex')));
  }));
  ipcMain.handle('config:save', (_event, patch) => {
    const previous = readConfig();
    const next = saveConfig({ ...previous, ...patch });
    if ('hidden' in patch) ensureTray();
    if (!mac.IS_MAC || 'autostart' in patch) applyAutostart(next.autostart);
    if (hostSocket && patch.serverUrl && serverRoot(patch.serverUrl) !== serverRoot(previous.serverUrl)) connectHost('config:save serverUrl changed');
    if (hostSocket && patch.deviceName) hostSocket.emit('agent:update', { name: next.deviceName });
    return next;
  });
  ipcMain.handle('host:connect', async (_event, configPatch = {}) => {
    const config = saveConfig({ ...readConfig(), ...configPatch });
    if (!mac.IS_MAC) applyAutostart(config.autostart);
    if (!config.id || !config.secret) {
      const socket = io(socketOrigin(config.serverUrl), {
        path: `${cookiePath(config.serverUrl)}/socket.io` || '/socket.io', reconnection: false, timeout: 10000
      });
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Connection timed out')), 12000);
        socket.once('connect', () => socket.emit('agent:hello', {
          role: 'agent',
          name: config.deviceName, platform: platformName(),
          os: `${process.platform} ${require('node:os').release()}`, version: app.getVersion()
        }, (response) => { clearTimeout(timer); resolve(response); }));
        socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
      }).finally(() => socket.disconnect());
      if (!result?.ok) throw new Error(result?.error || 'Registration failed');
      hostIceServers = result.iceServers || [];
      saveConfig({ ...config, id: result.id, secret: result.secret });
    }
    connectHost('host:connect');
    return readConfig();
  });
  ipcMain.handle('screens:list', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    const displays = screen.getAllDisplays();
    return sources.map((source, index) => {
      const display = displays.find((item) => String(item.id) === String(source.display_id)) || displays[index] || displays[0];
      return { id: source.id, sourceId: source.id, name: source.name, displayId: display.id,
        x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height,
        primary: display.id === screen.getPrimaryDisplay().id };
    });
  });
  ipcMain.handle('input:dispatch', (_event, message) => {
    const operation = inputQueue.then(async () => {
      const display = screen.getAllDisplays().find((d) => String(d.id) === String(message.displayId)) || screen.getPrimaryDisplay();
      const x = Math.round(display.bounds.x + message.x * display.bounds.width);
      const y = Math.round(display.bounds.y + message.y * display.bounds.height);
      const button = [Button.LEFT, Button.MIDDLE, Button.RIGHT][message.b] || Button.LEFT;
      if (message.t === 'mm') {
        // Windows injects physical pixels. macOS CGEvents (Retina included) and X11 use the same
        // global logical points as Electron's DIP display bounds, so no scaling is applied there.
        const position = process.platform === 'win32' ? screen.dipToScreenPoint({ x, y }) : { x, y };
        lastPointer = position;
        // macOS only treats a move as a drag (text selection, window moves) when it is a drag event.
        if (mac.IS_MAC && pressedButton === 0) require('@nut-tree-fork/libnut/dist/import_libnut').libnut.dragMouse(position.x, position.y);
        else await mouse.setPosition(new Point(position.x, position.y));
      }
      if (message.t === 'md') {
        // macOS needs an explicit click count; separate down/up pairs never form a double-click.
        const now = Date.now();
        pendingDoubleClick = mac.IS_MAC && lastClick.button === message.b && now - lastClick.at < 500
          && Math.abs(lastClick.x - lastPointer.x) <= 4 && Math.abs(lastClick.y - lastPointer.y) <= 4;
        if (!pendingDoubleClick) {
          pressedButton = message.b;
          await mouse.pressButton(button);
        }
      }
      if (message.t === 'mu') {
        if (pendingDoubleClick) {
          pendingDoubleClick = false;
          lastClick.at = 0;
          await mouse.doubleClick(button);
        } else {
          pressedButton = -1;
          Object.assign(lastClick, { button: message.b, at: Date.now(), x: lastPointer.x, y: lastPointer.y });
          await mouse.releaseButton(button);
        }
      }
      if (message.t === 'wh') {
        if (message.dy > 0) await mouse.scrollDown(Math.max(1, Math.round(message.dy / 40)));
        else if (message.dy < 0) await mouse.scrollUp(Math.max(1, Math.round(-message.dy / 40)));
        if (message.dx > 0) await mouse.scrollRight(Math.max(1, Math.round(message.dx / 40)));
        else if (message.dx < 0) await mouse.scrollLeft(Math.max(1, Math.round(-message.dx / 40)));
      }
      if (message.t === 'kd' || message.t === 'ku') {
        const key = nutKey(Key, message.code);
        if (key) await (message.t === 'kd' ? keyboard.pressKey(key) : keyboard.releaseKey(key));
        else if (message.t === 'kd' && message.key?.length === 1) await keyboard.type(message.key);
      }
      if (message.t === 'combo') {
        if (message.k === 'cad') sendToMain('toast', 'Ctrl+Alt+Delete is unavailable on the secure desktop.');
        if (message.k === 'win') {
          await keyboard.pressKey(Key.LeftSuper);
          await keyboard.releaseKey(Key.LeftSuper);
        }
        if (message.k === 'alt-tab') { await keyboard.pressKey(Key.LeftAlt); await keyboard.pressKey(Key.Tab); await keyboard.releaseKey(Key.Tab); await keyboard.releaseKey(Key.LeftAlt); }
        if (message.k === 'printscreen') {
          await keyboard.pressKey(Key.Print);
          await keyboard.releaseKey(Key.Print);
        }
      }
    });
    inputQueue = operation.catch((error) => sendToMain('toast', `Input unavailable: ${error.message}`));
    return operation.catch(() => false);
  });
  ipcMain.handle('socket:create', (event, { clientId, options }) => {
    socketOwners.set(clientId, event.sender);
    event.sender.once('destroyed', () => destroyViewerSocket(clientId));
    makeViewerSocket(clientId, options);
    return true;
  });
  ipcMain.handle('socket:emit', (event, { clientId, name, args, hasAck }) => {
    const socket = socketClients.get(clientId);
    if (!socket) return null;
    if (!hasAck) {
      socket.emit(name, ...args);
      return true;
    }
    return new Promise((resolve) => {
      socket.timeout(10000).emit(name, ...args, (error, ack) => resolve(error ? null : ack));
    });
  });
  ipcMain.handle('socket:disconnect', (_event, clientId) => {
    destroyViewerSocket(clientId);
  });
  ipcMain.handle('host:emit', (_event, name, payload) => {
    hostSocket?.emit(name, payload);
  });
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('clipboard:write', (_event, text) => clipboard.writeText(String(text || '')));
  ipcMain.handle('file:choose', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog({ properties: ['openFile'] });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    return { path: filePath, name: path.basename(filePath), size: fs.statSync(filePath).size };
  });
  ipcMain.handle('file:read-chunk', (_event, filePath, offset, size) => {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(size, 16 * 1024));
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset);
      return buffer.subarray(0, bytesRead);
    } finally { fs.closeSync(fd); }
  });
  ipcMain.handle('file:start', (_event, id, name) => {
    const directory = path.join(app.getPath('downloads'), 'Bainsla Remote');
    fs.mkdirSync(directory, { recursive: true });
    const safeName = path.basename(String(name || 'file')).replace(/[\\/:*?"<>|]/g, '_');
    const filePath = path.join(directory, safeName);
    const stream = fs.createWriteStream(filePath);
    incomingFiles.set(id, stream);
    return filePath;
  });
  ipcMain.handle('file:write-chunk', async (_event, id, chunk) => {
    const stream = incomingFiles.get(id);
    if (!stream) return false;
    if (!stream.write(Buffer.from(chunk))) await new Promise((resolve) => stream.once('drain', resolve));
    return true;
  });
  ipcMain.handle('file:end', (_event, id) => {
    const stream = incomingFiles.get(id);
    if (!stream) return;
    incomingFiles.delete(id);
    stream.end();
  });
  ipcMain.on('request:answer', (_event, data) => answerRequest(data.sessionId, data.accept, data.reason, data.permissions));
  ipcMain.on('active:send-chat', (_event, data) => sendToMain('host-send-chat', data));
  ipcMain.on('active:chat-open', (_event, sessionId) => sendToMain('host-chat-open', sessionId));
  ipcMain.on('active:send-file', async (_event, sessionId) => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog({ properties: ['openFile'] });
    if (result.canceled || !result.filePaths[0]) return;
    const filePath = result.filePaths[0];
    sendToMain('host-send-file', { sessionId, path: filePath, name: path.basename(filePath), size: fs.statSync(filePath).size });
  });
  ipcMain.on('active:disconnect', (_event, sessionId) => disconnectHostSession(sessionId));
  ipcMain.on('agent:quit', () => { quitting = true; app.quit(); });
  ipcMain.handle('update:version', () => ({ ...updateState, installedVersion: app.getVersion() }));
  ipcMain.handle('update:check', () => checkForUpdate());
  ipcMain.handle('update:install', async () => {
    const instance = getUpdater();
    if (!instance || updateState.state !== 'available') return updateState;
    setUpdateState({ state: 'downloading', version: updateState.version, percent: 0 });
    instance.downloadUpdate().catch(() => {});
    return updateState;
  });
}
function nutKey(Key, code) {
  const map = {
    Enter: 'Return', NumpadEnter: 'Enter', Insert: 'Insert', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Space: 'Space',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    ShiftLeft: 'LeftShift', ShiftRight: 'RightShift', ControlLeft: 'LeftControl', ControlRight: 'RightControl',
    AltLeft: 'LeftAlt', AltRight: 'RightAlt', MetaLeft: 'LeftSuper', MetaRight: 'RightSuper',
    CapsLock: 'CapsLock', PrintScreen: 'Print'
  };
  if (/^Key[A-Z]$/.test(code)) return Key[code.slice(3)];
  if (/^Digit[0-9]$/.test(code)) return Key[`Num${code.slice(5)}`];
  if (/^F([1-9]|1[0-2])$/.test(code)) return Key[code];
  return Key[map[code]];
}

const SHOW_REQUEST_MAX_AGE = 30000;
function showRequestPath() {
  return path.join(app.getPath('userData'), 'show-window.request');
}
// A shortcut-launched copy cannot always wake the running agent through the single-instance message
// (the logon task runs it elevated, and Windows blocks messages from lower-integrity processes), so it
// also leaves a marker file that the running agent polls.
function requestShowWindow() {
  try {
    fs.mkdirSync(path.dirname(showRequestPath()), { recursive: true });
    fs.writeFileSync(showRequestPath(), String(Date.now()));
  } catch {}
}
function consumeShowRequest() {
  try {
    const age = Date.now() - Number(fs.readFileSync(showRequestPath(), 'utf8'));
    fs.rmSync(showRequestPath(), { force: true });
    return age >= 0 && age < SHOW_REQUEST_MAX_AGE;
  } catch {
    return false;
  }
}
function showMainWindow() {
  if (!mainWindow) createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !process.argv.includes('--hidden') && !process.argv.includes('--host')
  && !process.argv.includes('--service') && !mac.IS_MAC) requestShowWindow();
const handedOver = gotLock && mac.IS_MAC && readConfig().autostart
  && mac.handOverToLaunchAgent(!process.argv.includes('--hidden'));
if (!gotLock) app.quit();
else if (handedOver) app.exit(0);
else {
  app.on('second-instance', (_event, argv) => {
    logEvent('second-instance');
    if (argv.includes('--launchd') || argv.includes('--hidden') || argv.includes('--host')) return;
    consumeShowRequest();
    showMainWindow();
  });
  app.on('activate', () => { mainWindow?.show(); mainWindow?.focus(); });
  app.whenReady().then(() => {
    const argvFlags = process.argv.filter((arg) => arg.startsWith('--')).map((arg) => arg.split('=')[0]);
    logEvent(`startup version=${app.getVersion()} argvFlags=${JSON.stringify(argvFlags)} machineConfig=${isMachineWideConfig() ? 'yes' : 'no'}`);
    if (SERVICE_MODE) {
      console.log(`[service] headless supervisor started, windows=${BrowserWindow.getAllWindows().length}`);
      startServiceSupervisor();
      return;
    }
    registerIpc();
    createTray();
    const showRequested = mac.IS_MAC && mac.consumeShowWindow();
    const showRequestedByShortcut = consumeShowRequest();
    createMainWindow(!showRequested && !showRequestedByShortcut && (SESSION_AGENT_MODE || process.argv.includes('--hidden')));
    if (!mac.IS_MAC) setInterval(() => { if (consumeShowRequest()) showMainWindow(); }, 1000).unref?.();
    const config = readConfig();
    if (mac.IS_MAC) {
      if (app.getLoginItemSettings().openAtLogin) app.setLoginItemSettings({ openAtLogin: false });
      if (config.autostart && mac.launchedByLaunchd()) mac.writeLaunchAgent();
      mac.promptMacPermissions();
    } else if (!SESSION_AGENT_MODE) applyAutostart(config.autostart);
    if (SESSION_AGENT_MODE || (config.id && config.secret)) connectHost('startup');
    setTimeout(checkForUpdate, 15000).unref?.();
    setInterval(checkForUpdate, 6 * 60 * 60 * 1000).unref?.();
  });
  if (!SERVICE_MODE) app.on('window-all-closed', (event) => { event?.preventDefault?.(); });
  app.on('before-quit', () => {
    logEvent('before-quit');
    quitting = true;
    hostSocket?.disconnect();
    supervisorSocket?.disconnect();
    if (supervisorTimer) clearInterval(supervisorTimer);
    stopSessionAgentHeartbeat();
    for (const socket of socketClients.values()) socket.disconnect();
  });
}
