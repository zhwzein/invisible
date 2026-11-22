/**
 * Invisible — Android / Capacitor Bridge
 * Provides window.electronAPI when running outside Electron (e.g. Android APK).
 */
(function () {
  if (window.electronAPI) return;

  const STORAGE_KEY = 'invisible_config_v1';
  const MAX_IMAGE_EDGE = 1536;

  document.documentElement.classList.add('is-mobile');

  function loadStoredConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveStoredConfig(config) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (err) {
      console.error('[MobileBridge] Failed to save config:', err);
    }
  }

  function pickImageAsBase64() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.style.display = 'none';
      document.body.appendChild(input);

      const cleanup = () => {
        if (input.parentNode) input.parentNode.removeChild(input);
      };

      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        cleanup();
        if (!file) return resolve(null);

        const reader = new FileReader();
        reader.onerror = () => resolve(null);
        reader.onload = () => {
          const img = new Image();
          img.onerror = () => resolve(null);
          img.onload = () => {
            const longEdge = Math.max(img.width, img.height);
            const ratio = longEdge > MAX_IMAGE_EDGE ? MAX_IMAGE_EDGE / longEdge : 1;
            const w = Math.max(1, Math.round(img.width * ratio));
            const h = Math.max(1, Math.round(img.height * ratio));

            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, w, h);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
            resolve(dataUrl.split(',')[1] || null);
          };
          img.src = String(reader.result || '');
        };
        reader.readAsDataURL(file);
      });

      input.addEventListener('cancel', () => {
        cleanup();
        resolve(null);
      });

      input.click();
    });
  }

  async function aiFetch(options) {
    const { url, method, headers, body, timeoutMs } = options || {};
    const verb = String(method || 'POST').toUpperCase();
    const capHttp = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorHttp;

    if (capHttp && typeof capHttp.request === 'function') {
      try {
        const reqHeaders = { ...(headers || {}) };
        if (verb === 'POST' && !reqHeaders['Content-Type'] && !reqHeaders['content-type']) {
          reqHeaders['Content-Type'] = 'application/json';
        }
        const res = await capHttp.request({
          url: String(url),
          method: verb,
          headers: reqHeaders,
          data: verb === 'POST' ? body : undefined,
          connectTimeout: Math.min(Number(timeoutMs) || 120000, 300000),
          readTimeout: Math.min(Number(timeoutMs) || 120000, 300000),
          responseType: 'text',
        });
        const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? '');
        return { ok: res.status >= 200 && res.status < 300, status: res.status, text };
      } catch (err) {
        return { ok: false, status: 0, text: err.message || 'Network error' };
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(Number(timeoutMs) || 120000, 300000));
    try {
      const init = { method: verb, signal: controller.signal };
      if (verb === 'POST') {
        init.headers = { 'Content-Type': 'application/json', ...(headers || {}) };
        init.body = typeof body === 'string' ? body : JSON.stringify(body ?? {});
      } else if (headers && Object.keys(headers).length) {
        init.headers = headers;
      }
      const res = await fetch(String(url), init);
      return { ok: res.ok, status: res.status, text: await res.text() };
    } catch (err) {
      return { ok: false, status: 0, text: err.name === 'AbortError' ? 'Request timed out' : err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  const noop = () => {};

  window.electronAPI = {
    getConfig: async () => loadStoredConfig(),
    saveConfig: (config) => saveStoredConfig(config),
    captureScreen: () => pickImageAsBase64(),
    aiFetch,
    minimizeWindow: noop,
    quitApp: noop,
    setOpacity: noop,
    setAlwaysOnTop: noop,
    setKeepFocus: noop,
    pickKnowledgeFolder: async () => null,
    knowledgeStatus: async () => ({ ok: true, summary: { fileCount: 0, chunkCount: 0, imageCount: 0 } }),
    knowledgeReindex: async () => ({ ok: false, error: 'Knowledge folder is desktop-only' }),
    knowledgeRetrieve: async () => ({ ok: true, context: '', matches: [] }),
    knowledgeImages: async () => ({ ok: true, images: [] }),
    onCaptureStart: noop,
    onScreenshotCaptured: noop,
    onCaptureError: noop,
    onTransparencyChanged: noop,
    onStartTyping: noop,
  };
})();
