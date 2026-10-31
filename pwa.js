/* PWA install + safe automatic updates. Works under GitHub Pages subpaths. */
(() => {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  const VERSION_KEY = 'zmina-pwa-release-v1';
  const CHECK_INTERVAL = 5 * 60 * 1000;
  let registration = null;
  let updateReady = false;
  let activatedByUs = false;
  let reloading = false;
  let polling = false;
  let notification = null;
  const dirtyForms = new Set();
  document.addEventListener('input', event => {
    const form = event.target?.closest?.('form');
    if (form && event.isTrusted) dirtyForms.add(form);
  }, true);
  document.addEventListener('submit', event => {
    const form = event.target;
    setTimeout(() => dirtyForms.delete(form), 200);
  }, true);
  document.addEventListener('reset', event => dirtyForms.delete(event.target), true);
  const scope = new URL('./', document.currentScript?.src || window.location.href);
  const at = file => new URL(file, scope).href;
  const label = text => {
    if (!notification) {
      notification = document.createElement('div');
      notification.className = 'pwa-update-notice';
      notification.setAttribute('role', 'status');
      notification.setAttribute('aria-live', 'polite');
      document.body.appendChild(notification);
    }
    notification.textContent = text;
    notification.hidden = !text;
  };
  const safeToReload = () => {
    if (dirtyForms.size) return false;
    if (typeof window.ZminaPwaCanReload === 'function' && !window.ZminaPwaCanReload()) return false;
    const focus = document.activeElement;
    if (focus?.matches?.('input, textarea, select') && focus.value) return false;
    return true;
  };
  const activateWhenSafe = () => {
    if (!updateReady || !registration?.waiting || reloading) return;
    if (!safeToReload()) {
      label('Є оновлення «Зміни». Воно встановиться після синхронізації незбережених записів.');
      return;
    }
    label('Встановлюємо нову версію «Зміни»…');
    activatedByUs = true;
    registration.waiting.postMessage({type:'SKIP_WAITING'});
  };
  const handleWaiting = () => {
    if (registration?.waiting && navigator.serviceWorker.controller) {
      updateReady = true;
      activateWhenSafe();
    }
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!activatedByUs || reloading) return;
    if (!safeToReload()) {
      label('Оновлення завантажено. Зачекайте завершення синхронізації.');
      return;
    }
    reloading = true;
    window.location.reload();
  });
  const checkVersion = async () => {
    if (polling || !navigator.onLine) return;
    polling = true;
    try {
      const response = await fetch(at('version.json') + '?t=' + Date.now(), {cache:'no-store'});
      if (!response.ok) return;
      const {version} = await response.json();
      if (typeof version !== 'string' || !version.trim()) return;
      let old = null;
      try { old = localStorage.getItem(VERSION_KEY); } catch { /* private mode */ }
      if (old && old !== version && registration) {
        await registration.update();
        handleWaiting();
        // Network-first shell guarantees latest files on reload even if a SW update is delayed.
        if (!registration.waiting && safeToReload()) {
          label('Знайдено нову версію. Оновлюємо…');
          reloading = true;
          window.location.reload();
        }
      }
      try { localStorage.setItem(VERSION_KEY, version); } catch { /* private mode */ }
    } catch { /* offline: the cached app is still usable */ }
    finally { polling = false; }
  };
  async function setup() {
    try {
      registration = await navigator.serviceWorker.register(at('sw.js'), {scope:scope.pathname, updateViaCache:'none'});
      if (registration.waiting) handleWaiting();
      registration.addEventListener('updatefound', () => {
        const candidate = registration.installing;
        candidate?.addEventListener('statechange', () => {
          if (candidate.state === 'installed') handleWaiting();
        });
      });
      checkVersion();
      setInterval(() => { checkVersion(); if (updateReady) activateWhenSafe(); }, CHECK_INTERVAL);
      window.addEventListener('online', checkVersion);
      window.addEventListener('focus', () => { checkVersion(); activateWhenSafe(); });
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) { checkVersion(); activateWhenSafe(); }
      });
      window.addEventListener('zmina-cloud-status', activateWhenSafe);
      window.addEventListener('zmina-cloud-initial', activateWhenSafe);
      // Re-check more frequently while unsynced edits are blocking a pending update.
      setInterval(() => { if (updateReady) activateWhenSafe(); }, 15000);
    } catch (error) { console.warn('PWA installation unavailable', error); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup, {once:true});
  else setup();
})();
