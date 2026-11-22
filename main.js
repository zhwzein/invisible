/**
 * Invisible — Main Process
 * @author Zen (zhwzein)
 * @github https://github.com/zhwzein/invisible
 * @license MIT
 */

const { app, BrowserWindow, globalShortcut, ipcMain, desktopCapturer, screen, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const knowledge = require('./lib/knowledge');

const DEFAULT_CONFIG = {
  provider: 'gemini',
  geminiKey: '',
  geminiModel: 'gemini-2.0-flash',
  openrouterKey: '',
  openrouterModel: 'openai/gpt-4o',
  customUrl: '',
  customKey: '',
  customModel: '',
  userContext: '',
  customSystemPrompt: '',
  knowledgeFolder: '',
  knowledgeEnabled: true,
  opacity: 0.85,
  alwaysOnTop: true,
  keepFocus: false
};

// Resolved lazily: app.getPath('userData') is only valid after the app module
// is fully initialised.
function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

// The folder shipped next to the code, so a fresh install already has something
// to answer from instead of an empty field the user has to fill in first.
// Packaged builds look beside the executable first: the bundle is read-only, so
// a user dropping files into an asar-adjacent folder would otherwise fail.
function defaultKnowledgeFolder() {
  const candidates = [];
  try { candidates.push(path.join(path.dirname(app.getPath('exe')), 'knowledge')); } catch { /* not ready */ }
  try { candidates.push(path.join(app.getAppPath(), 'knowledge')); } catch { /* not ready */ }
  for (const folder of candidates) {
    try {
      if (fs.existsSync(folder) && fs.statSync(folder).isDirectory()) return folder;
    } catch { /* try the next candidate */ }
  }
  return '';
}

let mainWindow = null;
let isVisible = true;
let transparencyLevel = DEFAULT_CONFIG.opacity;
let alwaysOnTop = DEFAULT_CONFIG.alwaysOnTop;
let keepFocus = false;
const MIN_OPACITY = 0.2;
const MAX_OPACITY = 1;
let appConfig = { ...DEFAULT_CONFIG };

// ─── Config Persistence ─────────────────────────────────────────────────────
function loadConfig() {
  try {
    const file = configPath();
    if (fs.existsSync(file)) {
      // Editors on Windows often save a UTF-8 BOM, which JSON.parse rejects.
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      appConfig = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    }
  } catch (err) {
    console.error('[App] Failed to read config:', err.message);
  }
  // Only fills in a field that was never set. A folder the user picked stays
  // exactly as picked, including one they later deleted (it errors visibly
  // instead of silently reverting to the bundled folder).
  if (!appConfig.knowledgeFolder) appConfig.knowledgeFolder = defaultKnowledgeFolder();
  return appConfig;
}

function saveConfig(config) {
  appConfig = { ...DEFAULT_CONFIG, ...config };
  try {
    const file = configPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(appConfig, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('[App] Failed to save config:', err.message);
  }
}

// ─── Windows API for Screen Capture Invisibility ────────────────────────────
function makeWindowInvisibleToCapture(win) {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const SetWindowDisplayAffinity = user32.func('bool __stdcall SetWindowDisplayAffinity(long hwnd, uint32_t dwAffinity)');
    const WDA_EXCLUDEFROMCAPTURE = 0x00000011;

    const hwndBuf = win.getNativeWindowHandle();
    // Read as a pointer-sized integer
    const hwnd = hwndBuf.length >= 8 ? Number(hwndBuf.readBigInt64LE(0)) : hwndBuf.readInt32LE(0);
    const result = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
    console.log('[Stealth] SetWindowDisplayAffinity result:', result);
    return result;
  } catch (err) {
    console.error('[Stealth] Failed to set display affinity:', err.message);
    // Try fallback: Electron's built-in content protection
    try {
      win.setContentProtection(true);
      console.log('[Stealth] Fallback: setContentProtection enabled');
    } catch (e) {
      console.error('[Stealth] Fallback failed:', e.message);
    }
    return false;
  }
}

// ─── Window Behaviour Helpers ───────────────────────────────────────────────
function clampOpacity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CONFIG.opacity;
  return Math.min(Math.max(n, MIN_OPACITY), MAX_OPACITY);
}

function applyAlwaysOnTop() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (alwaysOnTop) mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  else mainWindow.setAlwaysOnTop(false);
}

