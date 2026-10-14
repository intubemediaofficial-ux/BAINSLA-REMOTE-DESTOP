"""Patch the RustDesk v1 web client served by rustdesk-api.

- Over HTTPS, connect to our own server through nginx (wss://<host>/ws/id and /ws/relay)
  instead of the public rs-*.rustdesk.com servers.
- Load /webclient-config/index.js (server + key presets), drop Firebase analytics and the
  caching service worker so updates reach users immediately.
- Auto-login with the one-time password the landing page passes for "ID - password" codes.
"""
import re
import sys
from pathlib import Path

web = Path(sys.argv[1])
js = web / "js/dist/index.js"
s = js.read_text()
if 'location.protocol=="https:"' not in s:
    s, n = re.subn(r"function (\w+)\(e,u=!1,r=0\)\{", lambda m: m.group(0) + 'if(location.protocol=="https:")return "wss://"+location.host+"/ws/"+(u?"relay":"id");', s, count=1)
    if n != 1:
        sys.exit("websocket helper not found in index.js")
    js.write_text(s)
ask = 'this._password||this.msgbox("input-password","Password Required",""),this.login()'
salt_fn = re.search(r"let s=(\w+)\(\[u,t\]\);this\._password=s", s)
if ask in s and salt_fn:
    auto = '(this._password=' + salt_fn.group(1) + '([window.__bpw,this._hash.salt]),window.__bpw="",this.login())'
    s = s.replace(ask, '(this._password||!window.__bpw)?(' + ask + '):' + auto, 1)
    js.write_text(s)
elif "window.__bpw" not in s:
    sys.exit("password prompt not found in index.js")

html = web / "index.html"
h = html.read_text()
h = h.replace("<title>RustDesk</title>", "<title>Bainsla Remote</title>")
h = re.sub(r"<script[^>]*firebase[^<]*</script>", "", h)
h = h.replace("if ('serviceWorker' in navigator)", "if (false && 'serviceWorker' in navigator)")
html.write_text(h)
(web / "flutter_service_worker.js").write_text(
    'self.addEventListener("install",()=>self.skipWaiting());'
    'self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.map(x=>caches.delete(x))))'
    '.then(()=>self.registration.unregister())));\n'
)
print("web client patched")
