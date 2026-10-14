#!/usr/bin/env bash
# Bainsla Remote server installer (Ubuntu, run as root). Idempotent; never deletes data.
# Usage: SERVER_IP=1.2.3.4 DOMAIN=remote.example.com ./deploy/install.sh
set -euo pipefail
: "${SERVER_IP:?set SERVER_IP}"; : "${DOMAIN:?set DOMAIN}"
ROOT=/opt/bainsla-remote
SRV_VER=${SRV_VER:-1.1.14}       # lejianwen/rustdesk-server release
API_VER=${API_VER:-v2.7}       # lejianwen/rustdesk-api release
CLIENT_VER=${CLIENT_VER:-1.5.0}  # rustdesk/rustdesk client release
HERE=$(cd "$(dirname "$0")/.." && pwd)

id bremote >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d "$ROOT" bremote
mkdir -p "$ROOT"/{server,api,data,site/download}

if [ ! -x "$ROOT/server/amd64/hbbs" ]; then
  curl -fsSL "https://github.com/lejianwen/rustdesk-server/releases/download/$SRV_VER/rustdesk-server-linux-amd64.zip" -o /tmp/rs.zip
  unzip -o -q /tmp/rs.zip -d "$ROOT/server"
fi
if [ ! -x "$ROOT/api/release/apimain" ]; then
  curl -fsSL "https://github.com/lejianwen/rustdesk-api/releases/download/$API_VER/linux-amd64.tar.gz" -o /tmp/api.tgz
  tar xzf /tmp/api.tgz -C "$ROOT/api"
fi

# Web client patches (originals kept with .orig suffix)
WEB="$ROOT/api/release/resources/web"
[ -f "$WEB/yuv.js.orig" ] || cp "$WEB/yuv.js" "$WEB/yuv.js.orig"
install -m 644 "$HERE/web-patches/yuv.js" "$WEB/yuv.js"
[ -f "$WEB/js/dist/index.js.orig" ] || cp "$WEB/js/dist/index.js" "$WEB/js/dist/index.js.orig"
python3 "$HERE/web-patches/patch_webclient.py" "$WEB"

install -D -m 644 "$HERE/deploy/status/status.py" "$ROOT/status/status.py"
install -m 644 "$HERE"/deploy/systemd/*.service /etc/systemd/system/
sed -i "s/162.35.107.192/$SERVER_IP/g" /etc/systemd/system/bainsla-remote-hbbs.service
chown -R bremote:bremote "$ROOT"
systemctl daemon-reload
systemctl enable --now bainsla-remote-hbbs bainsla-remote-hbbr bainsla-remote-api bainsla-remote-status
sleep 3

KEY=$(cat "$ROOT/data/id_ed25519.pub")
sed -e "s/__SERVER_IP__/$SERVER_IP/" -e "s|__PUBLIC_KEY__|$KEY|" "$HERE/web-patches/webclient-config.js" > "$ROOT/site/webclient-config.js"

# Client downloads, pre-configured through the "-licensed-<config>" file name
D="$ROOT/site/download"; U="https://github.com/rustdesk/rustdesk/releases/download/$CLIENT_VER"
[ -s "$D/base-win.exe" ] || curl -fsSL "$U/rustdesk-$CLIENT_VER-x86_64.exe" -o "$D/base-win.exe"
[ -s "$D/BainslaRemote.apk" ] || curl -fsSL "$U/rustdesk-$CLIENT_VER-universal-signed.apk" -o "$D/BainslaRemote.apk"
CFG=$(python3 - "$SERVER_IP" "https://$DOMAIN" "$KEY" <<'PY'
import base64, json, sys
ip, api, key = sys.argv[1:]
j = json.dumps({"host": ip, "relay": ip, "api": api, "key": key}, separators=(",", ":"))
print(base64.urlsafe_b64encode(j.encode()).decode().rstrip("=")[::-1])
PY
)
echo -n "$CFG" > "$D/config.txt"
WIN="BainslaRemote-licensed-$CFG.exe"
[ -f "$D/$WIN" ] || cp "$D/base-win.exe" "$D/$WIN"
sed -e "s|__CFG__|$CFG|g" -e "s|__WIN_FILE__|$WIN|g" "$HERE/site/index.html" > "$ROOT/site/index.html"
chown -R bremote:bremote "$ROOT"

ufw allow 21115:21117/tcp >/dev/null; ufw allow 21116/udp >/dev/null
echo "Done. Now install deploy/nginx/bainsla-remote.conf (edit server_name), run certbot, reload nginx."