function setOpacity(value) {
  transparencyLevel = clampOpacity(value);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setOpacity(transparencyLevel);
  mainWindow.webContents.send('transparency-changed', Math.round(transparencyLevel * 100));
  saveConfig({ ...appConfig, opacity: transparencyLevel });
}

function setAlwaysOnTop(enabled) {
  alwaysOnTop = enabled !== false;
  applyAlwaysOnTop();
  saveConfig({ ...appConfig, alwaysOnTop });
}

function setKeepFocus(enabled) {
  keepFocus = enabled === true;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setFocusable(keepFocus);
  saveConfig({ ...appConfig, keepFocus });
}

// Hide/show without hide()/show(). On Windows a transparent frameless window
// loses its composited surface every time it is hidden, so the next show()
// paints a blank frame first - that blank frame is the flicker. Parking the
// window far off-screen keeps the surface alive, so showing it again is a
// single reposition and appears instantly.
const OFFSCREEN_X = -32000;
let parkedBounds = null;
// Remembered while the window is on-screen so a minimized window (whose
// getBounds() is meaningless) parks and restores at the right place.
let lastBounds = null;

function rememberBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized() || !mainWindow.isVisible()) return;
  const bounds = mainWindow.getBounds();
  if (bounds.x <= OFFSCREEN_X + 1000) return;
  lastBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

function hideWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  rememberBounds();
  const bounds = lastBounds || mainWindow.getBounds();
  parkedBounds = { x: bounds.x, y: bounds.y };
  mainWindow.setIgnoreMouseEvents(true);
  mainWindow.setPosition(OFFSCREEN_X, bounds.y, false);
  isVisible = false;
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();

  const target = parkedBounds || mainWindow.getBounds();
  mainWindow.setOpacity(transparencyLevel);
  mainWindow.setPosition(target.x, target.y, false);
  mainWindow.setIgnoreMouseEvents(false);
  mainWindow.showInactive();
  applyAlwaysOnTop();
  isVisible = true;
}

// ─── Create Main Window ─────────────────────────────────────────────────────
const WINDOW_WIDTH = 360;
const WINDOW_HEIGHT = 780;

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth } = primaryDisplay.workAreaSize;

  transparencyLevel = clampOpacity(appConfig.opacity);
  alwaysOnTop = appConfig.alwaysOnTop !== false;
  keepFocus = appConfig.keepFocus === true;

  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: WINDOW_WIDTH,
    minHeight: 420,
    x: Math.max(0, screenWidth - WINDOW_WIDTH - 24),
    y: 30,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: alwaysOnTop,
    resizable: true,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: keepFocus,
    show: false,
    type: 'toolbar',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Keep the renderer painted while hidden: otherwise every show() has to
      // re-composite a fresh frame and the transparent window visibly flickers.
      backgroundThrottling: false,
    },
  });

  applyAlwaysOnTop();
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setOpacity(transparencyLevel);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Make invisible to screen capture once the first frame is ready, then reveal
  // the already-painted window in one step so nothing flashes.
  mainWindow.once('ready-to-show', () => {
    makeWindowInvisibleToCapture(mainWindow);
    mainWindow.showInactive();
    isVisible = true;
    console.log('[App] Window loaded and stealth mode applied');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── Screen Capture ─────────────────────────────────────────────────────────
// The overlay is excluded from capture by SetWindowDisplayAffinity
// (WDA_EXCLUDEFROMCAPTURE), so it never hides or moves while a shot is taken.
// The thumbnail is downscaled to keep the payload small — a full 4K frame at
// 200% DPI is several times larger than the model needs.
const MAX_CAPTURE_EDGE = 1536;

async function captureScreen() {
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.size;
    const scaleFactor = primaryDisplay.scaleFactor;

    const longEdge = Math.max(width, height) * scaleFactor;
    const ratio = longEdge > MAX_CAPTURE_EDGE ? MAX_CAPTURE_EDGE / longEdge : 1;

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.max(1, Math.floor(width * scaleFactor * ratio)),
        height: Math.max(1, Math.floor(height * scaleFactor * ratio)),
      },
    });

    if (sources.length > 0) {
      const screenshot = sources[0].thumbnail.toJPEG(82);
      return screenshot.toString('base64');
    }
    return null;
  } catch (err) {
    console.error('[Capture] Screen capture error:', err);
    return null;
  }
}

