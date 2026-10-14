# Bainsla Remote

Phase 1 is a self-hosted remote desktop system: an Express/Socket.IO signaling server, static browser viewer and admin panel, and an Electron host/viewer.

## Requirements

- Node.js 20 or newer and npm
- X11 on Linux for desktop capture and input (Wayland support depends on Electron's desktop-capture backend)
- Wine for Windows NSIS packaging from Linux

## Run the server

```sh
cd server
npm install
PORT=3015 BASE_PATH=/remote DATA_DIR="$HOME/kvdesk-dev/data" \
DOWNLOADS_DIR="$HOME/kvdesk-dev/downloads" ADMIN_PASSWORD=test1234 npm start
```

Open `http://localhost:3015/remote/`. The initial admin email is `intubemediaofficial@gmail.com` unless `ADMIN_EMAIL` is set. `ADMIN_PASSWORD` seeds the administrator only when the database has no admin account; later changes are made in Settings. Set a strong `SESSION_SECRET` outside local development.

Set `BASE_PATH=` to serve from `/`. Configure `TURN_HOST` and `TURN_SECRET` when a TURN service is available; without TURN, connections depend on direct ICE connectivity.

## Run the Electron agent

```sh
cd agent
npm install
KVDESK_SERVER_URL=http://localhost:3015/remote npm start
```

For a hidden tray start, pass `--hidden` after Electron's `--` separator: `npm start -- --hidden`. The app registers a permanent device ID and secret on first connection. Agent settings and the local-only saved desk address book are stored in Electron's user data directory (`config.json` and `book.json`). `KVDESK_CONFIG_DIR` overrides that directory for future machine-wide configuration support.

## Smoke test

With the server running and its initial admin password set to `test1234`:

```sh
node scripts/smoke.js
```

The script checks device registration and re-hello, alias creation and connection, status polling, offline errors, bad-password rate limiting, acceptance on both peers, signaling in both directions, and persisted session end time. Override `KVDESK_SERVER_URL`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` as needed.

## Build

```sh
cd agent
npm install
npm run dist:win
```

The Windows NSIS installer artifact is named `BainslaRemote-Setup-<version>.exe` and is written to `agent/release/`. Building it on Linux requires Wine; packaging is not silently redirected to another platform if the Windows toolchain is unavailable.

`npm start`, `dist:win`, and `dist:mac` first run `scripts/copy-shared.js`, which copies `../shared` to `agent/vendor/shared/` and `../web/style.css` to `agent/vendor/web-style.css` so the packaged viewer window has them inside `app.asar`. `agent/vendor/` is generated and gitignored.

### macOS

On a Mac:

```sh
cd agent
npm install
npm run dist:mac
```

This writes `BainslaRemote-<version>-x64.dmg` (Intel) and `BainslaRemote-<version>-arm64.dmg` (Apple Silicon). The apps are not notarized; `build/mac-adhoc-sign.js` ad-hoc signs each app after packaging (`codesign --force --deep -s -`), which Apple Silicon requires to run at all. The nut-js native modules are universal (x86_64 + arm64) prebuilds.

First run for a user:

1. Because the dmg is not notarized, macOS 26 says “BainslaRemote-<version>-arm64.dmg” is damaged when a downloaded copy is opened (right-click → Open says the same, and Privacy & Security offers no Open Anyway for disk images). Click **Cancel**, open **Terminal**, and run `xattr -d com.apple.quarantine ~/Downloads/BainslaRemote-*.dmg`, then open the dmg again.
2. Drag **Bainsla Remote** onto **Applications**. Open it from Applications (not from the dmg) so it can start at login.
3. If macOS says “Bainsla Remote” Not Opened / Apple could not verify it (only when the app itself still carries the download quarantine), click **Done**, open **System Settings → Privacy & Security**, scroll down to the line about “Bainsla Remote”, click **Open Anyway**, then **Open Anyway** again and enter the Mac login password.
4. Bainsla Remote shows a red **Allow Bainsla Remote on this Mac** card. Click **Open Screen Recording**, turn on **Bainsla Remote** (if it is not in the list, click **+** and choose Bainsla Remote in Applications), and enter the Mac password. If macOS asks, click **Quit & Reopen** (or use **Restart Bainsla Remote** in the card).
5. Click **Open Accessibility**, turn on **Bainsla Remote**. The card disappears once both are allowed; the 9-digit ID shows as Online.

Without Screen Recording, incoming sessions are refused with reason `mac_screen_recording_not_allowed`; without Accessibility, sessions are view-only.

With “Start at login” on (default), Bainsla Remote installs `~/Library/LaunchAgents/com.kvspt.kvdesk.plist` (`RunAtLoad`, `KeepAlive` with `SuccessfulExit=false`, `--hidden`), so launchd starts it at login and restarts it after a crash or kill. Turning the setting off removes the plist and unloads the job. Quit from the tray menu stops it until next login.

## Known limits

- Android screen capture requires the user to approve Android's “Start now” prompt after each reboot and, on Android 14+, for every new capture session. Bainsla Remote keeps one approved projection alive while the foreground service runs; if approval is missing, the request is rejected and the phone posts a “Tap to allow screen sharing” notification.
- Windows Service mode supervises the interactive-session agent, but lock-screen/UAC control is not supported: Electron cannot capture the Winlogon secure desktop and a native C++ helper is required.
- macOS: no lock-screen / login-window control (the app runs in the user session); the dmgs are not notarized, so Gatekeeper's Open Anyway step is needed once. A Bainsla Remote copy run from the dmg or a translocated location does not install the LaunchAgent.
- Linux input is intended for X11; Wayland permission and capture behavior is platform-specific.
- Without a configured TURN server, networks that block direct peer connectivity may not connect.
- Browser automatic connections may require pop-ups to be allowed; if the browser blocks a new window, an automatic connection falls back to the current tab.
- Admin Settings can publish separate macOS DMG downloads for Apple Silicon and Intel. The landing page prefers Apple Silicon when browser architecture is unknown and offers the other build when both are available.

## Android build

The Android app uses JDK 17, Android SDK platform 35 and build tools 35.0.0 (it targets API 34), and the checked-in Gradle wrapper. Build and tests:

```sh
cd android
./gradlew lint test
```

The release signing key is kept outside the repository at `~/kvdesk-keys/kvdesk-release.jks` (alias `kvdesk`). The Gradle signing configuration reads `KV_DESK_KEYSTORE_PATH`, `KV_DESK_KEYSTORE_PASSWORD`, `KV_DESK_KEY_PASSWORD`, and `KV_DESK_KEY_ALIAS` from the environment. Load the private environment file used to create the key before building:

```sh
set -a
source ~/kvdesk-keys/kvdesk-release.env
set +a
./gradlew assembleRelease
```

The signed APK is `android/app/build/outputs/apk/release/BainslaRemote-1.0.0.apk`. Do not put the keystore or its password file in the repository.

## Windows Service mode

The optional NSIS service checkbox installs the WinSW service supervisor and a Task Scheduler agent for interactive logon sessions. Both use the machine-wide `C:\ProgramData\Bainsla Remote\config.json`; the service only keeps the device online and hands pending requests to the session agent. The address book and saved viewer passwords remain per-user.

WinSW v2.12.0 x64 is distributed under MIT (`agent/build/WINSW-LICENSE.txt`), downloaded from the official release. SHA-256: `05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da`.
