import { FILE_CHUNK_SIZE, socketPath } from './protocol.js';

export function createViewer(options = {}) {
  const root = options.root || document;
  const basePath = options.basePath ?? document.body.dataset.base ?? '';
  const q = (selector) => root.querySelector(selector);
  const video = q('#remote-video');
  if (video) video.muted = true;
  const status = q('#viewer-status');
  const socket = options.socket || window.io({ path: socketPath(basePath), reconnection: true });
  let pc;
  let ctl;
  let fileChannel;
  let sessionId;
  let permissions = { control: true, clipboard: true, files: true };
  let receiving = null;
  let fileBusy = false;
  let touchTimer;
  let touchMoved = false;
  let longPressed = false;
  let dragStarted = false;
  let touchStartPoint = null;
  let lastTouchCentroid = null;
  let connecting = false;
  let pendingFileChunks = [];
  let pendingIceCandidates = [];
  let pendingSignals = [];
  let pendingSessionSignals = [];
  let pendingSessionEvents = [];
  let connectPassword = '';
  let quality = 'auto';

  const setStatus = (text, connected = false) => {
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('is-online', connected);
  };
  const sendCtl = (message) => {
    if (ctl?.readyState === 'open') ctl.send(JSON.stringify(message));
  };
  if (typeof window !== 'undefined') window.__kvDeskSendCtl = sendCtl;
  const closeSession = (reason = 'viewer_closed') => {
    if (sessionId) socket.emit('session:end', { sessionId, reason });
    if (window.__kvDeskDebugPeer === pc) delete window.__kvDeskDebugPeer;
    pc?.close();
    pc = null;
    ctl = null;
    fileChannel = null;
    sessionId = null;
    pendingSignals = [];
    pendingSessionSignals = [];
    pendingSessionEvents = [];
    pendingIceCandidates = [];
    pendingFileChunks = [];
  };
  const actualPoint = (event) => {
    const rect = video.getBoundingClientRect();
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height || !rect.width || !rect.height) return null;
    const scale = Math.min(rect.width / width, rect.height / height);
    const drawnWidth = width * scale;
    const drawnHeight = height * scale;
    const left = rect.left + (rect.width - drawnWidth) / 2;
    const top = rect.top + (rect.height - drawnHeight) / 2;
    const x = (event.clientX - left) / drawnWidth;
    const y = (event.clientY - top) / drawnHeight;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  };
  const connect = async () => {
    if (connecting) return;
    const params = new URLSearchParams(location.search);
    const targetId = (params.get('id') || q('#target-id')?.value?.trim() || '').replace(/\s/g, '');
    if (!targetId) return setStatus('Enter a Desk ID');
    const password = q('#viewer-password')?.value || params.get('password') || sessionStorage.getItem(`kvdesk-password:${targetId.toLowerCase()}`) || connectPassword;
    connectPassword = password;
    sessionStorage.removeItem(`kvdesk-password:${targetId.toLowerCase()}`);
    pc?.close();
    pc = null;
    ctl = null;
    fileChannel = null;
    sessionId = null;
    pendingSignals = [];
    pendingSessionSignals = [];
    pendingSessionEvents = [];
    pendingIceCandidates = [];
    pendingFileChunks = [];
    setStatus('Connecting…');
    connecting = true;
    socket.emit('viewer:connect', {
      targetId, password, viewerName: 'Browser viewer'
    }, async (response) => {
      connecting = false;
      if (!response?.ok) {
        pendingSessionSignals = [];
        pendingSessionEvents = [];
        return setStatus(response?.error === 'offline' ? 'Desk is offline' : `Could not connect: ${response?.error || 'error'}`);
      }
      sessionId = response.sessionId;
      setStatus('Waiting for accept…');
      for (const signal of pendingSessionSignals.splice(0)) {
        if (signal.sessionId === sessionId) await handleSignal(signal.data);
      }
      for (const event of pendingSessionEvents.splice(0)) await dispatchSessionEvent(event.name, event.data);
    });
  };
  const onCtl = async (message) => {
    if (message.t === 'screens') {
      const select = q('#screen-select');
      if (select) {
        select.replaceChildren(...message.list.map((screen) => {
          const option = document.createElement('option');
          option.value = screen.id;
          option.textContent = screen.name;
          option.selected = String(screen.id) === String(message.current);
          return option;
        }));
      }
    } else if (message.t === 'chat') {
      appendChat(message.text, 'host');
    } else if (message.t === 'clip' && permissions.clipboard) {
      navigator.clipboard?.writeText(message.text).catch(() => {});
      setStatus('Text copied from host', true);
    } else if (message.t === 'perm') {
      permissions = { control: message.control, clipboard: message.clipboard, files: message.files };
    } else if (message.t === 'fs') {
      receiving = { id: message.id, name: message.name, size: message.size, chunks: pendingFileChunks, received: pendingFileChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) };
      pendingFileChunks = [];
    } else if (message.t === 'fe' && receiving?.id === message.id) {
      while (receiving.received < receiving.size) await new Promise((resolve) => setTimeout(resolve, 20));
      const blob = new Blob(receiving.chunks);
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = receiving.name;
      link.click();
      URL.revokeObjectURL(link.href);
      receiving = null;
    }
  };
  const appendChat = (text, who) => {
    const list = q('#chat-messages');
    if (!list) return;
    const line = document.createElement('div');
    line.className = `chat-line ${who}`;
    line.textContent = text;
    list.append(line);
    list.scrollTop = list.scrollHeight;
  };
  const sendFile = async (file) => {
    if (!permissions.files || !file || !fileChannel || fileChannel.readyState !== 'open') return;
    if (fileBusy) return setStatus('A file is already transferring');
    fileBusy = true;
    try {
      const id = crypto.randomUUID();
      sendCtl({ t: 'fs', id, name: file.name, size: file.size });
      let offset = 0;
      while (offset < file.size) {
        if (fileChannel.bufferedAmount > 256 * 1024) {
          await new Promise((resolve) => {
            fileChannel.addEventListener('bufferedamountlow', resolve, { once: true });
            fileChannel.bufferedAmountLowThreshold = 128 * 1024;
          });
        }
        const chunk = await file.slice(offset, offset + FILE_CHUNK_SIZE).arrayBuffer();
        fileChannel.send(chunk);
        offset += chunk.byteLength;
        setStatus(`Sending ${file.name} · ${Math.round(offset / file.size * 100)}%`, true);
      }
      sendCtl({ t: 'fe', id });
      setStatus('Connected', true);
    } finally {
      fileBusy = false;
    }
  };
  const setQuality = async (preset) => {
    quality = preset;
    sendCtl({ t: 'quality', q: preset });
  };
  const setupPeer = async (data) => {
    permissions = data.permissions || permissions;
    const forceRelay = new URLSearchParams(location.search).get('relay') === '1';
    pc = new RTCPeerConnection({
      iceServers: data.iceServers || [],
      ...(forceRelay ? { iceTransportPolicy: 'relay' } : {})
    });
    if (forceRelay) window.__kvDeskDebugPeer = pc;
    pc.ontrack = (event) => {
      video.srcObject = event.streams[0];
      video.play().catch(() => {});
      setStatus(`Connected to ${data.hostInfo?.name || 'Desk'}`, true);
    };
    pc.ondatachannel = ({ channel }) => {
      if (channel.label === 'ctl') {
        ctl = channel;
        ctl.onopen = () => setQuality(quality);
        ctl.onmessage = (event) => {
          try { onCtl(JSON.parse(event.data)); } catch {}
        };
      } else if (channel.label === 'file') {
        fileChannel = channel;
        fileChannel.binaryType = 'arraybuffer';
        fileChannel.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            if (receiving) {
              receiving.chunks.push(event.data);
              receiving.received += event.data.byteLength;
            } else pendingFileChunks.push(event.data);
          }
        };
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('signal', { sessionId, data: { candidate: candidate.toJSON() } });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setStatus('Connected', true);
      if (pc.connectionState === 'failed') {
        setStatus('Connection failed');
        socket.emit('session:end', { sessionId, reason: 'connection_failed' });
      }
    };
    pendingIceCandidates = [];
  };

  const handleSignal = async (data) => {
    if (!pc) {
      pendingSignals.push(data);
      return;
    }
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          const localDescription = pc.localDescription;
          socket.emit('signal', {
            sessionId,
            data: { sdp: { type: localDescription.type, sdp: localDescription.sdp } }
          });
        }
        for (const candidate of pendingIceCandidates) await pc.addIceCandidate(candidate);
        pendingIceCandidates = [];
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
        else pendingIceCandidates.push(data.candidate);
      }
    } catch (error) { console.error('Signaling error', error); }
  };
  const dispatchSessionEvent = async (name, data) => {
    if (!sessionId) {
      pendingSessionEvents.push({ name, data });
      return;
    }
    if (data.sessionId !== sessionId) return;
    if (name === 'accepted') {
      await setupPeer(data);
      setStatus('Accepted · waiting for desktop…', true);
      for (const signal of pendingSignals.splice(0)) await handleSignal(signal);
    } else if (name === 'rejected') {
      pc?.close();
      pc = null;
      sessionId = null;
      pendingSignals = [];
      pendingSessionSignals = [];
      pendingSessionEvents = [];
      setStatus(['secure_desktop_unavailable', 'capture_failed'].includes(data.reason)
        ? 'Remote PC is on the lock screen / UAC prompt. Secure-desktop access needs the native helper (not installed).'
        : `Request ${data.reason || 'rejected'}`);
      if (data.reason === 'password_required') {
        setStatus('Password required');
        const passwordInput = q('#viewer-password');
        const passwordCard = passwordInput?.closest('.connect-card, form') || passwordInput?.parentElement;
        if (passwordCard) passwordCard.hidden = false;
        passwordInput?.focus();
      } else if (data.reason === 'bad_password') {
        setTimeout(() => {
          const password = prompt('Password required for this Desk');
          if (password !== null) {
            q('#viewer-password').value = password;
            connect();
          }
        }, 0);
      }
    } else if (name === 'kill') {
      pc?.close();
      pc = null;
      sessionId = null;
      pendingSignals = [];
      pendingSessionSignals = [];
      pendingSessionEvents = [];
      setStatus(data.reason === 'disconnect' ? 'Desk disconnected' : 'Session ended');
    }
  };
  socket.on('signal', (signal) => {
    if (!sessionId) pendingSessionSignals.push(signal);
    else if (signal.sessionId === sessionId) handleSignal(signal.data);
  });
  socket.on('session:accepted', (data) => dispatchSessionEvent('accepted', data));
  socket.on('session:rejected', (data) => dispatchSessionEvent('rejected', data));
  socket.on('session:kill', (data) => dispatchSessionEvent('kill', data));
  socket.on('connect', () => {
    if (new URLSearchParams(location.search).has('id') && !sessionId) connect();
  });
  socket.on('disconnect', () => {
    pc?.close();
    pc = null;
    ctl = null;
    fileChannel = null;
    sessionId = null;
    connecting = false;
    pendingSignals = [];
    pendingSessionSignals = [];
    pendingSessionEvents = [];
    setStatus('Reconnecting…');
  });

  q('#connect-button')?.addEventListener('click', connect);
  q('#disconnect-button')?.addEventListener('click', () => closeSession());
  q('#quality-select')?.addEventListener('change', (event) => setQuality(event.target.value));
  q('#screen-select')?.addEventListener('change', (event) => sendCtl({ t: 'screen', id: event.target.value }));
  q('#fullscreen-button')?.addEventListener('click', () => document.documentElement.requestFullscreen?.());
  q('#shortcut-select')?.addEventListener('change', (event) => {
    if (event.target.value) sendCtl({ t: 'combo', k: event.target.value });
    event.target.value = '';
  });
  q('#keyboard-button')?.addEventListener('click', () => q('#mobile-keyboard')?.focus());
  q('#mobile-keyboard')?.addEventListener('input', (event) => {
    for (const character of event.target.value) {
      sendCtl({ t: 'kd', code: '', key: character });
      sendCtl({ t: 'ku', code: '', key: character });
    }
    event.target.value = '';
  });
  q('#mobile-keyboard')?.addEventListener('keydown', (event) => {
    if (!['Backspace', 'Enter', 'Tab'].includes(event.key)) return;
    event.preventDefault();
    sendCtl({ t: 'kd', code: event.code, key: event.key });
    sendCtl({ t: 'ku', code: event.code, key: event.key });
  });
  q('#chat-toggle')?.addEventListener('click', () => q('#chat-panel')?.classList.toggle('open'));
  q('#chat-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = q('#chat-input');
    if (input.value.trim()) {
      const text = input.value.trim();
      sendCtl({ t: 'chat', text });
      appendChat(text, 'viewer');
      input.value = '';
    }
  });
  q('#clipboard-button')?.addEventListener('click', async () => {
    const text = await navigator.clipboard?.readText().catch(() => '');
    if (text) sendCtl({ t: 'clip', text });
  });
  q('#file-input')?.addEventListener('change', (event) => {
    sendFile(event.target.files[0]);
    event.target.value = '';
  });
  video?.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') return;
    if (!permissions.control) return;
    const point = actualPoint(event);
    if (point) sendCtl({ t: 'mm', ...point });
  });
  video?.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'touch') return;
    if (!permissions.control) return;
    video.focus();
    video.setPointerCapture?.(event.pointerId);
    const point = actualPoint(event);
    if (point) sendCtl({ t: 'mm', ...point });
    sendCtl({ t: 'md', b: event.button === 2 ? 2 : event.button === 1 ? 1 : 0 });
  });
  video?.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'touch') return;
    if (permissions.control) sendCtl({ t: 'mu', b: event.button === 2 ? 2 : event.button === 1 ? 1 : 0 });
  });
  video?.addEventListener('contextmenu', (event) => event.preventDefault());
  video?.addEventListener('wheel', (event) => {
    event.preventDefault();
    sendCtl({ t: 'wh', dx: event.deltaX, dy: event.deltaY });
  }, { passive: false });
  video?.addEventListener('keydown', (event) => {
    if (!permissions.control) return;
    event.preventDefault();
    sendCtl({ t: 'kd', code: event.code, key: event.key });
  });
  video?.addEventListener('keyup', (event) => {
    if (!permissions.control) return;
    event.preventDefault();
    sendCtl({ t: 'ku', code: event.code, key: event.key });
  });
  video?.addEventListener('touchstart', (event) => {
    touchMoved = false;
    longPressed = false;
    dragStarted = false;
    if (event.touches.length === 1) {
      const touch = event.touches[0];
      const point = actualPoint({ clientX: touch.clientX, clientY: touch.clientY });
      touchStartPoint = point;
      if (point && permissions.control) sendCtl({ t: 'mm', ...point });
      touchTimer = setTimeout(() => {
        if (!touchMoved) {
          longPressed = true;
          sendCtl({ t: 'md', b: 2 });
        }
      }, 650);
    } else if (event.touches.length === 2) {
      clearTimeout(touchTimer);
      touchStartPoint = null;
      lastTouchCentroid = {
        x: (event.touches[0].clientX + event.touches[1].clientX) / 2,
        y: (event.touches[0].clientY + event.touches[1].clientY) / 2
      };
    }
  }, { passive: true });
  video?.addEventListener('touchmove', (event) => {
    touchMoved = true;
    if (event.touches.length === 1) {
      clearTimeout(touchTimer);
      const point = actualPoint({ clientX: event.touches[0].clientX, clientY: event.touches[0].clientY });
      if (point) {
        const start = touchStartPoint;
        const movedEnough = start && Math.hypot(point.x - start.x, point.y - start.y) > 0.008;
        if (movedEnough && !dragStarted && !longPressed && permissions.control) {
          dragStarted = true;
          sendCtl({ t: 'md', b: 0 });
        }
        sendCtl({ t: 'mm', ...point });
      }
    } else if (event.touches.length === 2) {
      const centroid = {
        x: (event.touches[0].clientX + event.touches[1].clientX) / 2,
        y: (event.touches[0].clientY + event.touches[1].clientY) / 2
      };
      if (lastTouchCentroid) sendCtl({ t: 'wh', dx: lastTouchCentroid.x - centroid.x, dy: lastTouchCentroid.y - centroid.y });
      lastTouchCentroid = centroid;
    }
  }, { passive: true });
  video?.addEventListener('touchend', (event) => {
    clearTimeout(touchTimer);
    if (longPressed) sendCtl({ t: 'mu', b: 2 });
    else if (dragStarted) sendCtl({ t: 'mu', b: 0 });
    else if (event.changedTouches.length && !touchMoved) {
      sendCtl({ t: 'md', b: 0 });
      sendCtl({ t: 'mu', b: 0 });
    }
    longPressed = false;
    dragStarted = false;
    touchStartPoint = null;
    lastTouchCentroid = null;
  });
  video?.addEventListener('dragover', (event) => event.preventDefault());
  video?.addEventListener('drop', (event) => {
    event.preventDefault();
    if (event.dataTransfer.files[0]) sendFile(event.dataTransfer.files[0]);
  });
  const toolbar = q('.viewer-bar');
  let hideTimer;
  const showToolbar = () => {
    toolbar?.classList.remove('is-hidden');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => toolbar?.classList.add('is-hidden'), 2500);
  };
  document.addEventListener('pointermove', showToolbar);
  toolbar?.addEventListener('pointerenter', () => toolbar.classList.remove('is-hidden'));
  setInterval(async () => {
    if (!pc || !status) return;
    const stats = await pc.getStats().catch(() => null);
    if (!stats) return;
    let rtt = '';
    let fps = '';
    let relay = 'Direct';
    let selectedPair;
    stats.forEach((entry) => {
      if (entry.type === 'candidate-pair' && entry.state === 'succeeded' && (entry.selected || entry.nominated)) {
        selectedPair = entry;
      }
      if (entry.type === 'inbound-rtp' && entry.kind === 'video' && entry.framesPerSecond) fps = `${Math.round(entry.framesPerSecond)} fps`;
    });
    if (selectedPair) {
      rtt = selectedPair.currentRoundTripTime ? `${Math.round(selectedPair.currentRoundTripTime * 1000)} ms` : '';
      const localCandidate = stats.get(selectedPair.localCandidateId);
      relay = localCandidate?.candidateType === 'relay' ? 'Relay' : 'Direct';
    }
    const statsElement = q('#connection-stats');
    if (statsElement && pc) statsElement.textContent = [relay, rtt, fps].filter(Boolean).join(' · ');
  }, 3000);
  window.addEventListener('beforeunload', () => closeSession());
  if (options.autoConnect !== false && new URLSearchParams(location.search).has('id') && socket.connected) connect();
  return { socket, connect, close: closeSession, get sessionId() { return sessionId; }, get quality() { return quality; } };
}

if (typeof document !== 'undefined' && document.body?.dataset.viewer === 'true') createViewer();