// ─── Register Global Shortcuts ──────────────────────────────────────────────
// Another application can already own a hotkey; register() then returns false
// without throwing, which used to look like the shortcut was simply ignored.
function registerShortcut(accelerator, handler) {
  const ok = globalShortcut.register(accelerator, () => {
    try {
      const result = handler();
      if (result && typeof result.catch === 'function') result.catch(() => { });
    } catch (err) {
      console.error(`[Shortcuts] ${accelerator} handler failed:`, err.message);
    }
  });
  if (!ok) console.error(`[Shortcuts] ${accelerator} is already taken by another app`);
  return ok;
}

function registerShortcuts() {
  // Alt+S: Show/Hide overlay
  registerShortcut('Alt+S', () => {
    if (!mainWindow) return;
    if (isVisible) {
      hideWindow();
    } else {
      showWindow();
    }
  });

  // Alt+C: Capture screen & analyze
  registerShortcut('Alt+C', async () => {
    if (!mainWindow) return;
    mainWindow.webContents.send('capture-start');
    const base64Image = await captureScreen();
    if (base64Image) {
      mainWindow.webContents.send('screenshot-captured', base64Image);
    } else {
      mainWindow.webContents.send('capture-error', 'Failed to capture screen');
    }
  });

  // Alt+T: Cycle through preset opacity steps
  registerShortcut('Alt+T', () => {
    if (!mainWindow) return;
    const steps = [1, 0.85, 0.65, 0.45];
    const next = steps.find((v) => v < transparencyLevel - 0.001);
    setOpacity(next === undefined ? steps[0] : next);
  });

  // Alt+I: focus overlay so the question box can be typed into
  const typingModeReady = registerShortcut('Alt+I', () => {
    if (!mainWindow) return;
    if (!isVisible) showWindow();
    mainWindow.webContents.send('start-typing');
  });

  // Alt+Q: Quit
  registerShortcut('Alt+Q', () => {
    app.quit();
  });

  if (typingModeReady) {
    console.log('[Shortcuts] Alt+I typing mode registered');
  } else {
    console.error('[Shortcuts] Alt+I NOT registered - another app holds it');
  }

  console.log('[Shortcuts] All global shortcuts registered');
}

