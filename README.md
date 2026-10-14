# Bainsla Remote

Self-hosted, unlimited remote desktop (AnyDesk / Chrome Remote Desktop style) for Windows, Android and browser.
Built on open-source RustDesk (client), [rustdesk-server](https://github.com/lejianwen/rustdesk-server) (ID + relay) and
[rustdesk-api](https://github.com/lejianwen/rustdesk-api) (admin panel, users, devices, logs, web client).
Everything runs on our own VPS, so there are no time, session or device limits.

Live: https://remote.bainslamusic.com (the old https://remote.162.35.107.192.sslip.io keeps working)

| URL | What |
| --- | --- |
| `/` | Landing page: Windows/Android downloads, web client, server config |
| `/webclient/` | Browser client — enter remote ID, then the one-time code |
| `/_admin/` | Admin panel (devices, online status, connection logs, users) |
| `/download/` | Pre-configured Windows `.exe` and Android `.apk` |

## How a session works
1. Send the other person the site link. They download **Windows** (pre-configured, no setup) or the **Android APK** (paste the server config from the page in *Settings → Network → ID/Relay Server*).
2. Their app shows an **ID** and a one-time **password/code**.
3. You open the web client (or your own Bainsla Remote app), enter the ID, then the code, and control their screen, mouse and keyboard.
4. For permanent access, click *Install* in the Windows app and set a permanent password in its settings — it auto-starts with Windows and keeps working after the website is closed.

## Server layout (`/opt/bainsla-remote`)
- `server/amd64/hbbs`, `hbbr` — ID/rendezvous (TCP 21115-21116, UDP 21116) and relay (TCP 21117); websockets 21118/21119 are localhost-only behind nginx `/ws/id` and `/ws/relay`.
- `api/release/apimain` — admin + web client on `127.0.0.1:21114` (`deploy/api-config.yaml`, registration disabled, IP ban after 10 failed logins).
- `data/id_ed25519{,.pub}` — server key pair (never commit the private key).
- `site/` — landing page, `webclient-config.js`, downloads.
- systemd units: `deploy/systemd/`; nginx site: `deploy/nginx/bainsla-remote.conf`.

## Web client patches (`web-patches/`)
- `patch_webclient.py` — over HTTPS connect via `wss://<host>/ws/{id,relay}` instead of public RustDesk servers; remove Firebase analytics and the caching service worker.
- `yuv.js` — browsers without WebGL use the YUV worker, whose wasm crashes on large frames (`memory access out of bounds` → black screen). Adds a pure-JS I420→RGBA fallback.
- `webclient-config.js` — presets server address and public key.

## Install / redeploy
```bash
SERVER_IP=162.35.107.192 DOMAIN=remote.bainslamusic.com sudo -E ./deploy/install.sh
# then: copy deploy/nginx/bainsla-remote.conf to /etc/nginx/sites-available, certbot --nginx -d $DOMAIN, reload nginx
```
The Windows client is configured by its file name (`BainslaRemote-licensed-<config>.exe`); `<config>` is the reversed
base64 of `{"host","relay","api","key"}` and only contains the public key.
