# Bainsla Remote — AnyDesk-style remote desktop (self-hosted)

Owner: Vijendra (Bainsla Music). Product name "Bainsla Remote" (editable in admin Settings).
Requirements from owner: full control like AnyDesk, **no limits** (no session time limit, no device/connection caps),
**24h unattended access** (password, autostart, auto-reconnect), Windows .exe + web panel, Android APK (viewer + host).
UI must be "neat and clean": few screens, short labels, English UI.

## Monorepo layout
```
server/      Node 20 Express + socket.io 4 + better-sqlite3 (signaling, REST, admin, static web)
web/         static files served by server: landing, browser viewer, admin SPA (vanilla JS/CSS, no framework)
shared/      viewer.js + protocol.js used by BOTH web viewer and Electron renderer (copied/bundled into agent)
agent/       Electron Windows app (host + viewer), electron-builder NSIS -> BainslaRemote-Setup-<ver>.exe
android/     (phase 2) native Kotlin app: viewer + host (MediaProjection + AccessibilityService)
scripts/     deploy-vps.sh, coturn setup
```

## Production
- VPS 205.209.115.156, pm2 app `remote`, port **3015** (127.0.0.1), dir /root/remote/{releases,app,data,downloads,.env}
- Public: https://remote.bainslamusic.com (BASE_PATH=/remote). socket.io path `/remote/socket.io`.
- nginx `location /remote/` in BOTH server blocks of /etc/nginx/sites-enabled/kvspt (websocket Upgrade, 3600s timeouts, 200m body), copy the existing `/chat/` block style. Backup config first.
- Downloads: /root/remote/downloads served by the Node app at `/remote/download/<file>` (nginx cannot read /root; serve via express.static).
- TURN: coturn on the VPS, listening 3478 udp+tcp, relay ports 49160-49400 udp; ufw allow those. `use-auth-secret`, `static-auth-secret=$TURN_SECRET`, `realm=kvspt.com`, `external-ip=205.209.115.156`, no-cli, no-multicast-peers, deny private relay ranges (denied-peer-ip 10/8,172.16/12,192.168/16,127/8). Cloudflare does not proxy UDP → ICE URLs use the raw IP.
- .env: PORT, BASE_PATH, DATA_DIR=/root/remote/data, PUBLIC_ORIGIN=https://kvspt.com, ADMIN_EMAIL=intubemediaofficial@gmail.com, ADMIN_PASSWORD (first run seed only), SESSION_SECRET, TURN_SECRET, TURN_HOST=205.209.115.156.

## Data (SQLite, DATA_DIR/kvdesk.db)
- devices(id TEXT PK — 9 digits, never starting with 0; secret_hash; name; platform 'windows'|'mac'|'android'|'linux'|'web';
  os; version; ip; created_at; last_seen; blocked INT default 0)
  Online state is in-memory (map id -> socket), not a column.
- sessions(id TEXT PK uuid, device_id, viewer_id NULL (device id when the viewer is an agent), viewer_name, viewer_ip,
  mode 'attended'|'unattended', started_at, accepted_at NULL, ended_at NULL, end_reason)
- settings(key PK, value): app_name, win_version, win_file, apk_version, apk_file, mac_version, mac_arm64_file, mac_x64_file, announcement
- admins(email PK, pw_hash) — seeded from env on first run (bcryptjs).
- failed_attempts in-memory: key `${ip}|${targetId}` → 5 bad passwords / 10 min ⇒ `rate_limited` for 10 min.

## Signaling protocol (socket.io, one namespace)
All payloads JSON. Server never sees media; only forwards between the two parties of a session.

Agent (host side; Windows/Android/also the Electron app when acting as viewer uses the same socket):
- `agent:hello {id?, secret?, name, platform, os, version}` → ack `{ok, id, secret?, iceServers}`;
  unknown/missing id or bad secret ⇒ allocate new 9-digit id + 32-byte random secret (returned once, store locally; server keeps sha256).
  Blocked ⇒ ack `{ok:false, error:'blocked'}`. Same id connecting twice ⇒ newest socket wins, old one gets `agent:replaced` and disconnects.
- `agent:update {name}` (rename).
Viewer (browser or agent):
- `viewer:connect {targetId, password?, viewerName, viewerId?}` → ack `{ok, sessionId}` or `{ok:false, error}`
  errors: offline | not_found | blocked | rate_limited | busy? (no — multiple viewers allowed; no limits).
  Server emits to host `session:request {sessionId, viewerName, viewerId, password?}`.
- host replies `session:answer {sessionId, accept:bool, reason?, permissions:{control,clipboard,files}}`
  Host logic: if password given and matches the locally stored scrypt hash ⇒ auto accept (mode unattended);
  wrong password ⇒ reject reason `bad_password` (server counts it); no password ⇒ show Accept/Reject popup (30 s timeout ⇒ `timeout`).
