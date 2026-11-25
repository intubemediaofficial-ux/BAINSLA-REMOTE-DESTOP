# Bainsla Remote — full setup guide

Everything that runs https://remote.bainslamusic.com is in this repository. No passwords, keys, database or signing files are included; you create those on your own server.

## What is where

| Folder | What it is |
|---|---|
| `desk/server/` | Node.js server: website, viewer, admin panel API, Socket.IO signaling, update feed, downloads (`server.js`, PM2 file `ecosystem.config.cjs`) |
| `desk/web/` | Website home page, browser screen share, admin panel (`/admin/`), viewer page (`/v/`), SEO files |
| `desk/shared/` | Viewer code shared by the website and the Windows app |
| `desk/agent/` | Windows/macOS/Linux app (Electron): host, in-app viewer, hidden mode, Update now button |
| `desk/android/` | Android app (Kotlin, Gradle) |
| `desk/scripts/smoke.js` | Automatic server test |
| `.github/workflows/desk-windows.yml` | Builds the Windows installer on GitHub |
| `deploy/bainsla-desk/` | Templates: `.env`, nginx, coturn (TURN) |
| `deploy/` (other files), `site/`, `web-patches/` | Older RustDesk-based setup, not used by the live site |

## 1. Server (Ubuntu 22.04/24.04)

```sh
apt install -y nginx coturn certbot python3-certbot-nginx
# Node.js 20+ and PM2
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs && npm i -g pm2

mkdir -p /opt/bainsla-desk/{data,downloads/update}
cp -r desk/server desk/web desk/shared /opt/bainsla-desk/app/   # or: git clone and symlink
cd /opt/bainsla-desk/app/server && npm ci --omit=dev
install -m 600 deploy/bainsla-desk/env.example /opt/bainsla-desk/.env   # owner-only; fill in every value
```

Start it:

```sh
cd /opt/bainsla-desk/app/server
set -a && . /opt/bainsla-desk/.env && set +a
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

nginx + SSL: copy `deploy/bainsla-desk/nginx.conf` to `/etc/nginx/sites-available/bainsla-desk`, change the domain, enable it, then `certbot --nginx -d <your domain>`.

TURN (needed when two PCs cannot connect directly): copy `deploy/bainsla-desk/turnserver.conf` to `/etc/turnserver.conf`, set your server IP and the same secret as `TURN_SECRET`, `systemctl enable --now coturn`. Open ports 3478 tcp/udp and 49160-49400 udp in the firewall.

## 2. Admin panel

- URL: `https://<domain>/admin/`
- First login: `ADMIN_EMAIL` + `ADMIN_PASSWORD` from `.env` (used only while the database has no admin).
- Forgot password: login page → "Forgot password?" → a 6-digit code is e-mailed (Brevo, `BREVO_API_KEY` + `MAIL_FROM`), valid 10 minutes, one use.
- Settings → "Change admin password" changes it while signed in; other signed-in windows are signed out.
- Settings → upload installers (.exe / .apk / .dmg) and set version numbers shown on the home page.

## 3. Windows app

```sh
cd desk/agent && npm ci && npm run dist:win   # output: desk/agent/dist/BainslaRemote-Setup-<version>.exe
```

Or push to GitHub: `desk-windows.yml` builds it and publishes the `desk-latest` release.

Publishing a new version (so "Update now" appears in installed apps):
1. Raise `version` in `desk/agent/package.json` (and run `npm install --package-lock-only`).
2. Build, then copy `BainslaRemote-Setup-<version>.exe` and `latest.yml` into `/opt/bainsla-desk/downloads/update/`.
3. Admin → Settings: upload the same .exe as "Windows installer" and set "Windows version".

Installed apps never download by themselves; they show "Update now" and update only when clicked.

Windows "Smart App Control" / "Unknown publisher" warnings appear because the installer is not code-signed. Signing needs a paid code-signing certificate; set it in electron-builder (`win.certificateFile` / `CSC_LINK`).

## 4. Android app

```sh
cd desk/android && ./gradlew assembleRelease   # needs Android SDK; sign with your own keystore
```

Upload the .apk in Admin → Settings.

## 5. Changing the domain

Replace `remote.bainslamusic.com` in:
- `desk/agent/main.js`, `desk/agent/config.js` (default server)
- `desk/agent/package.json` → `build.publish[0].url` (update feed)
- `desk/android/app/src/main/java/com/kvspt/kvdesk/DeskStore.kt`
- `desk/web/index.html`, `desk/web/robots.txt`, `desk/web/sitemap.xml` (SEO)
- `.env` (`PUBLIC_ORIGIN`, `TURN_HOST`) and nginx/coturn configs

## 6. Test

```sh
cd desk/server && PORT=3598 DATA_DIR=/tmp/t DOWNLOADS_DIR=/tmp/t ADMIN_PASSWORD=test1234 node server.js &
cd desk && KVDESK_SERVER_URL=http://127.0.0.1:3598 node scripts/smoke.js
```

## 7. Backups

Back up `/opt/bainsla-desk/data/kvdesk.db` (devices, aliases, sessions, admin), `/opt/bainsla-desk/.env` and `/opt/bainsla-desk/downloads/`.
