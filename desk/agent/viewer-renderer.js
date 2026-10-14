class SocketAdapter {
  constructor(options) {
    this.id = window.kv.createSocket(options);
    this.connected = false;
    this.listeners = new Map();
    this.on('connect', () => { this.connected = true; });
    this.on('disconnect', () => { this.connected = false; });
  }

  on(event, listener) {
    if (!this.listeners.has(event)) {
      const handlers = new Set();
      this.listeners.set(event, handlers);
      window.kv.onSocket(this.id, event, (...args) => {
        handlers.forEach((handler) => handler(...args));
      });
    }
    this.listeners.get(event).add(listener);
    return this;
  }

  emit(name, ...args) {
    const callback = typeof args.at(-1) === 'function' ? args.pop() : null;
    window.kv.emitSocket(this.id, name, args, Boolean(callback)).then((result) => {
      callback?.(result);
    });
    return this;
  }

  disconnect() {
    return window.kv.disconnectSocket(this.id);
  }
}

import('./vendor/shared/viewer.js').then(({ createViewer }) => {
  window.io = (options) => new SocketAdapter(options);
  const params = new URLSearchParams(location.search);
  const target = params.get('id');
  const password = params.get('password') || '';
  document.querySelector('#target-id').value = target || '';
  document.querySelector('#viewer-password').value = password;
  document.querySelector('.connect-card').hidden = Boolean(target);
  window.kv.getConfig().then((config) => {
    document.body.dataset.base = new URL(config.serverUrl).pathname.replace(/\/+$/, '');
    createViewer({ autoConnect: Boolean(target) });
  });
});