- Server → viewer `session:accepted {sessionId, permissions, iceServers, hostInfo:{name,platform}}` or `session:rejected {sessionId, reason}`.
- `signal {sessionId, data}` both directions (data = {sdp} | {candidate}); server checks the sender is a party.
- `session:end {sessionId, reason?}` either side; socket disconnect ends all its sessions (end_reason 'disconnect').
- Admin actions push `session:kill {sessionId}` to both parties and `agent:blocked` to a blocked device.
- Host is the WebRTC **offerer** (after accept): adds video track, creates data channels `ctl` (ordered, reliable) and `file` (ordered, reliable, binary).
- ICE servers: `stun:TURN_HOST:3478`, `turn:TURN_HOST:3478?transport=udp`, `turn:TURN_HOST:3478?transport=tcp`, TURN REST creds:
  username=`${unixExpiry(+24h)}:kvdesk`, credential=base64(HMAC-SHA1(TURN_SECRET, username)). Re-fetched per session (no 24h limit on running sessions — TURN allocations refresh fine once created).

## `ctl` data channel messages
Coordinates normalized 0..1 relative to the currently shared screen.
- viewer→host: `{t:'mm',x,y}` move, `{t:'md'|'mu',b}` (0 left,1 middle,2 right), `{t:'wh',dx,dy}`, `{t:'kd'|'ku',code,key}` (KeyboardEvent.code/key),
  `{t:'combo',k:'cad'|'win'|'alt-tab'|'printscreen'}`, `{t:'clip',text}`, `{t:'chat',text}`, `{t:'screen',id}`, `{t:'quality',q:'auto'|'high'|'balanced'|'low'}`,
  android host extras: `{t:'nav',k:'back'|'home'|'recents'}`, touch = md/mm/mu with b=0 (host turns into gestures).
- host→viewer: `{t:'screens',list:[{id,name,w,h,primary}],current}`, `{t:'clip',text}`, `{t:'chat',text}`, `{t:'perm',control,clipboard,files}`, `{t:'cursor',x,y}` optional.
- file transfer (both directions): ctl `{t:'fs',id,name,size}` then binary chunks 16 KiB on `file` (prefix 0 bytes; one transfer at a time per direction, backpressure via bufferedAmountLowThreshold), then ctl `{t:'fe',id}`. Receiver on Windows saves to Downloads\Bainsla Remote\; browser receiver triggers a download.
- Quality: high = native res, 30 fps, ~8 Mbps; balanced = max 1600 px wide, 24 fps, 3 Mbps; low = max 1280, 15 fps, 1 Mbps; auto = balanced + browser congestion control. Applied host-side via RTCRtpSender.setParameters (maxBitrate, scaleResolutionDownBy, maxFramerate).

## Web (served under BASE_PATH)
- `/` landing: big "Remote Desk ID" input + optional password + Connect (opens viewer), Windows, Android, and macOS download buttons (from settings), 3-line feature list. macOS selects Apple Silicon when architecture is unknown and offers an Intel link when both DMGs are set. Neat, dark theme: background #0f172a, card #111827, accent #ef4444 (AnyDesk-like red), white text.
- `/v/?id=123456789` browser viewer (shared/viewer.js): connecting state, "Waiting for accept…", video fit-to-window with correct letterbox mapping of pointer → normalized coords, keyboard capture when focused (preventDefault, pointer lock not needed), toolbar (auto-hide top bar): screen picker, quality, fullscreen, Ctrl+Alt+Del/Win/Alt+Tab menu, clipboard send, chat panel, file send (input type=file + drag-drop), disconnect, connection stats (RTT, fps, relay/direct). Mobile browsers: touch → mouse (tap=click, long-press=right click, two-finger scroll), on-screen keyboard button.
- `/admin` admin SPA: login (email+password, httpOnly signed cookie session, 30 days), tabs: Dashboard (online now, total devices, sessions today, active sessions list with Kill), Devices (search; id, name, platform, version, online dot, last seen, ip; actions Rename, Block/Unblock, Delete), Sessions (history, filter by device, duration, end reason), Settings (app name, Windows/Android/macOS versions + upload installer files to downloads dir, announcement text, change admin password).
- REST under `/api`: `/api/ice` (requires agent or viewer socket token? → simple: open, returns short-lived creds), `/api/settings/public`, `/api/admin/*` (auth).
- Socket auth for admin pushes: admin dashboard uses REST polling every 5 s (keep simple).

