const { contextBridge, ipcRenderer } = require('electron');
const clientPrefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let clientCount = 0;

function createSocket(options = {}) {
  const clientId = `${clientPrefix}-${++clientCount}`;
  ipcRenderer.invoke('socket:create', { clientId, options })
    .catch(() => {});
  return clientId;
}
contextBridge.exposeInMainWorld('kv', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  getHostStatus: () => ipcRenderer.invoke('host:status'),
  platform: process.platform,
  getPermissions: () => ipcRenderer.invoke('permissions:get'),
  openPermissionPane: (kind) => ipcRenderer.invoke('permissions:open', kind),
  restartApp: () => ipcRenderer.invoke('app:restart'),
  getBook: () => ipcRenderer.invoke('book:get'),
  saveBook: (entries) => ipcRenderer.invoke('book:save', entries),
  openViewer: (target, password) => ipcRenderer.invoke('viewer:open', target, password),
  hashPassword: (password, salt) => ipcRenderer.invoke('password:hash', password, salt),
  saveConfig: (data) => ipcRenderer.invoke('config:save', data),
  connectHost: (data) => ipcRenderer.invoke('host:connect', data),
  getScreens: () => ipcRenderer.invoke('screens:list'),
  dispatchInput: (data) => ipcRenderer.invoke('input:dispatch', data),
  emitHost: (name, data) => ipcRenderer.invoke('host:emit', name, data),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  chooseFile: () => ipcRenderer.invoke('file:choose'),
  readFileChunk: (filePath, offset, size) => ipcRenderer.invoke('file:read-chunk', filePath, offset, size),
  startFile: (id, name) => ipcRenderer.invoke('file:start', id, name),
  writeFileChunk: (id, chunk) => ipcRenderer.invoke('file:write-chunk', id, chunk),
  finishFile: (id) => ipcRenderer.invoke('file:end', id),
  createSocket,
  onSocket: (clientId, event, listener) => ipcRenderer.on(`socket-event:${clientId}:${event}`, (_event, ...args) => listener(...args)),
  emitSocket: (clientId, name, args, hasAck) => ipcRenderer.invoke('socket:emit', { clientId, name, args, hasAck }),
  disconnectSocket: (clientId) => ipcRenderer.invoke('socket:disconnect', clientId),
  onRequest: (fn) => ipcRenderer.on('host-request', (_event, data) => fn(data)),
  onHostStatus: (fn) => ipcRenderer.on('host-status', (_event, data) => fn(data)),
  onHostSessions: (fn) => ipcRenderer.on('host-sessions', (_event, data) => fn(data)),
  onHostName: (fn) => ipcRenderer.on('host-name', (_event, data) => fn(data)),
  onSessionKill: (fn) => ipcRenderer.on('session-kill', (_event, data) => fn(data)),
  onHostAccepted: (fn) => ipcRenderer.on('host-accepted', (_event, data) => fn(data)),
  onHostSignal: (fn) => ipcRenderer.on('host-signal', (_event, data) => fn(data)),
  onHostSendChat: (fn) => ipcRenderer.on('host-send-chat', (_event, data) => fn(data)),
  onHostSendFile: (fn) => ipcRenderer.on('host-send-file', (_event, data) => fn(data)),
  onHostChatOpen: (fn) => ipcRenderer.on('host-chat-open', (_event, data) => fn(data)),
  onToast: (fn) => ipcRenderer.on('toast', (_event, data) => fn(data)),
  onChat: (fn) => ipcRenderer.on('session-chat', (_event, data) => fn(data)),
  answerRequest: (data) => ipcRenderer.send('request:answer', data),
  disconnectSession: (sessionId) => ipcRenderer.send('active:disconnect', sessionId),
  sendActiveChat: (sessionId, text) => ipcRenderer.send('active:send-chat', { sessionId, text }),
  sendActiveFile: (sessionId) => ipcRenderer.send('active:send-file', sessionId),
  openActiveChat: (sessionId) => ipcRenderer.send('active:chat-open', sessionId),
  quit: () => ipcRenderer.send('agent:quit'),
  getVersion: () => ipcRenderer.invoke('update:version'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateState: (fn) => ipcRenderer.on('update-state', (_event, data) => fn(data))
});
