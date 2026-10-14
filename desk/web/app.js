const basePath = location.pathname.replace(/\/$/, '');
const api = (route) => `${basePath}${route}`;
const bookKey = 'kvdesk-address-book';
let book = [];
let previousOnline = {};
let pollingBook = false;
try { book = JSON.parse(localStorage.getItem(bookKey) || '[]'); } catch { book = []; }
const saveBook = () => localStorage.setItem(bookKey, JSON.stringify(book));
const safe = (text) => String(text || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const connect = () => {
  const id = document.getElementById('desk-id').value.trim().replace(/\s/g, '');
  if (!id) return;
  const password = document.getElementById('desk-password').value;
  const viewer = new URL(`${basePath}/v/`, location.origin);
  viewer.searchParams.set('id', id);
  if (password) sessionStorage.setItem(`kvdesk-password:${id.toLowerCase()}`, password);
  location.href = viewer.href;
};
function openDesk(entry, automatic = false) {
  const viewer = new URL(`${basePath}/v/`, location.origin);
  const target = entry.target.replace(/\s/g, '');
  viewer.searchParams.set('id', target);
  const name = `kvdesk-${target.toLowerCase()}`;
  const deskWindow = window.open('about:blank', name);
  if (!deskWindow) {
    if (!automatic) return;
    if (entry.password) sessionStorage.setItem(`kvdesk-password:${target.toLowerCase()}`, entry.password);
    location.href = viewer.href;
    return;
  }
  try {
    const currentUrl = new URL(deskWindow.location.href);
    if (/\/v\/?/.test(currentUrl.pathname) && currentUrl.searchParams.get('id')?.toLowerCase() === target.toLowerCase()) {
      deskWindow.focus();
      return;
    }
  } catch {}
  if (entry.password) deskWindow.sessionStorage.setItem(`kvdesk-password:${target.toLowerCase()}`, entry.password);
  deskWindow.location.href = viewer.href;
}
async function renderBook() {
  if (pollingBook) return;
  pollingBook = true;
  const list = document.getElementById('saved-desks');
  if (!book.length) {
    list.innerHTML = '<div class="book-empty">Save a Desk ID or alias for quick access.</div>';
    pollingBook = false;
    return;
  }
  let online = {};
  try {
    const ids = book.map((entry) => entry.target).join(',');
    online = await fetch(api(`/api/status?ids=${encodeURIComponent(ids)}`)).then((response) => response.json());
  } catch {}
  list.innerHTML = book.map((entry, index) => `<article class="saved-desk"><span class="status-dot ${online[entry.target] ? 'online' : ''}"></span><button class="desk-open" data-open="${index}"><strong>${safe(entry.label || entry.target)}</strong><small>${safe(entry.target)}</small></button><label class="auto-toggle"><input type="checkbox" data-auto="${index}" ${entry.autoConnect ? 'checked' : ''}> Auto</label><button class="mini" data-edit="${index}">Edit</button><button class="mini danger-text" data-remove="${index}">Remove</button></article>`).join('');
  list.querySelectorAll('[data-open]').forEach((button) => button.onclick = () => openDesk(book[button.dataset.open]));
  list.querySelectorAll('[data-auto]').forEach((input) => input.onchange = () => {
    book[input.dataset.auto].autoConnect = input.checked; saveBook(); renderBook();
  });
  list.querySelectorAll('[data-edit]').forEach((button) => button.onclick = () => {
    const entry = book[button.dataset.edit];
    const target = prompt('Desk ID or alias', entry.target);
    if (target === null) return;
    const label = prompt('Label', entry.label);
    if (label === null) return;
    const password = prompt('Password (leave blank to keep the saved password)', '');
    if (password === null) return;
    entry.target = target.trim().replace(/\s/g, ''); entry.label = label.trim();
    if (password) entry.password = password;
    saveBook(); renderBook();
  });
  list.querySelectorAll('[data-remove]').forEach((button) => button.onclick = () => {
    book.splice(Number(button.dataset.remove), 1); saveBook(); renderBook();
  });
  for (const entry of book) {
    const onlineNow = Boolean(online[entry.target]);
    const wasOnline = previousOnline[entry.target];
    if (entry.autoConnect && entry.password && onlineNow && wasOnline !== true) openDesk(entry, true);
    previousOnline[entry.target] = onlineNow;
  }
  pollingBook = false;
}
document.getElementById('saved-desk-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const values = new FormData(event.currentTarget);
  const target = String(values.get('target')).trim().replace(/\s/g, '');
  if (!target) return;
  book = book.filter((entry) => entry.target.toLowerCase() !== target.toLowerCase());
  book.push({ target, label: String(values.get('label') || '').trim(), password: String(values.get('password') || ''),
    autoConnect: values.get('autoConnect') === 'on' });
  saveBook(); event.currentTarget.reset(); renderBook();
});
document.getElementById('connect').addEventListener('click', connect);
document.getElementById('desk-id').addEventListener('keydown', (event) => event.key === 'Enter' && connect());
fetch(api('/api/settings/public')).then((response) => response.json()).then((settings) => {
  document.getElementById('app-name').textContent = settings.app_name || 'Bainsla Remote';
  document.title = `${settings.app_name || 'Bainsla Remote'} · Remote desktop`;
  document.getElementById('announcement').textContent = settings.announcement || '';
  const win = document.getElementById('download-win');
  if (settings.win_url) win.href = settings.win_url;
  else win.hidden = true;
  const apk = document.getElementById('download-apk');
  if (settings.apk_url) apk.href = settings.apk_url;
  else apk.hidden = true;
  const mac = document.getElementById('download-mac');
  const intelLink = document.getElementById('download-mac-intel');
  const downloads = { arm64: settings.mac_arm64_url, x64: settings.mac_x64_url };
  const architecture = String(navigator.userAgentData?.architecture || '').toLowerCase();
  const preferX64 = ['x86', 'x86_64', 'x64', 'amd64'].includes(architecture);
  const preferredArch = preferX64 ? 'x64' : 'arm64';
  const fallbackArch = preferX64 ? 'arm64' : 'x64';
  const primaryArch = downloads[preferredArch] ? preferredArch : fallbackArch;
  const secondaryArch = primaryArch === 'arm64' ? 'x64' : 'arm64';
  if (downloads[primaryArch]) {
    mac.href = downloads[primaryArch];
    mac.hidden = false;
  } else {
    mac.hidden = true;
  }
  if (downloads[primaryArch] && downloads[secondaryArch]) {
    intelLink.href = downloads[secondaryArch];
    intelLink.textContent = secondaryArch === 'x64' ? 'Intel Mac' : 'Apple Silicon';
    intelLink.hidden = false;
  } else {
    intelLink.hidden = true;
  }
});
renderBook();
setInterval(renderBook, 5000);