// ─── IPC Handlers ───────────────────────────────────────────────────────────
function setupIPC() {
  ipcMain.handle('capture-screen', async () => {
    return await captureScreen();
  });

  ipcMain.handle('get-config', () => loadConfig());

  ipcMain.on('save-config', (event, config) => {
    if (config && typeof config === 'object') saveConfig(config);
  });

  ipcMain.on('minimize-window', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });

  ipcMain.on('set-opacity', (event, value) => setOpacity(value));

  ipcMain.on('set-always-on-top', (event, enabled) => setAlwaysOnTop(enabled));

  ipcMain.on('set-keep-focus', (event, enabled) => setKeepFocus(enabled));

  ipcMain.on('quit-app', () => app.quit());

  // ─── Knowledge base ───────────────────────────────────────────────────────
  // The folder is read in the main process (no renderer file access), indexed
  // to plain text and cached under userData. Re-indexing happens by itself when
  // any file's mtime or size changed, so the folder stays the single source of
  // truth and no manual refresh is needed.
  ipcMain.handle('pick-knowledge-folder', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a knowledge folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('knowledge-status', async (event, folderArg) => {
    const folder = String(folderArg || appConfig.knowledgeFolder || '').trim();
    if (!folder) return { ok: true, summary: knowledge.indexSummary(null) };
    try {
      const payload = await knowledge.buildIndexFor(folder, app.getPath('userData'));
      return { ok: true, summary: knowledge.indexSummary(payload), fromCache: Boolean(payload.fromCache) };
    } catch (err) {
      return { ok: false, error: err.message, summary: knowledge.indexSummary(null) };
    }
  });

  ipcMain.handle('knowledge-reindex', async (event, folderArg) => {
    const folder = String(folderArg || appConfig.knowledgeFolder || '').trim();
    if (!folder) return { ok: false, error: 'No folder selected', summary: knowledge.indexSummary(null) };
    try {
      const payload = await knowledge.buildIndexFor(folder, app.getPath('userData'), { force: true });
      return { ok: true, summary: knowledge.indexSummary(payload), fromCache: false };
    } catch (err) {
      return { ok: false, error: err.message, summary: knowledge.indexSummary(null) };
    }
  });

  // Returns the passages that match the query, already formatted for a prompt.
  // Empty string when there is no folder, nothing matched, or the feature is off.
  // With no query — a bare screenshot, where the image itself is the question —
  // there is nothing to score, so the folder is sent as-is if it fits.
  ipcMain.handle('knowledge-retrieve', async (event, query) => {
    if (appConfig.knowledgeEnabled === false) return { ok: true, context: '', matches: [] };
    const folder = String(appConfig.knowledgeFolder || '').trim();
    if (!folder) return { ok: true, context: '', matches: [] };

    const asked = String(query || '').trim();
    try {
      const payload = await knowledge.buildIndexFor(folder, app.getPath('userData'));

      if (!asked) {
        const { context } = knowledge.fullContext(payload);
        return { ok: true, context, matches: [], whole: true };
      }

      const index = knowledge.buildIndex(payload.chunks);
      const matches = knowledge.searchIndex(index, asked, 4);
      // A question that matches no wording still deserves the folder's contents:
      // the words in the screenshot may be the real subject, not the typed ones.
      if (!matches.length) {
        const { context } = knowledge.fullContext(payload);
        return { ok: true, context, matches: [], whole: Boolean(context) };
      }

      const context = matches
        .map((m, i) => `[${i + 1}] ${m.source}\n${m.text}`)
        .join('\n\n');
      return { ok: true, context, matches: matches.map((m) => ({ source: m.source, score: m.score })) };
    } catch (err) {
      return { ok: false, error: err.message, context: '', matches: [] };
    }
  });

  // Images in the folder are answered from directly: the file bytes are base64'd
  // and sent to the model as an image, with no OCR step in between. Vertices are
  // capped and sizes are re-encoded down so a 12 MP photo does not blow the
  // request size or the provider's per-image limits.
  ipcMain.handle('knowledge-images', async (event, query) => {
    if (appConfig.knowledgeEnabled === false) return { ok: true, images: [] };
    const folder = String(appConfig.knowledgeFolder || '').trim();
    if (!folder) return { ok: true, images: [] };

    try {
      const payload = await knowledge.buildIndexFor(folder, app.getPath('userData'));
      const matches = knowledge.searchImages(payload, String(query || ''), 3);
      if (!matches.length) return { ok: true, images: [] };

      const images = [];
      for (const match of matches) {
        try {
          const raw = fs.readFileSync(match.path);
          let encoded = raw;
          let mime = 'image/png';
          // nativeImage normalises every supported format to PNG. It also lets a
          // large photo shrink to 1024px on the long edge before base64.
          const img = nativeImage.createFromBuffer(raw);
          if (!img.isEmpty()) {
            const { width, height } = img.getSize();
            const longest = Math.max(width, height);
            const resized = longest > 1024
              ? img.resize({ width: Math.round(width * 1024 / longest), quality: 'good' })
              : img;
            encoded = resized.toPNG();
            mime = 'image/png';
          }
          if (encoded.length <= 6 * 1024 * 1024) {
            images.push({ name: match.name, mime, base64: encoded.toString('base64') });
          }
        } catch { /* one unreadable image must not cancel the rest */ }
      }
      return { ok: true, images };
    } catch (err) {
      return { ok: false, error: err.message, images: [] };
    }
  });

  // All provider HTTP traffic is proxied through the main process: the renderer
  // keeps a strict CSP (connect-src 'self'), CORS disappears, and arbitrary
  // user-supplied endpoints work without loosening the policy.
  ipcMain.handle('ai-fetch', async (event, options) => {
    const { url, method, headers, body, timeoutMs } = options || {};

    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      return { ok: false, status: 0, text: 'Invalid URL' };
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false, status: 0, text: 'Only http(s) endpoints are allowed' };
    }

    // Providers differ: some take a POST body, some only accept GET. The renderer
    // picks the verb; anything beyond GET/POST is refused.
    const verb = String(method || 'POST').toUpperCase();
    if (verb !== 'GET' && verb !== 'POST') {
      return { ok: false, status: 0, text: `Method ${verb} is not allowed` };
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

      const response = await fetch(parsed.toString(), init);
      return { ok: response.ok, status: response.status, text: await response.text() };
    } catch (err) {
      const message = err.name === 'AbortError' ? 'Request timed out' : err.message;
      return { ok: false, status: 0, text: message };
    } finally {
      clearTimeout(timer);
    }
  });
}

// ─── App Lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(() => {
  loadConfig();
  createWindow();
  registerShortcuts();
  setupIPC();
  console.log('[App] Invisible started');
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
