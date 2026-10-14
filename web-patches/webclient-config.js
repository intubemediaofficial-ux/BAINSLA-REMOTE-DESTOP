// Served by nginx at /webclient-config/index.js — presets the web client to our own server.
// __SERVER_IP__ and __PUBLIC_KEY__ are filled in by deploy/install.sh (key = data/id_ed25519.pub, public).
localStorage.setItem("api-server", location.origin);
localStorage.setItem("wc-api-server", location.origin);
localStorage.setItem("custom-rendezvous-server", "__SERVER_IP__:21116");
localStorage.setItem("key", "__PUBLIC_KEY__");
window.webclient_magic_queryonline = 0;
window.ws_host = "wss://" + location.host;
// One-time code handed over by the landing page ("ID - password"), used once for auto-login.
try { window.__bpw = sessionStorage.getItem("bainsla-pw") || ""; sessionStorage.removeItem("bainsla-pw"); } catch (e) {}
