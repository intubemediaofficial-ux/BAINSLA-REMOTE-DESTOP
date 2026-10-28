const base = location.pathname.replace(/\/admin\/?$/, '');
const api = (route) => `${base}${route}`;
const root = document.getElementById('admin-root');
const request = async (route, options = {}) => {
  const response = await fetch(api(route), { credentials: 'same-origin', ...options,
    headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options.headers } });
  if (response.status === 401) throw new Error('unauthorized');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'request_failed');
  return result;
};
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const time = (value) => value ? new Date(value).toLocaleString() : '—';
function renderLogin(message = '') {
  root.innerHTML = `<main class="login-wrap"><div class="login-card"><a class="brand" href="${base}/">Bainsla<span>Remote</span></a><h1>Admin sign in</h1><p>Manage devices and sessions.</p><form id="login-form"><label>Email<input name="email" type="email" value="intubemediaofficial@gmail.com" required></label><label>Password<input name="password" type="password" required autofocus></label><button class="button primary">Sign in</button><div class="form-error">${esc(message)}</div><button type="button" id="forgot-link" class="link-button">Forgot password?</button></form></div></main>`;
  root.querySelector('#forgot-link').onclick = () => renderForgot();
  root.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try { await request('/api/admin/login', { method: 'POST', body: JSON.stringify(values) }); renderAdmin(); }
    catch { renderLogin('Email or password is incorrect.'); }
  });
}
const resetErrors = {
  wait: 'Please wait a minute before asking for a new code.',
  too_many: 'Too many codes requested. Try again in an hour.',
  mail_failed: 'Could not send the email. Try again in a few minutes.',
  invalid_code: 'The code is wrong or has expired.',
  password_too_short: 'New password must be at least 8 characters.'
};
function renderForgot(step = 'email', email = 'intubemediaofficial@gmail.com', message = '') {
  const fields = step === 'email'
    ? `<label>Admin email<input name="email" type="email" value="${esc(email)}" required></label><button class="button primary">Send reset code</button>`
    : `<label>6-digit code from your email<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required autofocus></label><label>New password<input name="password" type="password" minlength="8" autocomplete="new-password" required></label><label>Confirm new password<input name="confirm" type="password" minlength="8" autocomplete="new-password" required></label><button class="button primary">Set new password</button>`;
  const intro = step === 'email' ? 'We will email a 6-digit code to the admin email.' : `Code sent to ${esc(email)}. It expires in 10 minutes.`;
  root.innerHTML = `<main class="login-wrap"><div class="login-card"><a class="brand" href="${base}/">Bainsla<span>Remote</span></a><h1>Reset password</h1><p>${intro}</p><form id="forgot-form">${fields}<div class="form-error">${esc(message)}</div>${step === 'code' ? '<button type="button" id="resend-link" class="link-button">Send a new code</button>' : ''}<button type="button" id="back-link" class="link-button">Back to sign in</button></form></div></main>`;
  root.querySelector('#back-link').onclick = () => renderLogin();
  const resend = root.querySelector('#resend-link');
  if (resend) resend.onclick = () => renderForgot('email', email);
  root.querySelector('#forgot-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const button = event.currentTarget.querySelector('.button');
    button.disabled = true;
    try {
      if (step === 'email') {
        await request('/api/admin/forgot', { method: 'POST', body: JSON.stringify({ email: values.email }) });
        renderForgot('code', values.email);
      } else {
        if (values.password !== values.confirm) { button.disabled = false; event.currentTarget.querySelector('.form-error').textContent = 'The two passwords do not match.'; return; }
        await request('/api/admin/reset', { method: 'POST', body: JSON.stringify({ email, code: values.code, password: values.password }) });
        renderLogin('Password updated. Sign in with your new password.');
      }
    } catch (error) {
      button.disabled = false;
      event.currentTarget.querySelector('.form-error').textContent = resetErrors[error.message] || 'Something went wrong. Try again.';
    }
  });
}
function shell() {
  root.innerHTML = `<div class="admin-shell"><aside class="admin-side"><a class="brand" href="${base}/">Bainsla<span>Remote</span></a><small>CONTROL PANEL</small><nav><button data-tab="dashboard" class="active">◫ &nbsp;Dashboard</button><button data-tab="devices">▣ &nbsp;Devices</button><button data-tab="sessions">◷ &nbsp;Sessions</button><button data-tab="settings">⚙ &nbsp;Settings</button></nav><button id="logout" class="logout">↪ &nbsp;Sign out</button></aside><main class="admin-main"><header><div><span class="eyebrow">ADMINISTRATION</span><h1 id="page-title">Dashboard</h1></div><span class="admin-user">Administrator</span></header><section id="tab-content"></section></main></div>`;
  root.querySelector('#logout').onclick = async () => { await request('/api/admin/logout', { method: 'POST' }); renderLogin(); };
}
async function renderDashboard(container) {
  const data = await request('/api/admin/dashboard');
  container.innerHTML = `<div class="stat-grid"><article class="stat-card"><span>Online now</span><strong>${data.online}</strong><small>Active devices</small></article><article class="stat-card"><span>Total devices</span><strong>${data.devices}</strong><small>Registered desks</small></article><article class="stat-card"><span>Sessions today</span><strong>${data.sessionsToday}</strong><small>Since midnight</small></article></div><section class="table-card"><div class="section-head"><div><h2>Active sessions</h2><p>Manage live connections</p></div><button class="button subtle" data-refresh>Refresh</button></div>${data.activeSessions.length ? `<div class="table-scroll"><table><thead><tr><th>Device</th><th>Viewer</th><th>Started</th><th>Mode</th><th></th></tr></thead><tbody>${data.activeSessions.map((s) => `<tr><td>${esc(s.device_id)}</td><td>${esc(s.viewer_name)}</td><td>${time(s.started_at)}</td><td>${esc(s.mode)}</td><td><button class="mini danger-text" data-kill="${s.id}">Kill</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No active sessions</div>'}</section>`;
  container.querySelector('[data-refresh]').onclick = () => renderDashboard(container);
  container.querySelectorAll('[data-kill]').forEach((button) => button.onclick = async () => {
    await request(`/api/admin/sessions/${button.dataset.kill}/kill`, { method: 'POST', body: '{}' });
    renderDashboard(container);
  });
}
async function renderDevices(container) {
  container.innerHTML = `<section class="table-card"><div class="section-head"><div><h2>Devices</h2><p>Registered remote desks</p></div><input id="device-search" class="search-input" placeholder="Search by ID or name"></div><div id="device-table"></div></section>`;
  const load = async () => {
    const rows = await request(`/api/admin/devices?search=${encodeURIComponent(container.querySelector('#device-search').value)}`);
    container.querySelector('#device-table').innerHTML = rows.length ? `<div class="table-scroll"><table><thead><tr><th>Desk</th><th>Alias</th><th>Platform</th><th>Version</th><th>Last seen</th><th>IP</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows.map((d) => `<tr><td><strong>${esc(d.name)}</strong><small class="sub-cell">${esc(d.id)}</small></td><td>${esc(d.alias || '—')}</td><td>${esc(d.platform)}</td><td>${esc(d.version)}</td><td>${time(d.last_seen)}</td><td>${esc(d.ip)}</td><td><span class="status-dot ${d.online ? 'online' : ''}"></span>${d.online ? 'Online' : 'Offline'}</td><td class="actions"><button class="mini" data-rename="${d.id}" data-name="${esc(d.name)}" data-alias="${esc(d.alias || '')}">Rename</button><button class="mini" data-block="${d.id}" data-blocked="${d.blocked}">${d.blocked ? 'Unblock' : 'Block'}</button><button class="mini danger-text" data-delete="${d.id}">Delete</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No devices found</div>';
    container.querySelectorAll('[data-rename]').forEach((button) => button.onclick = async () => {
      const name = prompt('Device name', button.dataset.name);
      if (name === null) return;
      const alias = prompt('Alias (3–32 lowercase letters, digits or hyphens)', button.dataset.alias);
      if (alias !== null) {
        try {
          await request(`/api/admin/devices/${button.dataset.rename}/rename`, { method: 'POST', body: JSON.stringify({ name, alias }) });
          load();
        } catch (error) { alert(error.message === 'alias_taken' ? 'That alias is already in use.' : 'Alias must be 3–32 letters, digits, or hyphens.'); }
      }
    });
    container.querySelectorAll('[data-block]').forEach((button) => button.onclick = async () => {
      await request(`/api/admin/devices/${button.dataset.block}/${button.dataset.blocked === '1' ? 'unblock' : 'block'}`, { method: 'POST', body: '{}' }); load();
    });
    container.querySelectorAll('[data-delete]').forEach((button) => button.onclick = async () => {
      if (confirm('Delete this device?')) { await request(`/api/admin/devices/${button.dataset.delete}`, { method: 'DELETE' }); load(); }
    });
  };
  container.querySelector('#device-search').oninput = load;
  await load();
}
async function renderSessions(container) {
  container.innerHTML = `<section class="table-card"><div class="section-head"><div><h2>Sessions</h2><p>Connection history</p></div><input id="session-filter" class="search-input" placeholder="Filter by Desk ID"></div><div id="session-table"></div></section>`;
  const load = async () => {
    const id = container.querySelector('#session-filter').value.trim();
    const rows = await request(`/api/admin/sessions${id ? `?deviceId=${encodeURIComponent(id)}` : ''}`);
    container.querySelector('#session-table').innerHTML = rows.length ? `<div class="table-scroll"><table><thead><tr><th>Desk</th><th>Viewer</th><th>Started</th><th>Duration</th><th>Mode</th><th>End reason</th></tr></thead><tbody>${rows.map((s) => `<tr><td>${esc(s.device_id)}</td><td>${esc(s.viewer_name || s.viewer_id || '—')}</td><td>${time(s.started_at)}</td><td>${s.accepted_at ? Math.max(1, Math.round(((s.ended_at ? new Date(s.ended_at) : new Date()) - new Date(s.accepted_at)) / 60000)) + ' min' : '—'}</td><td>${esc(s.mode)}</td><td>${esc(s.end_reason || 'Active')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No sessions found</div>';
  };
  container.querySelector('#session-filter').oninput = load;
  await load();
}
async function renderSettings(container) {
  const settings = await request('/api/admin/settings');
  container.innerHTML = `<section class="settings-card"><div class="section-head"><div><h2>Application settings</h2><p>Customize Bainsla Remote for your team.</p></div></div><form id="settings-form" class="settings-form"><label>App name<input name="app_name" value="${esc(settings.app_name)}"></label><div class="two-cols"><label>Windows version<input name="win_version" value="${esc(settings.win_version)}"></label><label>Windows installer<input type="file" name="win_file" accept=".exe"></label></div><div class="two-cols"><label>Android version<input name="apk_version" value="${esc(settings.apk_version)}"></label><label>Android installer<input type="file" name="apk_file" accept=".apk"></label></div><div class="two-cols"><label>macOS version<input name="mac_version" value="${esc(settings.mac_version || '')}"></label><label>Apple Silicon Mac installer<input type="file" name="mac_arm64_file" accept=".dmg"></label></div><div class="two-cols"><label>Intel Mac installer<input type="file" name="mac_x64_file" accept=".dmg"></label><span></span></div><label>Announcement<textarea name="announcement" rows="3">${esc(settings.announcement)}</textarea></label><button class="button primary">Save settings</button><span class="save-status"></span></form></section><section class="settings-card"><h2>Change admin password</h2><form id="password-form" class="settings-form"><label>Current password<input name="oldPassword" type="password" required></label><label>New password<input name="password" type="password" minlength="8" required></label><button class="button primary">Update password</button></form></section>`;
  container.querySelector('#settings-form').onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    delete values.win_file; delete values.apk_file;
    delete values.mac_arm64_file; delete values.mac_x64_file;
    await request('/api/admin/settings', { method: 'POST', body: JSON.stringify(values) });
    for (const [kind, inputName] of [
      ['win', 'win_file'],
      ['apk', 'apk_file'],
      ['mac-arm64', 'mac_arm64_file'],
      ['mac-x64', 'mac_x64_file']
    ]) {
      const file = form.elements[inputName].files[0];
      if (file) { const data = new FormData(); data.append('file', file); await request(`/api/admin/settings/upload/${kind}`, { method: 'POST', body: data }); }
    }
    form.querySelector('.save-status').textContent = 'Saved';
  };
  container.querySelector('#password-form').onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await request('/api/admin/password', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.reset();
      alert('Password updated');
    } catch (error) {
      alert(error.message === 'invalid_password' ? 'Current password is incorrect.' : error.message === 'password_too_short' ? 'New password must be at least 8 characters.' : 'Could not update the password.');
    }
  };
}
const pages = { dashboard: renderDashboard, devices: renderDevices, sessions: renderSessions, settings: renderSettings };
async function renderAdmin(tab = 'dashboard') {
  try {
    await request('/api/admin/me');
    if (!root.querySelector('.admin-shell')) shell();
    root.querySelectorAll('[data-tab]').forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === tab);
      button.onclick = () => renderAdmin(button.dataset.tab);
    });
    root.querySelector('#page-title').textContent = tab[0].toUpperCase() + tab.slice(1);
    await pages[tab](root.querySelector('#tab-content'));
  } catch (error) {
    if (error.message === 'unauthorized') renderLogin();
    else root.querySelector('#tab-content').innerHTML = `<div class="empty">Unable to load this page</div>`;
  }
}
renderAdmin();
setInterval(() => {
  const active = root.querySelector('[data-tab].active')?.dataset.tab;
  if (active === 'dashboard') renderDashboard(root.querySelector('#tab-content'));
}, 5000);
