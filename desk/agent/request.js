const params = new URLSearchParams(location.search);
const sessionId = params.get('sessionId');
document.getElementById('viewer').textContent = params.get('viewer') || 'Viewer';
document.getElementById('viewer-id').textContent = params.get('viewerId') || '';
let remaining = 30;
const timer = setInterval(() => {
  remaining -= 1;
  document.getElementById('countdown').textContent = remaining;
  if (remaining <= 0) clearInterval(timer);
}, 1000);
document.getElementById('accept').onclick = () => window.kv.answerRequest({
  sessionId, accept: true, permissions: {
    control: document.getElementById('control').checked,
    clipboard: document.getElementById('clipboard').checked,
    files: document.getElementById('files').checked
  }
});
document.getElementById('reject').onclick = () => window.kv.answerRequest({ sessionId, accept: false, reason: 'rejected' });
