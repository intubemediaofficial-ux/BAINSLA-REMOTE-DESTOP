const state = { config: null, hostSessions: new Map(), activeHostSession: null, book: [], online: {}, previousOnline: {} };
const $ = (id) => document.getElementById(id);
function toast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  setTimeout(() => $('toast').classList.remove('show'), 3000);
}
function renderHostSessions(sessions) {
  const container = $('host-sessions');
  if (!container) return;
  const entries = Array.isArray(sessions) ? sessions : [];
  container.replaceChildren();
  container.hidden = entries.length === 0;
  for (const [sessionId, viewerName] of entries) {
    const card = document.createElement('article');
    card.className = 'host-session-card';
    card.dataset.sessionId = String(sessionId);
    const title = document.createElement('h2');
    title.textContent = `Remote session active: ${viewerName || 'Remote user'}`;
    const actions = document.createElement('div');
    actions.className = 'host-session-actions';
    const disconnect = document.createElement('button');
    disconnect.type = 'button';
    disconnect.className = 'button session-disconnect';
    disconnect.textContent = 'Disconnect';
    disconnect.onclick = () => window.kv.disconnectSession(sessionId);
    const chatButton = document.createElement('button');
    chatButton.type = 'button';
    chatButton.className = 'button secondary';
    chatButton.textContent = 'Chat';
    chatButton.onclick = () => window.kv.openActiveChat(sessionId);
    const sendFile = document.createElement('button');
    sendFile.type = 'button';
    sendFile.className = 'button secondary';
    sendFile.textContent = 'Send file';
    sendFile.onclick = () => window.kv.sendActiveFile(sessionId);
    actions.append(disconnect, chatButton, sendFile);
    const chatForm = document.createElement('form');
    chatForm.className = 'session-chat';
    chatForm.hidden = true;
    const chatInput = document.createElement('input');
    chatInput.placeholder = 'Message viewer';
    chatInput.setAttribute('aria-label', 'Message viewer');
    const chatSend = document.createElement('button');
    chatSend.type = 'submit';
    chatSend.className = 'button primary';
    chatSend.textContent = 'Send';
    chatForm.append(chatInput, chatSend);
    chatForm.onsubmit = (event) => {
      event.preventDefault();
      const text = chatInput.value.trim();
      if (!text) return;
      window.kv.sendActiveChat(sessionId, text);
      chatInput.value = '';
    };
    card.append(title, actions, chatForm);
    container.append(card);
  }
}
function setStatus(status) {
  const normalized = ['Online', 'Connecting', 'Offline', 'Blocked'].includes(status) ? status : 'Offline';
  $('host-status').textContent = normalized;
  const indicator = $('host-indicator');
  indicator.classList.remove('online', 'connecting', 'offline', 'blocked');
  indicator.classList.add(normalized.toLowerCase());
}
function showConfig(config) {
  state.config = config;
  $('desk-id').textContent = config.id ? config.id.match(/.{1,3}/g).join(' ') : '—';
  $('device-name').textContent = config.deviceName;
  $('password-state').textContent = config.passwordHash ? 'Unattended access: On' : 'Unattended access: Off';
  $('server-url').value = config.serverUrl || '';
  $('autostart').checked = Boolean(config.autostart);
  $('allow-control').checked = Boolean(config.allowControl);
  $('allow-clipboard').checked = Boolean(config.allowClipboard);
  $('allow-files').checked = Boolean(config.allowFiles);
  $('hidden-mode').checked = Boolean(config.hidden);
  if (!config.id) setStatus('Offline');
  renderRecent();
}
function renderRecent() {
  const escape = (value) => String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  $('recent-list').innerHTML = state.book.length ? state.book.map((item, index) => `<div class="saved-row"><span class="saved-dot ${state.online[item.target] ? 'online' : ''}"></span><button class="recent-item" data-connect="${index}"><span>${escape(item.label || item.target)}</span><small>${escape(item.target)}</small></button><label><input type="checkbox" data-auto="${index}" ${item.autoConnect ? 'checked' : ''}>Auto</label><button class="mini" data-edit="${index}">Edit</button><button class="mini danger-text" data-remove="${index}">×</button></div>`).join('') : '<span class="muted">No saved desks</span>';
  $('recent-list').querySelectorAll('[data-connect]').forEach((button) => button.onclick = () => {
    const entry = state.book[button.dataset.connect];
    openViewer(entry.target, entry.password || '');
  });
  $('recent-list').querySelectorAll('[data-auto]').forEach((input) => input.onchange = async () => {
    state.book[input.dataset.auto].autoConnect = input.checked;
    await window.kv.saveBook(state.book);
    renderRecent();
  });
  $('recent-list').querySelectorAll('[data-edit]').forEach((button) => button.onclick = async () => {
    const entry = state.book[button.dataset.edit];
    const target = prompt('Desk ID or alias', entry.target);
    if (target === null) return;
    const label = prompt('Label', entry.label || '');
    if (label === null) return;
    const password = prompt('Password (leave blank to keep current)', '');
    if (password === null) return;
    entry.target = target.trim().replace(/\s/g, ''); entry.label = label.trim();
    if (password) entry.password = password;
    await window.kv.saveBook(state.book);
    renderRecent();
  });
  $('recent-list').querySelectorAll('[data-remove]').forEach((button) => button.onclick = async () => {
    state.book.splice(Number(button.dataset.remove), 1);
    await window.kv.saveBook(state.book);
    renderRecent();
  });
}
async function connect() {
  try {
    const config = await window.kv.connectHost(state.config);
    showConfig(config);
    toast('Connecting this Desk…');
  } catch (error) {
    setStatus('Offline');
    toast(`Could not connect: ${error.message}`);
  }
}
function openViewer(id, password = '') {
  window.kv.openViewer(id, password);
}
async function pollAddressBook() {
  if (!state.book.length) return;
  try {
    const ids = state.book.map((item) => item.target).join(',');
    const response = await fetch(`${state.config.serverUrl.replace(/\/+$/, '')}/api/status?ids=${encodeURIComponent(ids)}`);
    state.online = await response.json();
  } catch { state.online = {}; }
  for (const entry of state.book) {
    const online = Boolean(state.online[entry.target]);
    if (entry.autoConnect && entry.password && online && state.previousOnline[entry.target] !== true) {
      openViewer(entry.target, entry.password);
    }
    state.previousOnline[entry.target] = online;
  }
  renderRecent();
}
async function captureSource(source) {
  // TODO: Plug a native C++ helper in here for Winlogon secure-desktop capture and input.
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop', chromeMediaSourceId: source.sourceId,
        maxWidth: Math.max(1920, source.width), maxHeight: Math.max(1080, source.height), maxFrameRate: 30
      }
    }
  });
}
async function setSessionQuality(session, preset) {
  const sender = session.peer.getSenders().find((item) => item.track?.kind === 'video');
  if (!sender) return;
  const parameters = sender.getParameters();
  parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
  const width = session.currentScreen.width;
  const maxWidth = preset === 'low' ? 1280 : preset === 'balanced' || preset === 'auto' ? 1600 : width;
  parameters.encodings[0].maxBitrate = preset === 'high' ? 8000000 : preset === 'low' ? 1000000 : 3000000;
  parameters.encodings[0].maxFramerate = preset === 'high' ? 30 : preset === 'low' ? 15 : 24;
  parameters.encodings[0].scaleResolutionDownBy = Math.max(1, width / maxWidth);
  await sender.setParameters(parameters);
}
async function replaceHostScreen(session, sourceId) {
  const screen = session.screens.find((item) => String(item.id) === String(sourceId));
  if (!screen) return;
  const stream = await captureSource(screen);
  const track = stream.getVideoTracks()[0];
  const sender = session.peer.getSenders().find((item) => item.track?.kind === 'video');
  await sender?.replaceTrack(track);
  session.stream.getTracks().forEach((item) => item.stop());
  session.stream = stream;
  session.currentScreen = screen;
  await setSessionQuality(session, session.quality || 'auto');
}
async function sendHostFile(session, file) {
  if (!session.permissions.files || session.ctl.readyState !== 'open' || !session.fileChannel || session.fileChannel.readyState !== 'open' || session.sendingFile) return;
  session.sendingFile = true;
  try {
    const id = crypto.randomUUID();
    session.ctl.send(JSON.stringify({ t: 'fs', id, name: file.name, size: file.size }));
    let offset = 0;
    while (offset < file.size) {
      if (session.fileChannel.bufferedAmount > 256 * 1024) {
        await new Promise((resolve) => {
          session.fileChannel.bufferedAmountLowThreshold = 128 * 1024;
          session.fileChannel.addEventListener('bufferedamountlow', resolve, { once: true });
        });
      }
      const chunk = await window.kv.readFileChunk(file.path, offset, 16 * 1024);
      const bytes = new Uint8Array(chunk);
      session.fileChannel.send(bytes);
      offset += bytes.byteLength;
    }
    session.ctl.send(JSON.stringify({ t: 'fe', id }));
  } finally {
    session.sendingFile = false;
  }
}
function enqueueHostFileChunk(session, data) {
  if (!session.incoming) {
    session.pendingFileChunks.push(data);
    return;
  }
  const incoming = session.incoming;
  incoming.received += data.byteLength;
  session.writeQueue = (session.writeQueue || Promise.resolve())
    .then(() => window.kv.writeFileChunk(incoming.id, data));
}
async function startHostSession(data) {
  const screens = await window.kv.getScreens();
  if (!screens.length) throw new Error('No desktop display found');
  const currentScreen = screens.find((item) => item.primary) || screens[0];
  const stream = await captureSource(currentScreen);
  const peer = new RTCPeerConnection({ iceServers: data.iceServers || [] });
  const session = {
    id: data.sessionId, permissions: data.permissions, screens, currentScreen, stream, peer,
    quality: 'auto', fileBusy: false, pendingFileChunks: [], pendingIceCandidates: []
  };
  state.hostSessions.set(session.id, session);
  state.activeHostSession = session;
  stream.getTracks().forEach((track) => peer.addTrack(track, stream));
  session.ctl = peer.createDataChannel('ctl', { ordered: true });
  session.fileChannel = peer.createDataChannel('file', { ordered: true });
  session.fileChannel.binaryType = 'arraybuffer';
  session.fileChannel.bufferedAmountLowThreshold = 128 * 1024;
  peer.onicecandidate = ({ candidate }) => {
    if (candidate) window.kv.emitHost('signal', { sessionId: session.id, data: { candidate: candidate.toJSON() } });
  };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'failed') {
      window.kv.emitHost('session:end', { sessionId: session.id, reason: 'connection_failed' });
      endHostSession(session.id);
    } else if (peer.connectionState === 'closed') endHostSession(session.id);
  };
  session.ctl.onopen = () => {
    session.ctl.send(JSON.stringify({ t: 'screens', list: screens.map(({ id, name, width, height, primary }) => ({ id, name, w: width, h: height, primary })), current: currentScreen.id }));
    session.ctl.send(JSON.stringify({ t: 'perm', ...session.permissions }));
    setSessionQuality(session, 'auto').catch(() => {});
  };
  session.ctl.onmessage = async ({ data: raw }) => {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (['mm', 'md', 'mu', 'wh', 'kd', 'ku', 'combo'].includes(message.t) && session.permissions.control) {
      window.kv.dispatchInput({ ...message, displayId: session.currentScreen.displayId });
    } else if (message.t === 'screen') {
      replaceHostScreen(session, message.id).catch((error) => toast(error.message));
    } else if (message.t === 'quality') {
      session.quality = message.q;
      setSessionQuality(session, message.q).catch(() => {});
    } else if (message.t === 'chat') {
      toast(`${data.viewerName || 'Viewer'}: ${message.text}`);
    } else if (message.t === 'clip' && session.permissions.clipboard) {
      window.kv.writeClipboard(message.text);
    } else if (message.t === 'fs' && session.permissions.files) {
      const incoming = { id: message.id, size: message.size, received: 0 };
      session.incoming = incoming;
      incoming.ready = window.kv.startFile(message.id, message.name);
      for (const chunk of session.pendingFileChunks.splice(0)) enqueueHostFileChunk(session, chunk);
    } else if (message.t === 'fe' && session.incoming?.id === message.id) {
      while (session.incoming.received < session.incoming.size) await new Promise((resolve) => setTimeout(resolve, 20));
      await session.incoming.ready;
      await session.writeQueue;
      window.kv.finishFile(message.id);
      toast(`Received ${message.id}`);
      session.incoming = null;
    }
  };
  session.fileChannel.onmessage = (event) => {
    enqueueHostFileChunk(session, event.data);
  };
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  const localDescription = peer.localDescription;
  window.kv.emitHost('signal', {
    sessionId: session.id,
    data: { sdp: { type: localDescription.type, sdp: localDescription.sdp } }
  });
}
function endHostSession(sessionId) {
  const session = state.hostSessions.get(sessionId);
  if (!session) return;
  session.peer.close();
  session.stream.getTracks().forEach((track) => track.stop());
  session.ctl.close();
  session.fileChannel.close();
  state.hostSessions.delete(sessionId);
  if (state.activeHostSession === session) state.activeHostSession = null;
}
let previousClipboard = '';
setInterval(async () => {
  const sessions = [...state.hostSessions.values()].filter((session) => session.permissions.clipboard && session.ctl.readyState === 'open');
  if (!sessions.length) return;
  const text = await window.kv.readClipboard();
  if (text !== previousClipboard) {
    previousClipboard = text;
    for (const session of sessions) session.ctl.send(JSON.stringify({ t: 'clip', text }));
  }
}, 1000);
$('copy-id').onclick = async () => {
  await navigator.clipboard.writeText(state.config.id || '');
  toast('Desk ID copied');
};
$('save-password').onclick = async () => {
  const password = $('unattended-password').value;
  if (password && password.length < 8) return toast('Use at least 8 characters');
  const salt = password ? crypto.randomUUID() : '';
  const passwordHash = password ? await window.kv.hashPassword(password, salt) : '';
  await window.kv.saveConfig({ passwordHash, passwordSalt: salt });
  showConfig(await window.kv.getConfig());
  $('unattended-password').value = '';
  toast(password ? 'Unattended password saved' : 'Unattended password removed');
};
$('rename').onclick = async () => {
  const name = prompt('Device name', state.config.deviceName);
  if (name?.trim()) {
    await window.kv.saveConfig({ deviceName: name.trim() });
    showConfig(await window.kv.getConfig());
    toast('Device name updated; reconnect to sync');
  }
};
$('remote-connect').onclick = () => {
  const id = $('remote-id').value.trim().replace(/\s/g, '');
  const saved = state.book.find((entry) => entry.target.toLowerCase() === id.toLowerCase());
  if (id) openViewer(id, saved?.password || '');
};
$('remote-id').addEventListener('keydown', (event) => event.key === 'Enter' && $('remote-connect').click());
$('book-form').onsubmit = async (event) => {
  event.preventDefault();
  const target = $('book-target').value.trim().replace(/\s/g, '');
  if (!target) return;
  state.book = state.book.filter((entry) => entry.target.toLowerCase() !== target.toLowerCase());
  state.book.push({ target, label: $('book-label').value.trim(), password: $('book-password').value,
    autoConnect: $('book-auto').checked });
  await window.kv.saveBook(state.book);
  event.currentTarget.reset();
  renderRecent();
  pollAddressBook();
};
$('settings-toggle').onclick = () => $('settings-panel').hidden = !$('settings-panel').hidden;
$('open-settings').onclick = () => $('settings-panel').hidden = false;
$('save-settings').onclick = async () => {
  try {
    const serverUrl = $('server-url').value.trim();
    new URL(serverUrl);
    const updated = await window.kv.saveConfig({
      serverUrl, deviceName: $('settings-name').value.trim(), autostart: $('autostart').checked,
      allowControl: $('allow-control').checked, allowClipboard: $('allow-clipboard').checked,
      allowFiles: $('allow-files').checked, hidden: $('hidden-mode').checked
    });
    showConfig(updated);
    $('settings-panel').hidden = true;
    toast('Settings saved');
  } catch {
    toast('Enter a valid signaling server URL');
  }
};
let hostStatusRevision = 0;
window.kv.onHostStatus(({ status, id }) => {
  hostStatusRevision += 1;
  if (id) state.config.id = id;
  setStatus(status);
  if (state.config.id) $('desk-id').textContent = state.config.id.match(/.{1,3}/g).join(' ');
});
window.kv.onHostSessions(renderHostSessions);
window.kv.onHostChatOpen((sessionId) => {
  const container = $('host-sessions');
  const card = [...container.querySelectorAll('.host-session-card')].find((item) => item.dataset.sessionId === String(sessionId));
  const chatForm = card?.querySelector('.session-chat');
  if (!chatForm) return;
  chatForm.hidden = !chatForm.hidden;
  if (!chatForm.hidden) chatForm.querySelector('input')?.focus();
});
window.kv.onHostName((name) => { state.config.deviceName = name; $('device-name').textContent = name; });
window.kv.onToast(toast);
window.kv.onSessionKill(({ sessionId, reason }) => {
  endHostSession(sessionId);
  toast(`Session ended: ${reason || 'disconnected'}`);
});
window.kv.onHostAccepted((data) => startHostSession(data).catch((error) => {
  const reason = window.kv.platform === 'darwin' ? 'mac_screen_capture_failed' : 'secure_desktop_unavailable';
  window.kv.emitHost('session:answer', { sessionId: data.sessionId, accept: false, reason });
  toast(`Could not share desktop: ${error.message}`);
}));
window.kv.onHostSignal((payload) => {
  const session = state.hostSessions.get(payload.sessionId);
  if (!session) return;
  if (payload.data?.sdp) {
    session.peer.setRemoteDescription(payload.data.sdp).then(async () => {
      for (const candidate of session.pendingIceCandidates.splice(0)) {
        try { await session.peer.addIceCandidate(candidate); }
        catch (error) { console.error('Host ICE candidate error', error); }
      }
    }).catch((error) => toast(error.message));
  } else if (typeof payload.data?.candidate?.candidate === 'string') {
    if (session.peer.remoteDescription) {
      session.peer.addIceCandidate(payload.data.candidate).catch((error) => console.error('Host ICE candidate error', error));
    } else session.pendingIceCandidates.push(payload.data.candidate);
  }
});
window.kv.onHostSendChat((text) => {
  const session = state.hostSessions.get(text.sessionId);
  if (session?.ctl.readyState === 'open') session.ctl.send(JSON.stringify({ t: 'chat', text: text.text }));
});
window.kv.onHostSendFile((file) => {
  const session = state.hostSessions.get(file.sessionId);
  if (session) sendHostFile(session, file).catch((error) => toast(error.message));
});
window.kv.getConfig().then((config) => {
  const statusRevision = hostStatusRevision;
  showConfig(config);
  window.kv.getHostStatus().then(({ status, id }) => {
    if (hostStatusRevision === statusRevision && state.config.id === id) setStatus(status);
  });
  $('server-url').value = config.serverUrl;
  $('settings-name').value = config.deviceName;
  $('autostart').checked = config.autostart !== false;
  $('allow-control').checked = config.allowControl !== false;
  $('allow-clipboard').checked = config.allowClipboard !== false;
  $('allow-files').checked = config.allowFiles !== false;
  $('hidden-mode').checked = config.hidden === true;
  window.kv.getBook().then((book) => {
    state.book = book;
    pollAddressBook();
    setInterval(pollAddressBook, 5000);
  });
  if (!config.id) connect();
});
$('settings-close').onclick = () => $('settings-panel').hidden = true;
$('quit-app').onclick = () => { if (confirm('Stop Bainsla Remote? Remote access will be off until you open the app again.')) window.kv.quit(); };
async function refreshPermissions() {
  const status = await window.kv.getPermissions();
  if (!status.required) return;
  $('perm-screen-state').textContent = status.screen ? 'Allowed' : 'Not allowed — remote viewers are refused';
  $('perm-access-state').textContent = status.accessibility ? 'Allowed' : 'Not allowed — sessions are view only';
  $('perm-screen').hidden = status.screen;
  $('perm-access').hidden = status.accessibility;
  $('perm-move').hidden = status.autostartSupported;
  $('mac-permissions').hidden = status.screen && status.accessibility && status.autostartSupported;
}
if (window.kv.platform === 'darwin') {
  $('perm-screen').onclick = () => window.kv.openPermissionPane('screen');
  $('perm-access').onclick = () => window.kv.openPermissionPane('accessibility');
  $('perm-restart').onclick = () => window.kv.restartApp();
  refreshPermissions();
  setInterval(refreshPermissions, 3000);
}
