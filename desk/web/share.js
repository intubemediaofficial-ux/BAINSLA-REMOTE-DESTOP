const base = location.pathname.replace(/\/$/, '');
const $ = (id) => document.getElementById(id);
const storeKey = 'bainsla-share-device';
const CHUNK = 16 * 1024;
const supported = Boolean(navigator.mediaDevices?.getDisplayMedia);
let device = null;
try { device = JSON.parse(localStorage.getItem(storeKey) || 'null'); } catch { device = null; }
let pendingRequest = null;
let current = null;

const setStatus = (text, ok = false) => { $('share-status').textContent = text; $('share-status').classList.toggle('is-online', ok); };
const toast = (text) => { const el = $('share-toast'); el.textContent = text; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 3000); };
const formatId = (id) => String(id).replace(/(\d{3})(?=\d)/g, '$1 ');

function deviceName() {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'Computer';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return { os, label: `${browser} on ${os} (browser share)` };
}

if (!supported) {
  $('share-code').textContent = '—';
  setStatus('This browser cannot share its screen. On a phone, install the Bainsla Remote app. You can still connect to others from the bar on top.');
} else {
  const socket = io({ path: `${base}/socket.io`, reconnection: true });
  const hello = () => {
    const { os, label } = deviceName();
    socket.emit('agent:hello', { id: device?.id, secret: device?.secret, name: label, platform: 'web', os, version: 'web' }, (ack) => {
      if (!ack?.ok) {
        if (device && ['not_found', 'invalid_secret'].includes(ack?.error)) {
          localStorage.removeItem(storeKey);
          device = null;
          return hello();
        }
        return setStatus(ack?.error === 'blocked' ? 'This code was blocked by the admin.' : 'Could not get a code. Refresh the page.');
      }
      if (ack.secret) {
        device = { id: ack.id, secret: ack.secret };
        localStorage.setItem(storeKey, JSON.stringify(device));
      }
      $('share-code').textContent = formatId(ack.id);
      $('copy-code').disabled = false;
      setStatus('Ready. Keep this page open while someone connects to you.', true);
    });
  };
  socket.on('connect', hello);
  socket.on('disconnect', () => setStatus('Reconnecting…'));
  socket.on('agent:replaced', () => setStatus('This code is open in another tab or window. Use that one.'));
  socket.on('agent:blocked', () => setStatus('This code was blocked by the admin.'));

  socket.on('session:request', (request) => {
    if (current || pendingRequest) {
      socket.emit('session:answer', { sessionId: request.sessionId, accept: false, reason: 'busy' });
      return;
    }
    pendingRequest = request;
    $('request-text').textContent = `${request.viewerName || 'A viewer'} wants to see your screen. Accept only if you know this person.`;
    $('share-request').hidden = false;
    $('request-accept').focus();
  });
  const closeRequest = () => { $('share-request').hidden = true; pendingRequest = null; };
  $('request-deny').onclick = () => {
    if (pendingRequest) socket.emit('session:answer', { sessionId: pendingRequest.sessionId, accept: false, reason: 'declined' });
    closeRequest();
  };
  $('request-accept').onclick = async () => {
    const request = pendingRequest;
    if (!request) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 24, max: 30 } }, audio: false });
    } catch {
      socket.emit('session:answer', { sessionId: request.sessionId, accept: false, reason: 'declined' });
      closeRequest();
      return toast('Screen sharing was cancelled');
    }
    closeRequest();
    current = { id: request.sessionId, viewerName: request.viewerName || 'Viewer', stream, pendingIce: [], pendingChunks: [], incoming: null };
    socket.emit('session:answer', { sessionId: request.sessionId, accept: true, permissions: { control: false, clipboard: false, files: true } });
  };
  socket.on('session:closed', ({ sessionId }) => { if (pendingRequest?.sessionId === sessionId) closeRequest(); });

  socket.on('session:accepted', (data) => {
    if (!current || data.sessionId !== current.id) return;
    startPeer(data).catch((error) => { console.error(error); stopSession('capture_failed'); });
  });
  socket.on('signal', async ({ sessionId, data }) => {
    if (!current?.peer || sessionId !== current.id) return;
    try {
      if (data.sdp) {
        await current.peer.setRemoteDescription(data.sdp);
        for (const candidate of current.pendingIce.splice(0)) await current.peer.addIceCandidate(candidate);
      } else if (data.candidate) {
        if (current.peer.remoteDescription) await current.peer.addIceCandidate(data.candidate);
        else current.pendingIce.push(data.candidate);
      }
    } catch (error) { console.error('Signaling error', error); }
  });
  socket.on('session:kill', ({ sessionId }) => { if (current?.id === sessionId) endLocal('The session ended'); });

  async function startPeer(data) {
    const session = current;
    const peer = new RTCPeerConnection({ iceServers: data.iceServers || [] });
    session.peer = peer;
    session.stream.getTracks().forEach((track) => {
      peer.addTrack(track, session.stream);
      track.onended = () => stopSession('host_stopped');
    });
    session.ctl = peer.createDataChannel('ctl', { ordered: true });
    session.file = peer.createDataChannel('file', { ordered: true });
    session.file.binaryType = 'arraybuffer';
    peer.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('signal', { sessionId: session.id, data: { candidate: candidate.toJSON() } });
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') $('live-title').textContent = `${session.viewerName} can see your screen`;
      if (peer.connectionState === 'failed') stopSession('connection_failed');
    };
    session.ctl.onopen = () => {
      const settings = session.stream.getVideoTracks()[0]?.getSettings() || {};
      session.ctl.send(JSON.stringify({ t: 'screens', list: [{ id: 'browser', name: 'Shared screen', w: settings.width || 0, h: settings.height || 0, primary: true }], current: 'browser' }));
      session.ctl.send(JSON.stringify({ t: 'perm', control: false, clipboard: false, files: true }));
      setQuality(session, 'auto');
    };
    session.ctl.onmessage = async ({ data: raw }) => {
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      if (message.t === 'chat') addMessage(`${session.viewerName}: ${message.text}`, 'host');
      else if (message.t === 'quality') setQuality(session, message.q);
      else if (message.t === 'fs') {
        session.incoming = { id: message.id, name: String(message.name || 'file').slice(0, 200), size: Number(message.size) || 0, chunks: session.pendingChunks.splice(0) };
        session.incoming.received = session.incoming.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      } else if (message.t === 'fe' && session.incoming?.id === message.id) {
        const incoming = session.incoming;
        while (incoming.received < incoming.size && current === session) await new Promise((resolve) => setTimeout(resolve, 20));
        session.incoming = null;
        addFile(incoming.name, new Blob(incoming.chunks));
      }
    };
    session.file.onmessage = ({ data: chunk }) => {
      if (!(chunk instanceof ArrayBuffer)) return;
      if (session.incoming) {
        session.incoming.chunks.push(chunk);
        session.incoming.received += chunk.byteLength;
      } else session.pendingChunks.push(chunk);
    };
    const ua = navigator.userAgent;
    const installLink = /Windows/.test(ua) ? $('download-win') : /Mac OS/.test(ua) ? $('download-mac') : null;
    const canInstall = installLink && !installLink.hidden && installLink.getAttribute('href') !== '#';
    $('full-control').hidden = !canInstall;
    $('full-control-note').hidden = !canInstall;
    if (canInstall) $('full-control').href = installLink.href;
    $('share-preview').srcObject = session.stream;
    $('live-title').textContent = `Connecting to ${session.viewerName}…`;
    $('share-messages').replaceChildren();
    $('share-ready').hidden = true;
    $('share-live').hidden = false;
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    socket.emit('signal', { sessionId: session.id, data: { sdp: { type: peer.localDescription.type, sdp: peer.localDescription.sdp } } });
  }

  async function setQuality(session, preset) {
    const sender = session.peer?.getSenders().find((item) => item.track?.kind === 'video');
    if (!sender) return;
    const parameters = sender.getParameters();
    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
    parameters.encodings[0].maxBitrate = preset === 'high' ? 8000000 : preset === 'low' ? 1000000 : 3000000;
    parameters.encodings[0].maxFramerate = preset === 'high' ? 30 : preset === 'low' ? 15 : 24;
    await sender.setParameters(parameters).catch(() => {});
  }

  function stopSession(reason) {
    if (current) socket.emit('session:end', { sessionId: current.id, reason });
    endLocal('You stopped sharing');
  }
  function endLocal(message) {
    if (!current) return;
    const session = current;
    current = null;
    session.peer?.close();
    session.stream.getTracks().forEach((track) => track.stop());
    $('share-preview').srcObject = null;
    $('share-live').hidden = true;
    $('share-ready').hidden = false;
    toast(message);
  }
  $('stop-share').onclick = () => stopSession('host_stopped');

  $('share-chat-form').onsubmit = (event) => {
    event.preventDefault();
    const text = $('share-chat-input').value.trim();
    if (!text || current?.ctl?.readyState !== 'open') return;
    current.ctl.send(JSON.stringify({ t: 'chat', text }));
    addMessage(`You: ${text}`, 'self');
    $('share-chat-input').value = '';
  };
  $('share-file').onchange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    const session = current;
    if (!file || !session || session.ctl?.readyState !== 'open' || session.file?.readyState !== 'open' || session.sending) return;
    session.sending = true;
    try {
      const id = crypto.randomUUID();
      session.ctl.send(JSON.stringify({ t: 'fs', id, name: file.name, size: file.size }));
      for (let offset = 0; offset < file.size; offset += CHUNK) {
        if (session.file.bufferedAmount > 256 * 1024) {
          await new Promise((resolve) => {
            session.file.bufferedAmountLowThreshold = 128 * 1024;
            session.file.addEventListener('bufferedamountlow', resolve, { once: true });
          });
        }
        session.file.send(await file.slice(offset, offset + CHUNK).arrayBuffer());
      }
      session.ctl.send(JSON.stringify({ t: 'fe', id }));
      addMessage(`File sent: ${file.name}`, 'self');
    } catch { toast('File could not be sent'); } finally { session.sending = false; }
  };
}

function addMessage(text, kind) {
  const line = document.createElement('div');
  line.className = `chat-line ${kind}`;
  line.textContent = text;
  $('share-messages').append(line);
  line.scrollIntoView({ block: 'end' });
}
function addFile(name, blob) {
  const line = document.createElement('div');
  line.className = 'chat-line host';
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.className = 'text-link';
  link.textContent = `Download ${name}`;
  line.append('File received: ', link);
  $('share-messages').append(line);
  toast(`File received: ${name}`);
}
$('copy-code').onclick = async () => {
  try { await navigator.clipboard.writeText($('share-code').textContent.replace(/\s/g, '')); toast('Code copied'); } catch { toast('Copy failed'); }
};
