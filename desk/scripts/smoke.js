const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');

const requireServer = createRequire(path.join(__dirname, '../server/package.json'));
const { io } = requireServer('socket.io-client');
const baseUrl = (process.env.KVDESK_SERVER_URL || 'http://127.0.0.1:3015/remote').replace(/\/+$/, '');
const parsedUrl = new URL(baseUrl);
const socketPath = `${parsedUrl.pathname.replace(/\/+$/, '')}/socket.io` || '/socket.io';
const adminPassword = process.env.ADMIN_PASSWORD || 'test1234';

function connectSocket(extraHeaders = {}) {
  const socket = io(parsedUrl.origin, { path: socketPath, reconnection: false, timeout: 8000, extraHeaders });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    socket.timeout(8000).emit(event, payload, (error, result) => error ? reject(error) : resolve(result));
  });
}

function nextEvent(socket, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, 8000);
    const handler = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

async function jsonRequest(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, options);
  const body = await response.json();
  assert.equal(response.ok, true, `${route} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function waitForOffline(id) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const status = await jsonRequest(`/api/status?ids=${encodeURIComponent(id)}`);
    if (status[id] === false) return status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Device ${id} did not go offline`);
}

async function main() {
  const sockets = [];
  const createdIds = [];
  let adminCookie = '';
  let host;
  try {
    host = await connectSocket();
    sockets.push(host);
    const firstHello = await emitAck(host, 'agent:hello', {
      name: 'Bainsla Remote smoke agent', platform: 'linux', os: process.platform, version: 'smoke'
    });
    assert.equal(firstHello.ok, true);
    assert.match(firstHello.id, /^[1-9]\d{8}$/);
    assert.ok(firstHello.secret);
    createdIds.push(firstHello.id);
    console.log(`PASS agent hello allocated id=${firstHello.id} and secret`);

    const replacement = await connectSocket();
    sockets.push(replacement);
    const secondHello = await emitAck(replacement, 'agent:hello', {
      id: firstHello.id, secret: firstHello.secret, name: 'Bainsla Remote smoke agent',
      platform: 'linux', os: process.platform, version: 'smoke'
    });
    assert.equal(secondHello.ok, true);
    assert.equal(secondHello.id, firstHello.id);
    host = replacement;
    console.log(`PASS old client hello without role preserved agent behavior for id=${secondHello.id}`);

    host.on('session:request', (request) => {
      if (request.password) {
        host.emit('session:answer', { sessionId: request.sessionId, accept: false, reason: 'bad_password' });
      }
    });

    const cookieResponse = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.ADMIN_EMAIL || 'intubemediaofficial@gmail.com', password: adminPassword })
    });
    assert.equal(cookieResponse.ok, true, 'Admin login failed; check ADMIN_PASSWORD');
    adminCookie = (cookieResponse.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(adminCookie, 'Admin cookie missing');
    const alias = `smoke-${Date.now().toString(36)}`;
    await jsonRequest(`/api/admin/devices/${firstHello.id}/rename`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({ name: 'Bainsla Remote smoke agent', alias })
    });
    console.log(`PASS admin assigned alias=${alias}`);

    const onlineStatus = await jsonRequest(`/api/status?ids=${encodeURIComponent(`${firstHello.id},${alias}`)}`);
    assert.equal(onlineStatus[firstHello.id], true);
    assert.equal(onlineStatus[alias], true);
    console.log('PASS /api/status reports numeric ID and alias online');

    const offlineAgent = await connectSocket();
    sockets.push(offlineAgent);
    const offlineHello = await emitAck(offlineAgent, 'agent:hello', { name: 'Offline smoke agent', platform: 'linux' });
    assert.equal(offlineHello.ok, true);
    createdIds.push(offlineHello.id);
    offlineAgent.disconnect();
    const offlineStatus = await waitForOffline(offlineHello.id);
    assert.equal(offlineStatus[offlineHello.id], false);
    console.log(`PASS offline target id=${offlineHello.id}`);

    const viewer = await connectSocket();
    sockets.push(viewer);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const rejected = nextEvent(viewer, 'session:rejected');
      const response = await emitAck(viewer, 'viewer:connect', {
        targetId: alias, password: 'incorrect-password', viewerName: 'Smoke test'
      });
      assert.equal(response.ok, true);
      assert.equal((await rejected).reason, 'bad_password');
    }
    const limited = await emitAck(viewer, 'viewer:connect', {
      targetId: alias, password: 'incorrect-password', viewerName: 'Smoke test'
    });
    assert.deepEqual(limited, { ok: false, error: 'rate_limited' });
    console.log('PASS alias connect resolved server-side; five bad passwords rejected, sixth rate-limited');

    const aliasViewer = await connectSocket({ 'x-forwarded-for': '192.0.2.22' });
    sockets.push(aliasViewer);
    const request = nextEvent(host, 'session:request', (item) => !item.password);
    const hostAccepted = nextEvent(host, 'session:accepted');
    const viewerAccepted = nextEvent(aliasViewer, 'session:accepted');
    const connectResult = await emitAck(aliasViewer, 'viewer:connect', {
      targetId: alias, viewerName: 'Smoke accepted session'
    });
    assert.equal(connectResult.ok, true);
    const incoming = await request;
    assert.equal(incoming.sessionId, connectResult.sessionId);
    host.emit('session:answer', {
      sessionId: incoming.sessionId, accept: true,
      permissions: { control: true, clipboard: true, files: true }
    });
    assert.equal((await hostAccepted).sessionId, connectResult.sessionId);
    assert.equal((await viewerAccepted).sessionId, connectResult.sessionId);
    console.log(`PASS alias connect accepted by both peers session=${connectResult.sessionId}`);

    const viewerCandidate = { candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 };
    const hostSignal = nextEvent(host, 'signal', (data) => data.sessionId === connectResult.sessionId);
    aliasViewer.emit('signal', { sessionId: connectResult.sessionId, data: { candidate: viewerCandidate } });
    assert.equal((await hostSignal).data.candidate.candidate, viewerCandidate.candidate);
    const hostCandidate = { candidate: 'candidate:2 1 udp 2122260223 192.0.2.2 5001 typ host', sdpMid: '0', sdpMLineIndex: 0 };
    const viewerSignal = nextEvent(aliasViewer, 'signal', (data) => data.sessionId === connectResult.sessionId);
    host.emit('signal', { sessionId: connectResult.sessionId, data: { candidate: hostCandidate } });
    assert.equal((await viewerSignal).data.candidate.candidate, hostCandidate.candidate);
    let malformedRelayed = false;
    const onMalformed = (data) => { if (data.sessionId === connectResult.sessionId) malformedRelayed = true; };
    host.on('signal', onMalformed);
    aliasViewer.emit('signal', { sessionId: connectResult.sessionId, data: { candidate: {} } });
    aliasViewer.emit('signal', { sessionId: connectResult.sessionId, data: { candidate: {} } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    host.off('signal', onMalformed);
    assert.equal(malformedRelayed, false);
    console.log('PASS valid ICE candidates relay; malformed candidates are dropped');

    const hostKilled = nextEvent(host, 'session:kill', (data) => data.sessionId === connectResult.sessionId);
    aliasViewer.emit('session:end', { sessionId: connectResult.sessionId, reason: 'smoke_test' });
    await hostKilled;
    const rows = await jsonRequest(`/api/admin/sessions?deviceId=${firstHello.id}`, { headers: { Cookie: adminCookie } });
    const ended = rows.find((row) => row.id === connectResult.sessionId);
    assert.ok(ended?.ended_at);
    console.log(`PASS bidirectional signal relay and persisted ended_at=${ended.ended_at}`);

    const serviceSocket = await connectSocket();
    sockets.push(serviceSocket);
    const serviceHello = await emitAck(serviceSocket, 'agent:hello', {
      role: 'service', name: 'Bainsla Remote service smoke', platform: 'linux', version: 'smoke'
    });
    assert.equal(serviceHello.ok, true);
    createdIds.push(serviceHello.id);
    const handoverViewer = await connectSocket();
    sockets.push(handoverViewer);
    const serviceRequestEvent = nextEvent(serviceSocket, 'session:request');
    const handoverConnect = await emitAck(handoverViewer, 'viewer:connect', {
      targetId: serviceHello.id, viewerName: 'Smoke pending handover'
    });
    assert.equal(handoverConnect.ok, true);
    const pendingRequest = await serviceRequestEvent;

    const sessionAgent = await connectSocket();
    sockets.push(sessionAgent);
    const replayedRequestEvent = nextEvent(sessionAgent, 'session:request');
    const agentHello = await emitAck(sessionAgent, 'agent:hello', {
      role: 'agent', id: serviceHello.id, secret: serviceHello.secret,
      name: 'Bainsla Remote session-agent smoke', platform: 'linux', version: 'smoke'
    });
    assert.equal(agentHello.ok, true);
    const replayedRequest = await replayedRequestEvent;
    assert.deepEqual(replayedRequest, pendingRequest);
    assert.equal(replayedRequest.sessionId, handoverConnect.sessionId);
    const serviceAccepted = nextEvent(sessionAgent, 'session:accepted');
    const handoverViewerAccepted = nextEvent(handoverViewer, 'session:accepted');
    sessionAgent.emit('session:answer', {
      sessionId: replayedRequest.sessionId, accept: true,
      permissions: { control: true, clipboard: true, files: true }
    });
    assert.equal((await serviceAccepted).sessionId, handoverConnect.sessionId);
    assert.equal((await handoverViewerAccepted).sessionId, handoverConnect.sessionId);
    const handoverCandidate = { candidate: 'candidate:3 1 udp 2122260223 192.0.2.3 5002 typ host', sdpMid: '0', sdpMLineIndex: 0 };
    const handoverSignal = nextEvent(handoverViewer, 'signal', (data) => data.sessionId === handoverConnect.sessionId);
    sessionAgent.emit('signal', { sessionId: handoverConnect.sessionId, data: { candidate: handoverCandidate } });
    assert.equal((await handoverSignal).data.candidate.candidate, handoverCandidate.candidate);
    const endHandover = nextEvent(sessionAgent, 'session:kill', (data) => data.sessionId === handoverConnect.sessionId);
    handoverViewer.emit('session:end', { sessionId: handoverConnect.sessionId, reason: 'smoke_test' });
    await endHandover;
    console.log('PASS service-to-agent handover replayed the pending request, accepted it, and relayed signaling');

    const rejectedService = await connectSocket();
    sockets.push(rejectedService);
    const serviceRejected = await emitAck(rejectedService, 'agent:hello', {
      role: 'service', id: serviceHello.id, secret: serviceHello.secret,
      name: 'Bainsla Remote duplicate service smoke', platform: 'linux', version: 'smoke'
    });
    assert.deepEqual(serviceRejected, { ok: false, reason: 'agent_active' });
    const stillOnline = await jsonRequest(`/api/status?ids=${serviceHello.id}`);
    assert.equal(stillOnline[serviceHello.id], true);
    console.log('PASS service hello is rejected while an agent is online');

    console.log('SMOKE TESTS PASSED');
  } finally {
    for (const socket of sockets) socket.disconnect();
    if (createdIds.length) {
      if (!adminCookie) {
        const login = await fetch(`${baseUrl}/api/admin/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: process.env.ADMIN_EMAIL || 'intubemediaofficial@gmail.com', password: adminPassword })
        });
        if (login.ok) adminCookie = (login.headers.get('set-cookie') || '').split(';')[0];
      }
      if (adminCookie) {
        for (const id of new Set(createdIds)) {
          const response = await fetch(`${baseUrl}/api/admin/devices/${encodeURIComponent(id)}`, {
            method: 'DELETE', headers: { Cookie: adminCookie }
          });
          assert.equal(response.ok, true, `Could not remove smoke device ${id}`);
        }
        console.log(`PASS deleted ${new Set(createdIds).size} smoke devices`);
      } else {
        throw new Error('Smoke devices could not be cleaned up because admin login failed');
      }
    }
  }
}

main().catch((error) => {
  console.error('SMOKE TESTS FAILED:', error);
  process.exitCode = 1;
});