## Windows agent (Electron)
- Main window 900×600, single-instance, closes to tray (tray menu: Open, Copy ID, Quit). `--hidden` arg starts in tray.
- Home screen: "This Desk" card: ID shown as `123 456 789` (copy button), device name, status dot (Online/Connecting), "Set password for unattended access" (scrypt hash + salt stored in userData/config.json; show "Unattended access: On/Off"). "Remote Desk" card: ID input + Connect (opens viewer window using shared/viewer.js; password prompt appears if host rejects with bad_password/asks). Recent connections list (last 10, click to connect).
- Settings: device name, start with Windows (default ON, app.setLoginItemSettings openAtLogin + args ['--hidden']), allow control / clipboard / files defaults, server URL (default https://remote.bainslamusic.com), version + update link.
- Incoming request popup (always-on-top small window): viewer name/id, Accept / Reject, permission checkboxes, 30 s countdown.
- While a session is active: small always-on-top bar "Remote session: <viewer> — [Chat] [Disconnect]".
- Capture: desktopCapturer.getSources({types:['screen']}) + getUserMedia chromeMediaSource desktop (or setDisplayMediaRequestHandler), per display; send screens list; switch via replaceTrack.
- Input: `@nut-tree-fork/nut-js` (N-API prebuilt, no rebuild) in the MAIN process via IPC from renderer. Map normalized → display.bounds (DIP) → physical with `screen.dipToScreenPoint` on Windows. Mouse speed 0 / autoDelay 0. Key map KeyboardEvent.code → nut Key enum (letters, digits, F1-F12, arrows, modifiers, Enter, Esc, Tab, Backspace, Delete, Home/End/PgUp/PgDn, Space, punctuation). Ctrl+Alt+Del cannot be injected from user mode (known limitation; show toast). 
- Clipboard: electron clipboard, poll 1 s on host and send changes when permission on; viewer applies received text.
- Socket: socket.io-client with infinite reconnection (reconnectionDelayMax 10 s); re-hello on reconnect. Must survive sleep/network changes.
- Packaging: electron-builder, appId com.kvspt.kvdesk, productName "Bainsla Remote", NSIS (oneClick false, allow change dir, desktop + start menu shortcuts, perMachine false), icon build/icon.ico, artifact `BainslaRemote-Setup-${version}.exe`. Built on Linux with wine.
- Known limits: lock-screen/UAC control is not supported; Electron cannot capture the Winlogon secure desktop and a native C++ helper is required.

## macOS agent (same Electron app, agent/mac.js)
- `agent:hello` reports `platform:'mac'` when `process.platform === 'darwin'`.
- Input: Electron display bounds are global points, the same space as CGEvent, so no DIP→pixel conversion on Retina (that is Windows-only). Drags use mouse-dragged events and double-clicks set the click count.
- Permissions: on start check `systemPreferences.getMediaAccessStatus('screen')` and `isTrustedAccessibilityClient(false)`; call `isTrustedAccessibilityClient(true)` once to prompt. While either is missing the main window shows a card with buttons opening `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture` / `?Privacy_Accessibility`, re-checked every 3 s. No Screen Recording → `session:answer {accept:false, reason:'mac_screen_recording_not_allowed'}`; no Accessibility → accepted with `control:false`.
- Autostart: per-user LaunchAgent `~/Library/LaunchAgents/com.kvspt.kvdesk.plist` (label `com.kvspt.kvdesk`, `RunAtLoad`, `KeepAlive {SuccessfulExit:false}`, `LimitLoadToSessionType Aqua`, args `<exe> --hidden --launchd`), bootstrapped into `gui/<uid>`; `setLoginItemSettings` is not used on mac. A copy opened from Finder hands over to the launchd job (releases the single-instance lock, bootstraps/kickstarts it, exits) so only the restartable instance runs. Autostart off → plist removed and job booted out. Not installed when running from `/Volumes` or AppTranslocation.
- Tray: template image `build/trayTemplate.png` (+@2x) for light/dark menu bars; during a session the menu bar title shows “● Remote session active” and the always-on-top session bar is shown on all Spaces.
- Packaging: `dist:mac` = `electron-builder --mac dmg --x64 --arm64`, `identity: null`, category `public.app-category.utilities`, icon `build/icon.icns`, artifact `BainslaRemote-${version}-${arch}.dmg`; `afterPack` ad-hoc signs the app.
- Packaged viewer: `scripts/copy-shared.js` (prestart, predist:win, predist:mac) copies `../shared` → `vendor/shared/` and `../web/style.css` → `vendor/web-style.css`; `viewer.html` / `viewer-renderer.js` load from `vendor/`.

## Android companion app — android/
- Native Kotlin + Gradle Kotlin DSL, package `com.kvspt.kvdesk`, minSdk 26, targetSdk 34, app name "Bainsla Remote". Exactly two tabs: **Connect** and **This phone**; server URL and device name are edited in a settings sheet.
- Libraries: latest stable 1.x `io.getstream:stream-webrtc-android` (`org.webrtc`), `io.socket:socket.io-client:2.1.1` (Socket.IO v4 server), Material3 Compose, and kotlinx coroutines.
- Same host protocol as Windows: `agent:hello` with `platform:'android'`, then `session:request`/`session:answer`, `signal`, `ctl` and `file` channels. The phone viewer uses the existing `/v/` WebView and the browser's existing data-channel messages.
- Viewer saved desks use EncryptedSharedPreferences for saved passwords, online status (`/api/status`), and auto-connect. Credentials are entered into the WebView only after it loads and are sent only in `viewer:connect`, not in the page URL.
- `DeskService` is a foreground `dataSync|mediaProjection` service. It keeps the socket online with auto-reconnect, registers the permanent 9-digit ID and secret, and posts request notifications with Accept/Reject. A matching fixed unattended password auto-accepts; the password is PBKDF2-hashed and stored in encrypted preferences.
- MediaProjection uses one `ScreenCapturerAndroid` and `VideoSource` for the service lifetime, at up to 1280 px long-side and 20 fps. The AccessibilityService maps normalized touch gestures, scroll, text keys and navigation actions. BOOT_COMPLETED starts the service; battery-optimization exemption is requested in-app.
- Android requires a user tap on the screen-capture “Start now” dialog after every reboot and, on Android 14+, every new capture session. Bainsla Remote keeps the projection alive across sessions while its service runs. If permission is absent when a request arrives, it rejects that request and posts “Tap to allow screen sharing.”
- Release signing key: `~/kvdesk-keys/kvdesk-release.jks`, alias `kvdesk`, outside the repo; Gradle reads the keystore path/passwords from environment variables. `cd android && ./gradlew lint test` runs local checks; `./gradlew assembleRelease` writes `app/build/outputs/apk/release/BainslaRemote-1.0.0.apk`.

## ADDENDUM (owner requests after initial spec)
### Fixed ID + fixed password (no rotation)
- Device id is allocated once and is permanent (already so). The unattended password the owner sets is permanent — it NEVER rotates or expires. No "temporary password" feature.
- Admin panel can set a human **alias** per device (e.g. `staff-rajesh`): unique, letters/digits/hyphen, 3–32 chars. Viewers may connect by alias OR numeric id. `aliases` stored in devices.alias column (unique, nullable). Agent `viewer:connect {targetId}` resolves alias→id server-side.
### Auto-connect address book (viewer side)
- Both the Electron viewer and the browser landing keep a saved list (Electron: userData/book.json; browser: localStorage) of entries {id/alias, label, password?, autoConnect:bool}. Password stored locally only (never on server).
- Address book UI: list with online/offline dot (poll `/api/status?ids=...` every 5 s → server returns which ids are online). Click = connect. Per-entry: Edit, Remove, "Auto-connect" toggle.
- Auto-connect: when an entry with autoConnect=true and a saved password turns online, viewer auto-opens the session with the saved password (unattended, no popup). Add `/api/status` REST (open) returning `{id:online_bool}` for requested ids/aliases.
### Windows Service mode (unattended)
- The assisted NSIS installer offers "Install service for 24x7 unattended access (recommended)". It bundles the official WinSW v2.12.0 x64 MIT wrapper as `resources\BainslaRemoteService.exe` with a sibling XML. WinSW SHA-256: `05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da`.
- WinSW runs `BainslaRemote.exe --service` as LocalSystem and starts automatically. The headless supervisor registers with role `service`, keeps the device online when no session agent heartbeat is fresh, and invokes `schtasks /run /tn "Bainsla Remote Agent"` when needed. It never accepts a session.
- The shipped scheduled-task XML uses a logon trigger for BUILTIN\Users, highest available run level, IgnoreNew, no execution time limit, and runs `BainslaRemote.exe --host` in the interactive user session. Node cannot use `CreateProcessAsUser`; Task Scheduler is required to launch the agent in that session.
- The interactive agent owns hosting. It writes `C:\ProgramData\Bainsla Remote\agent.heartbeat` every 5 s after registering. When it replaces the service socket, the server transfers and replays its pending requests to the agent; active sessions are not moved.
- Both service and session agent use `C:\ProgramData\Bainsla Remote\config.json` when available, with per-user configuration as fallback. It stores the permanent device id/secret, server URL, alias, and the existing scrypt hash/salt representation of the fixed unattended password; passwords do not rotate or expire. Saved viewer address books remain per-user.

## Known limits

- Lock-screen/UAC secure-desktop control is not supported. Electron's `desktopCapturer` cannot capture the Winlogon secure desktop; a native C++ helper is required. The viewer reports this limitation when desktop capture fails.
