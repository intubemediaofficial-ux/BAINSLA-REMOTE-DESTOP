const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const bcrypt = require('bcryptjs');
const signature = require('cookie-signature');
const multer = require('multer');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3015);
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DOWNLOADS_DIR = path.resolve(process.env.DOWNLOADS_DIR || path.join(DATA_DIR, '..', 'downloads'));
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'intubemediaofficial@gmail.com';
const SESSION_SECRET = process.env.SESSION_SECRET || 'development-only-change-me';
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_HOST = process.env.TURN_HOST || '127.0.0.1';
const WEB_DIR = path.resolve(__dirname, '..', 'web');
const SHARED_DIR = path.resolve(__dirname, '..', 'shared');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'kvdesk.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, name TEXT NOT NULL,
    platform TEXT NOT NULL, os TEXT, version TEXT, ip TEXT, created_at TEXT NOT NULL,
    last_seen TEXT NOT NULL, blocked INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL, viewer_id TEXT, viewer_name TEXT,
    viewer_ip TEXT, mode TEXT NOT NULL, started_at TEXT NOT NULL, accepted_at TEXT,
    ended_at TEXT, end_reason TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS admins (email TEXT PRIMARY KEY, pw_hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS admin_sessions (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at TEXT NOT NULL
  );
`);
if (!db.pragma('table_info(devices)').some((column) => column.name === 'alias')) {
  db.exec('ALTER TABLE devices ADD COLUMN alias TEXT');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS devices_alias_unique ON devices(lower(alias)) WHERE alias IS NOT NULL');
const settingDefaults = {
  app_name: 'Bainsla Remote', win_version: '1.0.0', win_file: '', apk_version: '', apk_file: '',
  mac_version: '', mac_arm64_file: '', mac_x64_file: '', announcement: ''
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(settingDefaults)) insertSetting.run(key, value);
if (process.env.ADMIN_PASSWORD) {
  const existing = db.prepare('SELECT email FROM admins LIMIT 1').get();
  if (!existing) {
    db.prepare('INSERT INTO admins(email, pw_hash) VALUES (?, ?)').run(
      ADMIN_EMAIL.toLowerCase(), bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12)
    );
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  if (BASE_PATH && (req.path === BASE_PATH || req.path.startsWith(`${BASE_PATH}/`))) {
    req.url = req.url.slice(BASE_PATH.length) || '/';
  } else if (BASE_PATH && req.path !== '/health') {
    return next();
  }
  next();
});
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/download', express.static(DOWNLOADS_DIR, {
  fallthrough: false,
  index: false,
  setHeaders: (res, filePath) => {
    if (path.extname(filePath).toLowerCase() === '.dmg') {
      res.setHeader('Content-Type', 'application/x-apple-diskimage');
    }
  }
}));
app.use('/shared', express.static(SHARED_DIR, { fallthrough: false }));
app.use(express.static(WEB_DIR, { index: false, fallthrough: true }));

const online = new Map();
const sessions = new Map();
const malformedCandidateWarnings = new Set();
const failedAttempts = new Map();
const nowIso = () => new Date().toISOString();
db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(nowIso());
const adminSessionGet = db.prepare('SELECT email, expires_at FROM admin_sessions WHERE id = ?');
const adminSessionDelete = db.prepare('DELETE FROM admin_sessions WHERE id = ?');
const prefixed = (route) => `${BASE_PATH}${route}` || '/';
const publicSettings = () => Object.fromEntries(
  db.prepare('SELECT key, value FROM settings').all().map(({ key, value }) => [key, value])
);
const socketIp = (socket) => (socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '')
  .toString().split(',')[0].trim();
const newId = () => {
  let id;
  do { id = String(100000000 + crypto.randomInt(900000000)); }
  while (db.prepare('SELECT id FROM devices WHERE id = ?').get(id));
  return id;
};
const makeIceServers = () => {
  const urls = [
    `stun:${TURN_HOST}:3478`,
    `turn:${TURN_HOST}:3478?transport=udp`,
    `turn:${TURN_HOST}:3478?transport=tcp`
  ];
  if (!TURN_SECRET) return [{ urls: urls[0] }];
  const username = `${Math.floor(Date.now() / 1000) + 86400}:kvdesk`;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return [{ urls, username, credential }];
};
const adminSession = (req) => {
  const raw = req.headers.cookie || '';
  const match = raw.match(/(?:^|;\s*)kvdesk_admin=([^;]+)/);
  if (!match) return null;
  const value = decodeURIComponent(match[1]);
  const id = signature.unsign(value, SESSION_SECRET);
  if (!id) return null;
  const session = adminSessionGet.get(id);
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
    adminSessionDelete.run(id);
    return null;
  }
  return { email: session.email, expiresAt: session.expires_at };
};
const requireAdmin = (req, res, next) => {
  const session = adminSession(req);
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  req.admin = session;
  next();
};
const settingsGet = db.prepare('SELECT value FROM settings WHERE key = ?');
const settingsSet = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
const updateSessionEnd = db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL');

app.get('/api/ice', (_req, res) => res.json({ iceServers: makeIceServers() }));
app.get('/api/status', (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean);
  const result = {};
  for (const target of ids) {
    const device = db.prepare('SELECT id FROM devices WHERE id = ? OR lower(alias) = lower(?)').get(target, target);
    result[target] = Boolean(device && online.has(device.id));
  }
  res.json(result);
});
app.get('/api/settings/public', (_req, res) => {
  const {
    app_name, win_version, win_file, apk_version, apk_file,
    mac_version, mac_arm64_file, mac_x64_file, announcement
  } = publicSettings();
  res.json({ app_name, win_version, win_file, apk_version, apk_file, mac_version, mac_arm64_file, mac_x64_file, announcement,
    win_url: win_file ? prefixed(`/download/${encodeURIComponent(win_file)}`) : '',
    apk_url: apk_file ? prefixed(`/download/${encodeURIComponent(apk_file)}`) : '',
    mac_arm64_url: mac_arm64_file ? prefixed(`/download/${encodeURIComponent(mac_arm64_file)}`) : '',
    mac_x64_url: mac_x64_file ? prefixed(`/download/${encodeURIComponent(mac_x64_file)}`) : '' });
});
app.post('/api/admin/login', (req, res) => {
  const email = String(req.body?.email || '').toLowerCase();
  const password = String(req.body?.password || '');
  const admin = db.prepare('SELECT email, pw_hash FROM admins WHERE email = ?').get(email);
  if (!admin || !bcrypt.compareSync(password, admin.pw_hash)) return res.status(401).json({ error: 'invalid_credentials' });
  const id = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
  db.prepare('INSERT INTO admin_sessions(id, email, expires_at) VALUES (?, ?, ?)').run(id, admin.email, expiresAt);
  res.setHeader('Set-Cookie', `kvdesk_admin=${encodeURIComponent(signature.sign(id, SESSION_SECRET))}; Path=${BASE_PATH || '/'}; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  res.json({ ok: true, email: admin.email });
});
app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const cookie = (req.headers.cookie || '').match(/(?:^|;\s*)kvdesk_admin=([^;]+)/);
  const id = cookie && signature.unsign(decodeURIComponent(cookie[1]), SESSION_SECRET);
  if (id) adminSessionDelete.run(id);
  res.setHeader('Set-Cookie', `kvdesk_admin=; Path=${BASE_PATH || '/'}; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});
app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ email: req.admin.email }));
app.get('/api/admin/dashboard', requireAdmin, (_req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  res.json({
    online: online.size,
    devices: db.prepare('SELECT COUNT(*) AS count FROM devices').get().count,
    sessionsToday: db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE started_at >= ?').get(today.toISOString()).count,
    activeSessions: db.prepare('SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC').all()
  });
});
app.get('/api/admin/devices', requireAdmin, (req, res) => {
  const search = `%${String(req.query.search || '').trim()}%`;
  const rows = db.prepare(`SELECT * FROM devices WHERE id LIKE ? OR name LIKE ? OR alias LIKE ? ORDER BY last_seen DESC`).all(search, search, search);
  res.json(rows.map((device) => ({ ...device, online: online.has(device.id) })));
});
app.post('/api/admin/devices/:id/rename', requireAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 120);
  const alias = String(req.body?.alias || '').trim().toLowerCase() || null;
  if (!name) return res.status(400).json({ error: 'name_required' });
  if (alias && !/^[a-z0-9-]{3,32}$/.test(alias)) return res.status(400).json({ error: 'invalid_alias' });
  try {
    const result = db.prepare('UPDATE devices SET name = ?, alias = ? WHERE id = ?').run(name, alias, req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'not_found' });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'alias_taken' });
    throw error;
  }
  online.get(req.params.id)?.emit('agent:renamed', { name, alias });
  res.json({ ok: true });
});
app.post('/api/admin/devices/:id/block', requireAdmin, (req, res) => {
  const device = db.prepare('SELECT id FROM devices WHERE id = ?').get(req.params.id);
  if (!device) return res.status(404).json({ error: 'not_found' });
  db.prepare('UPDATE devices SET blocked = 1 WHERE id = ?').run(device.id);
  online.get(device.id)?.emit('agent:blocked');
  for (const session of sessions.values()) {
    if (session.deviceId === device.id) endSession(session, 'blocked');
  }
  res.json({ ok: true });
});
app.post('/api/admin/devices/:id/unblock', requireAdmin, (req, res) => {
  db.prepare('UPDATE devices SET blocked = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
app.delete('/api/admin/devices/:id', requireAdmin, (req, res) => {
  for (const session of sessions.values()) if (session.deviceId === req.params.id) endSession(session, 'deleted');
  const result = db.prepare('DELETE FROM devices WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});
app.get('/api/admin/sessions', requireAdmin, (req, res) => {
  const deviceId = String(req.query.deviceId || '');
  const rows = deviceId
    ? db.prepare('SELECT * FROM sessions WHERE device_id = ? OR viewer_id = ? ORDER BY started_at DESC').all(deviceId, deviceId)
    : db.prepare('SELECT * FROM sessions ORDER BY started_at DESC').all();
  res.json(rows);
});
app.post('/api/admin/sessions/:id/kill', requireAdmin, (req, res) => {
  const session = sessions.get(req.params.id);
  if (session) endSession(session, 'admin_kill');
  else updateSessionEnd.run(nowIso(), 'admin_kill', req.params.id);
  res.json({ ok: true });
});
app.get('/api/admin/settings', requireAdmin, (_req, res) => res.json(publicSettings()));
app.post('/api/admin/settings', requireAdmin, (req, res) => {
  for (const key of ['app_name', 'win_version', 'apk_version', 'mac_version', 'announcement']) {
    if (req.body?.[key] !== undefined) settingsSet.run(key, String(req.body[key]));
  }
  res.json({ ok: true });
});
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, DOWNLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = req.params.kind.startsWith('mac-')
      ? '.dmg'
      : path.extname(file.originalname).slice(0, 16).replace(/[^.a-zA-Z0-9]/g, '');
    const name = `${req.params.kind}-${Date.now()}${ext}`;
    req.uploadedName = name;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (req.params.kind.startsWith('mac-') && path.extname(file.originalname).toLowerCase() !== '.dmg') {
      return cb(null, false);
    }
    cb(null, true);
  }
});
app.post('/api/admin/settings/upload/:kind', requireAdmin, (req, res, next) => {
  if (!['win', 'apk', 'mac-arm64', 'mac-x64'].includes(req.params.kind)) {
    return res.status(400).json({ error: 'invalid_kind' });
  }
  next();
}, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file_required' });
  const key = {
    win: 'win_file',
    apk: 'apk_file',
    'mac-arm64': 'mac_arm64_file',
    'mac-x64': 'mac_x64_file'
  }[req.params.kind];
  settingsSet.run(key, req.file.filename);
  res.json({ ok: true, file: req.file.filename });
});
app.post('/api/admin/password', requireAdmin, (req, res) => {
  const oldPassword = String(req.body?.oldPassword || '');
  const password = String(req.body?.password || '');
  if (password.length < 8) return res.status(400).json({ error: 'password_too_short' });
  const admin = db.prepare('SELECT pw_hash FROM admins WHERE email = ?').get(req.admin.email);
  if (!bcrypt.compareSync(oldPassword, admin.pw_hash)) return res.status(400).json({ error: 'invalid_password' });
  db.prepare('UPDATE admins SET pw_hash = ? WHERE email = ?').run(bcrypt.hashSync(password, 12), req.admin.email);
  res.json({ ok: true });
});
app.get(['/admin', '/admin/'], (_req, res) => res.sendFile(path.join(WEB_DIR, 'admin', 'index.html')));
app.get(['/v', '/v/'], (_req, res) => res.sendFile(path.join(WEB_DIR, 'v', 'index.html')));
app.get('/share', (req, res) => (req.originalUrl.split('?')[0].endsWith('/')
  ? res.sendFile(path.join(WEB_DIR, 'share', 'index.html'))
  : res.redirect(301, prefixed('/share/'))));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/download/') || req.path.startsWith('/shared/')) return next();
  res.sendFile(path.join(WEB_DIR, 'index.html'), (err) => err && next(err));
});
app.use((err, _req, res, _next) => {
  if (err.status === 404) return res.status(404).json({ error: 'not_found' });
  console.error(err);
  res.status(err.status || 500).json({ error: 'internal_error' });
});

const server = http.createServer(app);
const io = new Server(server, { path: `${BASE_PATH}/socket.io` || '/socket.io', cors: { origin: true, credentials: true } });
const socketsForSession = (session) => [session.hostSocket, session.viewerSocket].filter(Boolean);
function endSession(session, reason) {
  if (!session || session.ended) return;
  session.ended = true;
  malformedCandidateWarnings.delete(session.id);
  updateSessionEnd.run(nowIso(), reason || 'ended', session.id);
  for (const socket of socketsForSession(session)) socket.emit('session:kill', { sessionId: session.id, reason });
  session.hostSocket?.leave(session.id);
  session.viewerSocket?.leave(session.id);
  sessions.delete(session.id);
}
function finishRejected(session, reason) {
  session.viewerSocket?.emit('session:rejected', { sessionId: session.id, reason });
  session.hostSocket?.emit('session:closed', { sessionId: session.id, reason });
  updateSessionEnd.run(nowIso(), reason, session.id);
  sessions.delete(session.id);
  if (reason === 'bad_password') {
    const key = `${session.viewerIp}|${session.deviceId}`;
    const timestamp = Date.now();
    const attempt = failedAttempts.get(key) || { count: 0, resetAt: 0, until: 0 };
    if (attempt.resetAt <= timestamp) {
      attempt.count = 0;
      attempt.resetAt = timestamp + 10 * 60 * 1000;
    }
    attempt.count += 1;
    if (attempt.count >= 5) {
      attempt.count = 0;
      attempt.until = timestamp + 10 * 60 * 1000;
      attempt.resetAt = attempt.until;
    }
    failedAttempts.set(key, attempt);
  }
}
io.on('connection', (socket) => {
  socket.on('agent:hello', (payload = {}, ack = () => {}) => {
    const id = String(payload.id || '');
    const device = id && db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    const role = payload.role === 'service' ? 'service' : 'agent';
    if (device?.blocked) return ack({ ok: false, error: 'blocked' });
    if (id && !device) return ack({ ok: false, error: 'not_found' });
    if (device && payload.secret && crypto.createHash('sha256').update(String(payload.secret)).digest('hex') === device.secret_hash) {
      const previous = online.get(id);
      if (role === 'service' && previous && previous.data.role !== 'service') {
        return ack({ ok: false, reason: 'agent_active' });
      }
      socket.data.deviceId = id;
      socket.data.role = role;
      online.set(id, socket);
      if (previous && previous !== socket) {
        if (role === 'agent' && previous.data.role === 'service') {
          for (const session of sessions.values()) {
            if (session.deviceId !== id || session.hostSocket !== previous || session.accepted || session.ended) continue;
            previous.leave(session.id);
            session.hostSocket = socket;
            socket.join(session.id);
            socket.emit('session:request', session.requestPayload);
          }
        }
        previous.emit('agent:replaced');
        previous.disconnect(true);
      }
      const updated = { name: String(payload.name || device.name), platform: String(payload.platform || device.platform),
        os: String(payload.os || device.os || ''), version: String(payload.version || device.version || ''), ip: socketIp(socket) };
      db.prepare('UPDATE devices SET name = ?, platform = ?, os = ?, version = ?, ip = ?, last_seen = ? WHERE id = ?')
        .run(updated.name, updated.platform, updated.os, updated.version, updated.ip, nowIso(), id);
      return ack({ ok: true, id, iceServers: makeIceServers() });
    }
    if (id) return ack({ ok: false, error: 'invalid_secret' });
    const allocatedId = newId();
    const secret = crypto.randomBytes(32).toString('hex');
    const timestamp = nowIso();
    db.prepare(`INSERT INTO devices(id, secret_hash, name, platform, os, version, ip, created_at, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      allocatedId, crypto.createHash('sha256').update(secret).digest('hex'),
      String(payload.name || 'Bainsla Remote device').slice(0, 120), String(payload.platform || 'linux'),
      String(payload.os || ''), String(payload.version || ''), socketIp(socket), timestamp, timestamp
    );
    socket.data.deviceId = allocatedId;
    socket.data.role = role;
    online.set(allocatedId, socket);
    ack({ ok: true, id: allocatedId, secret, iceServers: makeIceServers() });
  });
  socket.on('agent:update', (payload = {}) => {
    if (!socket.data.deviceId) return;
    const name = String(payload.name || '').trim().slice(0, 120);
    if (name) db.prepare('UPDATE devices SET name = ?, last_seen = ? WHERE id = ?').run(name, nowIso(), socket.data.deviceId);
  });
  socket.on('viewer:connect', (payload = {}, ack = () => {}) => {
    const targetId = String(payload.targetId || '');
    const target = db.prepare('SELECT * FROM devices WHERE id = ? OR lower(alias) = lower(?)').get(targetId, targetId);
    if (!target) return ack({ ok: false, error: 'not_found' });
    if (target.blocked) return ack({ ok: false, error: 'blocked' });
    const ip = socketIp(socket);
    const key = `${ip}|${target.id}`;
    const attempt = failedAttempts.get(key);
    if (attempt?.until > Date.now()) return ack({ ok: false, error: 'rate_limited' });
    const host = online.get(target.id);
    if (!host?.connected) return ack({ ok: false, error: 'offline' });
    const id = crypto.randomUUID();
    const viewerId = String(payload.viewerId || '');
    const record = {
      id, deviceId: target.id, viewerId: viewerId || null, viewerName: String(payload.viewerName || 'Viewer').slice(0, 120),
      viewerIp: ip, hostSocket: host, viewerSocket: socket, mode: 'attended', accepted: false, ended: false,
      password: payload.password,
      requestPayload: {
        sessionId: id, viewerName: String(payload.viewerName || 'Viewer').slice(0, 120),
        viewerId, password: payload.password || ''
      }
    };
    sessions.set(id, record);
    socket.join(id);
    host.join(id);
    db.prepare(`INSERT INTO sessions(id, device_id, viewer_id, viewer_name, viewer_ip, mode, started_at)
      VALUES (?, ?, ?, ?, ?, 'attended', ?)`).run(id, target.id, viewerId || null, record.viewerName, ip, nowIso());
    host.emit('session:request', record.requestPayload);
    ack({ ok: true, sessionId: id });
  });
  socket.on('session:answer', (payload = {}) => {
    const session = sessions.get(String(payload.sessionId));
    if (!session || session.hostSocket !== socket) return;
    if (!payload.accept) return finishRejected(session, payload.reason || 'rejected');
    session.accepted = true;
    session.mode = payload.mode === 'unattended' ? 'unattended' : 'attended';
    db.prepare('UPDATE sessions SET mode = ?, accepted_at = ? WHERE id = ?')
      .run(session.mode, nowIso(), session.id);
    failedAttempts.delete(`${session.viewerIp}|${session.deviceId}`);
    const hostInfo = db.prepare('SELECT name, platform FROM devices WHERE id = ?').get(session.deviceId);
    const accepted = {
      sessionId: session.id, permissions: payload.permissions || { control: true, clipboard: true, files: true },
      iceServers: makeIceServers(),
      hostInfo: { name: hostInfo?.name || 'Bainsla Remote', platform: hostInfo?.platform || 'unknown' }
    };
    session.viewerSocket.emit('session:accepted', accepted);
    session.hostSocket.emit('session:accepted', accepted);
  });
  socket.on('signal', (payload = {}) => {
    const session = sessions.get(String(payload.sessionId));
    if (!session || !session.accepted) return;
    const peer = session.hostSocket === socket ? session.viewerSocket : session.viewerSocket === socket ? session.hostSocket : null;
    if (!peer) return;
    if (!payload.data?.sdp && typeof payload.data?.candidate?.candidate !== 'string') {
      if (!malformedCandidateWarnings.has(session.id)) {
        malformedCandidateWarnings.add(session.id);
        console.warn(`[signal] dropped candidate without candidate string for session ${session.id}`);
      }
      return;
    }
    peer.emit('signal', { sessionId: session.id, data: payload.data });
  });
  socket.on('session:end', (payload = {}) => {
    const session = sessions.get(String(payload.sessionId));
    if (session && socketsForSession(session).includes(socket)) endSession(session, payload.reason || 'ended');
  });
  socket.on('disconnect', () => {
    const id = socket.data.deviceId;
    if (id && online.get(id) === socket) online.delete(id);
    for (const session of [...sessions.values()]) {
      if (socketsForSession(session).includes(socket)) endSession(session, 'disconnect');
    }
    if (id) db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(nowIso(), id);
  });
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Bainsla Remote listening on :${PORT}${BASE_PATH || '/'}`);
});
