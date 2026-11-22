/**
 * Invisible — Renderer UI Logic
 * @author Zen (zhwzein)
 * @github https://github.com/zhwzein/invisible
 * @license MIT
 */

// ─── Constants ──────────────────────────────────────────────────────────────
// Mirrors DEFAULT_CONFIG in main.js.
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
  knowledgeFolder: '',
  knowledgeEnabled: true,
  opacity: 0.85,
  alwaysOnTop: true
};

const PROVIDER_LABELS = {
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
  custom: 'Custom URL'
};

// ─── State ──────────────────────────────────────────────────────────────────
let activeAI = null;
let lastScreenshot = null;
let busy = false;
let appConfig = { ...DEFAULT_CONFIG };
// Replayed on every request. The providers are stateless, so without this the
// model forgets anything stated in an earlier turn (a name, a preference, the
// screenshot it already answered about). Capped to keep requests small.
let chatHistory = [];
const MAX_HISTORY_TURNS = 12;

// ─── DOM Elements ───────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const statusDot = $('statusDot');
const statusText = $('statusText');
const transparencyBadge = $('transparencyBadge');
const settingsPanel = $('settingsPanel');
const providerSwitch = $('providerSwitch');

const providerBlocks = {
  gemini: $('geminiSettings'),
  openrouter: $('openrouterSettings'),
  custom: $('customSettings')
};

const geminiKeyInput = $('geminiKeyInput');
const geminiModelInput = $('geminiModelInput');
const openrouterKeyInput = $('openrouterKeyInput');
const openrouterModelInput = $('openrouterModelInput');
const customUrlInput = $('customUrlInput');
const customKeyInput = $('customKeyInput');
const customModelInput = $('customModelInput');
const userContextInput = $('userContextInput');

const knowledgeFolderInput = $('knowledgeFolderInput');
const pickFolderBtn = $('pickFolderBtn');
const reindexBtn = $('reindexBtn');
const knowledgeStatus = $('knowledgeStatus');
const knowledgeStatusText = $('knowledgeStatusText');
const knowledgeToggle = $('knowledgeToggle');

const saveKeyBtn = $('saveKeyBtn');
const opacitySlider = $('opacitySlider');
const opacityValue = $('opacityValue');
const alwaysOnTopToggle = $('alwaysOnTopToggle');
const keepFocusToggle = $('keepFocusToggle');
const closeSettingsBtn = $('closeSettingsBtn');
const settingsBtn = $('settingsBtn');
const minimizeBtn = $('minimizeBtn');
const closeBtn = $('closeBtn');

const captureBtn = $('captureBtn');
const clearBtn = $('clearBtn');
const questionInput = $('questionInput');
const askBtn = $('askBtn');
const welcomeMsg = $('welcomeMsg');
const chatLog = $('chatLog');
const responseArea = $('responseArea');

const modelPickerBtn = $('modelPickerBtn');
const modelPickerLabel = $('modelPickerLabel');
const modelPopover = $('modelPopover');
const modelSearchInput = $('modelSearchInput');
const modelRefreshBtn = $('modelRefreshBtn');
const modelListStatus = $('modelListStatus');
const modelList = $('modelList');

const api = window.electronAPI;

// ─── Helpers ────────────────────────────────────────────────────────────────
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function providerKey() {
  const p = appConfig.provider;
  return Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, p) ? p : 'gemini';
}

function providerLabel() {
  return PROVIDER_LABELS[providerKey()];
}

function readyStatusText() {
  return `Ready, ${providerLabel()}`;
}

// Status bar text is built from DOM nodes so provider/model names can never
// inject markup into the status bar.
function setStatus(type, message) {
  statusDot.className = 'status-dot';
  if (type === 'error') statusDot.classList.add('error');
  if (type === 'working') statusDot.classList.add('working');

  statusText.textContent = '';
  statusText.append(document.createTextNode(message));
}

function setBusy(isBusy) {
  busy = isBusy;
  captureBtn.disabled = isBusy;
  clearBtn.disabled = isBusy;
  askBtn.disabled = isBusy;
  questionInput.disabled = isBusy;
}

function showToast(message) {
  setStatus('ready', message);
}

// ─── Config / Provider Wiring ───────────────────────────────────────────────
function applyConfigToAI() {
  activeAI = null;
  const provider = providerKey();

  if (provider === 'openrouter') {
    if (appConfig.openrouterKey) {
      activeAI = new window.OpenRouterAPI(
        appConfig.openrouterKey,
        appConfig.openrouterModel || DEFAULT_CONFIG.openrouterModel,
        appConfig.userContext
      );
    }
  } else if (provider === 'custom') {
    if (appConfig.customUrl) {
      activeAI = new window.CustomAPI(
        appConfig.customUrl,
        appConfig.customKey,
        appConfig.customModel,
        appConfig.userContext
      );
    }
  } else if (appConfig.geminiKey) {
    activeAI = new window.GeminiAPI(
      appConfig.geminiKey,
      appConfig.geminiModel || DEFAULT_CONFIG.geminiModel,
      appConfig.userContext
    );
  }

  if (activeAI) {
    setStatus('ready', readyStatusText());
  } else if (provider === 'custom') {
    setStatus('error', 'No endpoint URL — press the settings icon to add one');
  } else {
    setStatus('error', `No API key for ${providerLabel()} — press the settings icon`);
  }
  syncModelPickerLabel();
}

function syncProviderSwitch() {
  const provider = providerKey();
  providerSwitch.querySelectorAll('button[data-provider]').forEach((button) => {
    const active = button.dataset.provider === provider;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  Object.entries(providerBlocks).forEach(([name, block]) => {
    block.classList.toggle('hidden', name !== provider);
  });
}

// Paints the accent fill up to the thumb. The thumb is 22px wide and travels
// across the track inset by its radius on both ends, so a raw value percentage
// would leave the blue edge behind the thumb at either extreme.
function paintOpacitySlider() {
  const min = Number(opacitySlider.min) || 0;
  const max = Number(opacitySlider.max) || 100;
  const value = Number(opacitySlider.value) || 0;
  const ratio = max === min ? 0 : (value - min) / (max - min);
  const width = opacitySlider.clientWidth || 0;
  const thumb = 18;
  const fill = width > thumb ? ((thumb / 2 + ratio * (width - thumb)) / width) * 100 : ratio * 100;
  opacitySlider.style.setProperty('--fill', `${fill}%`);
}

function syncWindowControls() {
  const pct = Math.round((Number(appConfig.opacity) || DEFAULT_CONFIG.opacity) * 100);
  opacitySlider.value = String(pct);
  opacityValue.textContent = `${pct}%`;
  transparencyBadge.textContent = `${pct}%`;
  paintOpacitySlider();

  const onTop = appConfig.alwaysOnTop !== false;
  alwaysOnTopToggle.checked = onTop;
  alwaysOnTopToggle.closest('.toggle-row').classList.toggle('is-on', onTop);

  const keepFocus = appConfig.keepFocus === true;
  keepFocusToggle.checked = keepFocus;
  keepFocusToggle.closest('.toggle-row').classList.toggle('is-on', keepFocus);

  const useKnowledge = appConfig.knowledgeEnabled !== false;
  knowledgeToggle.checked = useKnowledge;
  knowledgeToggle.closest('.toggle-row').classList.toggle('is-on', useKnowledge);
}

function openSettingsPanel() {
  geminiKeyInput.value = appConfig.geminiKey || '';
  geminiModelInput.value = appConfig.geminiModel || DEFAULT_CONFIG.geminiModel;
  openrouterKeyInput.value = appConfig.openrouterKey || '';
  openrouterModelInput.value = appConfig.openrouterModel || DEFAULT_CONFIG.openrouterModel;
  customUrlInput.value = appConfig.customUrl || '';
  customKeyInput.value = appConfig.customKey || '';
  customModelInput.value = appConfig.customModel || '';
  userContextInput.value = appConfig.userContext || '';
  knowledgeFolderInput.value = appConfig.knowledgeFolder || '';

  syncProviderSwitch();
  syncWindowControls();
  settingsPanel.classList.remove('hidden');
  // The panel was hidden while syncing, so the track had no width yet.
  paintOpacitySlider();
  refreshKnowledgeStatus();
}

function closeSettingsPanel() {
  settingsPanel.classList.add('hidden');
}

function persistConfig() {
  appConfig.provider = providerKey();
  appConfig.geminiKey = geminiKeyInput.value.trim();
  appConfig.geminiModel = geminiModelInput.value.trim() || DEFAULT_CONFIG.geminiModel;
  appConfig.openrouterKey = openrouterKeyInput.value.trim();
  appConfig.openrouterModel = openrouterModelInput.value.trim() || DEFAULT_CONFIG.openrouterModel;
  appConfig.customUrl = customUrlInput.value.trim();
  appConfig.customKey = customKeyInput.value.trim();
  appConfig.customModel = customModelInput.value.trim();
  appConfig.userContext = userContextInput.value.trim();

  api.saveConfig(appConfig);
  applyConfigToAI();
  closeSettingsPanel();
}

// ─── Knowledge Folder ───────────────────────────────────────────────────────
// The folder is indexed in the main process and never copied into the renderer.
// What this side does is ask for the status (file/chunk counts) and, right
// before each request, ask for the passages that match the current question.
function setKnowledgeState(state, message) {
  knowledgeStatus.classList.toggle('is-busy', state === 'busy');
  knowledgeStatus.classList.toggle('is-ready', state === 'ready');
  knowledgeStatus.classList.toggle('is-error', state === 'error');
  knowledgeStatusText.textContent = message;
  knowledgeStatusText.title = message;
}

function describeSummary(summary, fromCache) {
  if (!summary || (!summary.fileCount && !summary.imageCount)) return 'No readable files found';
  const parts = [];
  if (summary.fileCount) {
    parts.push(`${summary.fileCount} file${summary.fileCount === 1 ? '' : 's'}`);
    parts.push(`${summary.chunkCount} passage${summary.chunkCount === 1 ? '' : 's'}`);
  }
  if (summary.imageCount) {
    parts.push(`${summary.imageCount} image${summary.imageCount === 1 ? '' : 's'}`);
  }
  parts.push(fromCache ? 'up to date' : 'indexed just now');
  return parts.join(' · ');
}

async function refreshKnowledgeStatus(folder) {
  const target = folder !== undefined ? folder : appConfig.knowledgeFolder;
  if (!target) {
    setKnowledgeState('idle', 'No folder selected');
    reindexBtn.disabled = true;
    return;
  }

  setKnowledgeState('busy', 'Reading folder...');
  reindexBtn.disabled = true;
  const result = await api.knowledgeStatus(target);
  reindexBtn.disabled = false;

  if (!result.ok) {
    setKnowledgeState('error', result.error || 'Index failed');
    return;
  }

  const summary = result.summary || {};
  let message = describeSummary(summary, result.fromCache);
  if (summary.failures && summary.failures.length) {
    message += ` · ${summary.failures.length} failed`;
  }
  if (summary.emptyFiles) {
    message += ` · ${summary.emptyFiles} empty`;
  }
  setKnowledgeState(summary.fileCount || summary.imageCount ? 'ready' : 'error', message);
}

// Retrieval is best-effort: a broken folder must never block an answer, so a
// failure here degrades to "no reference material" instead of an error bubble.
async function knowledgeContext(query) {
  if (appConfig.knowledgeEnabled === false) return '';
  if (!appConfig.knowledgeFolder) return '';
  try {
    const result = await api.knowledgeRetrieve(query);
    return result && result.ok ? String(result.context || '') : '';
  } catch {
    return '';
  }
}

// Returns [{ name, mime, base64 }] picked out of the folder for this question.
// Same best-effort rule as the text side: any failure means no images, never an
// interrupted answer.
async function knowledgeImages(query) {
  if (appConfig.knowledgeEnabled === false) return [];
  if (!appConfig.knowledgeFolder) return [];
  if (typeof api.knowledgeImages !== 'function') return [];
  try {
    const result = await api.knowledgeImages(query);
    return result && result.ok && Array.isArray(result.images) ? result.images : [];
  } catch {
    return [];
  }
}

async function attachKnowledge(query) {
  const context = await knowledgeContext(query);
  if (activeAI) activeAI.knowledge = context;

  // Images are fetched whether or not text matched: a folder of screenshots or
  // photos has no text at all, and that is exactly the case this path serves.
  const images = await knowledgeImages(query);
  if (activeAI) activeAI.knowledgeImages = images;

  return Boolean(context) || images.length > 0;
}

pickFolderBtn.addEventListener('click', async () => {
  const folder = await api.pickKnowledgeFolder();
  if (!folder) return;
  appConfig.knowledgeFolder = folder;
  appConfig.knowledgeEnabled = true;
  knowledgeFolderInput.value = folder;
  knowledgeToggle.checked = true;
  knowledgeToggle.closest('.toggle-row').classList.add('is-on');
  api.saveConfig(appConfig);
  await refreshKnowledgeStatus(folder);
});

reindexBtn.addEventListener('click', async () => {
  if (!appConfig.knowledgeFolder) return;
  setKnowledgeState('busy', 'Re-indexing...');
  reindexBtn.disabled = true;
  const result = await api.knowledgeReindex(appConfig.knowledgeFolder);
  reindexBtn.disabled = false;
  if (!result.ok) {
    setKnowledgeState('error', result.error || 'Index failed');
    return;
  }
  setKnowledgeState('ready', describeSummary(result.summary, false));
});

knowledgeToggle.addEventListener('change', () => {
  appConfig.knowledgeEnabled = knowledgeToggle.checked;
  knowledgeToggle.closest('.toggle-row').classList.toggle('is-on', appConfig.knowledgeEnabled);
  api.saveConfig(appConfig);
});

// ─── Markdown Rendering ─────────────────────────────────────────────────────
// Input is escaped first, then a small subset of markdown is re-applied so
// AI output can never inject HTML or script into the overlay.
function renderInline(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
}

function markdownToHtml(markdown) {
  const codeBlocks = [];
  let html = escapeHtml(markdown).replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000CODE${codeBlocks.length - 1}\u0000`;
  });

  const lines = html.split('\n');
  const out = [];
  let list = null;      // 'ul' | 'ol' | null
  let inQuote = false;

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const closeQuote = () => {
    if (inQuote) {
      out.push('</blockquote>');
      inQuote = false;
    }
  };
  const openList = (type) => {
    if (list !== type) {
      closeList();
      out.push(`<${type}>`);
      list = type;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      closeQuote();
      continue;
    }

    // Code block placeholder
    const codeMatch = trimmed.match(/^\u0000CODE(\d+)\u0000$/);
    if (codeMatch) {
      closeList();
      closeQuote();
      out.push(codeBlocks[Number(codeMatch[1])]);
      continue;
    }

    // Table: header row + separator row
    if (trimmed.includes('|') && /^\|?[\s:-]*-[\s|:-]*\|?$/.test((lines[i + 1] || '').trim()) && (lines[i + 1] || '').includes('-')) {
      closeList();
      closeQuote();
      const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => renderInline(c.trim()));
      const headers = cells(trimmed);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(cells(lines[i].trim()));
        i++;
      }
      i--;
      out.push(
        `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows
          .map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`
      );
      continue;
    }

    // Headings
    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      closeQuote();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    // Horizontal rule
    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      closeList();
      closeQuote();
      out.push('<hr>');
      continue;
    }

    // Blockquote
    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      closeList();
      if (!inQuote) {
        out.push('<blockquote>');
        inQuote = true;
      }
      out.push(`<p>${renderInline(quote[1])}</p>`);
      continue;
    }
    closeQuote();

    // Lists
    const unordered = trimmed.match(/^[-*+]\s+(.*)$/);
    if (unordered) {
      openList('ul');
      out.push(`<li>${renderInline(unordered[1])}</li>`);
      continue;
    }
    const ordered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (ordered) {
      openList('ol');
      out.push(`<li>${renderInline(ordered[1])}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${renderInline(trimmed)}</p>`);
  }

  closeList();
  closeQuote();
  return out.join('');
}

// ─── Chat Transcript ────────────────────────────────────────────────────────
// The transcript is append-only: every turn is a new bubble, nothing is
// replaced or cleared until the user explicitly starts a new chat.
let pendingTimer = null;
let pendingBubble = null;

function scrollToEnd() {
  responseArea.scrollTop = responseArea.scrollHeight;
}

function revealLog() {
  welcomeMsg.classList.add('hidden');
  chatLog.classList.remove('hidden');
}

function clearPending() {
  if (pendingTimer) {
    clearInterval(pendingTimer);
    pendingTimer = null;
  }
  if (pendingBubble) {
    pendingBubble.msg.remove();
    pendingBubble = null;
  }
}

function messageLabel(role) {
  return role === 'user' ? 'You' : providerLabel();
}

// Records a turn for the next request. The screenshot marker itself is not
// replayed — only what the user typed — so images do not pile up in history.
function rememberTurn(role, text) {
  chatHistory.push({ role, text: String(text) });
  if (chatHistory.length > MAX_HISTORY_TURNS) {
    chatHistory = chatHistory.slice(chatHistory.length - MAX_HISTORY_TURNS);
  }
}

function buildMessage(role) {
  const msg = document.createElement('div');
  msg.className = `msg ${role}`;

  const label = document.createElement('span');
  label.className = 'msg-label';
  label.textContent = messageLabel(role);

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  msg.append(label, bubble);
  return { msg, bubble };
}

// User text is always plain text — never markdown, never innerHTML.
function appendUserMessage(text) {
  clearPending();
  revealLog();
  const { msg, bubble } = buildMessage('user');
  bubble.textContent = String(text);
  chatLog.append(msg);
  scrollToEnd();
  rememberTurn('user', text);
  return msg;
}

function appendAiMessage(text) {
  clearPending();
  revealLog();
  const { msg, bubble } = buildMessage('ai');

  const body = document.createElement('div');
  body.className = 'msg-body';
  body.innerHTML = markdownToHtml(String(text));

  bubble.append(body);
  chatLog.append(msg);
  scrollToEnd();
  rememberTurn('assistant', text);
  return msg;
}

// ─── Response Views ─────────────────────────────────────────────────────────
function showResponse(text) {
  appendAiMessage(text);
  setBusy(false);
  setStatus('ready', 'Analysis complete');
}

function showLoading(message = 'Analyzing...') {
  clearPending();
  setBusy(true);
  revealLog();

  const { msg, bubble } = buildMessage('ai');
  bubble.classList.add('typing');

  const spinner = document.createElement('div');
  spinner.className = 'spinner';

  const text = document.createElement('span');
  text.textContent = message;

  bubble.append(spinner, text);
  chatLog.append(msg);
  scrollToEnd();

  const startedAt = Date.now();
  pendingBubble = { msg, text, phase: message };
  pendingTimer = setInterval(() => {
    if (!pendingBubble) return;
    const secs = Math.round((Date.now() - startedAt) / 1000);
    pendingBubble.text.textContent = `${pendingBubble.phase} ${secs}s`;
  }, 1000);

  setStatus('working', message);
}

function showError(message) {
  setBusy(false);
  clearPending();
  revealLog();

  const { msg, bubble } = buildMessage('ai');
  bubble.classList.add('error');

  const card = document.createElement('div');
  card.className = 'error-card';

  const icon = document.createElement('span');
  icon.className = 'error-icon';
  icon.textContent = '!';

  const text = document.createElement('p');
  text.className = 'error-text';
  text.textContent = String(message);

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copy-btn';
  copy.title = 'Copy to clipboard';
  copy.textContent = 'Copy';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(String(message));
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
    } catch (err) {
      console.error('Clipboard copy failed:', err);
    }
  });

  card.append(icon, text, copy);
  bubble.append(card);
  chatLog.append(msg);
  scrollToEnd();
  setStatus('error', 'Error occurred');
}

function requireAI() {
  if (activeAI) return true;
  showError('Configure your provider in settings first.');
  return false;
}

// ─── Capture & Analyze ──────────────────────────────────────────────────────
// A screenshot starts a fresh context: what is on screen now is unrelated to
// whatever was discussed before it, so the earlier turns are dropped instead of
// being replayed next to the image. Follow-ups from the new screenshot onward
// build their history up again as usual.
async function captureAndAnalyze() {
  if (busy || !requireAI()) return;
  setBusy(true);
  setStatus('working', 'Capturing screen...');

  chatHistory = [];

  try {
    const base64Image = await api.captureScreen();
    if (!base64Image) throw new Error('Failed to capture screen');

    lastScreenshot = base64Image;
    appendUserMessage('Screenshot');
    showLoading('Analyzing screen...');
    // A screenshot carries no text to search with, so an empty query is passed:
    // the main process then sends the folder whole (or what fits) instead of
    // trying to score it, and the image itself decides what the answer is about.
    await attachKnowledge('');
    const response = await activeAI.analyzeScreenshot(base64Image, []);
    showResponse(response);
  } catch (err) {
    showError(err.message);
  } finally {
    setBusy(false);
  }
}

async function askFollowUp() {
  const question = questionInput.value.trim();
  if (!question || busy || !requireAI()) return;

  const history = chatHistory.slice();
  questionInput.value = '';
  appendUserMessage(question);
  showLoading('Thinking...');

  try {
    await attachKnowledge(question);
    const response = await activeAI.askFollowUp(question, lastScreenshot, history);
    showResponse(response);
  } catch (err) {
    showError(err.message);
  } finally {
    setBusy(false);
  }
}

function clearResponse() {
  clearPending();
  chatHistory = [];
  chatLog.replaceChildren();
  chatLog.classList.add('hidden');
  welcomeMsg.classList.remove('hidden');
  lastScreenshot = null;
  questionInput.value = '';
  setBusy(false);
  setStatus('ready', readyStatusText());
  applyConfigToAI();
}

// ─── Settings Events ────────────────────────────────────────────────────────
settingsBtn.addEventListener('click', () => {
  if (settingsPanel.classList.contains('hidden')) openSettingsPanel();
  else closeSettingsPanel();
});

closeSettingsBtn.addEventListener('click', closeSettingsPanel);
saveKeyBtn.addEventListener('click', persistConfig);

opacitySlider.addEventListener('input', () => {
  const pct = Number(opacitySlider.value);
  opacityValue.textContent = `${pct}%`;
  transparencyBadge.textContent = `${pct}%`;
  appConfig.opacity = pct / 100;
  paintOpacitySlider();
  api.setOpacity(appConfig.opacity);
});

window.addEventListener('resize', paintOpacitySlider);

alwaysOnTopToggle.addEventListener('change', () => {
  appConfig.alwaysOnTop = alwaysOnTopToggle.checked;
  alwaysOnTopToggle.closest('.toggle-row').classList.toggle('is-on', appConfig.alwaysOnTop);
  api.setAlwaysOnTop(appConfig.alwaysOnTop);
});

keepFocusToggle.addEventListener('change', () => {
  appConfig.keepFocus = keepFocusToggle.checked;
  keepFocusToggle.closest('.toggle-row').classList.toggle('is-on', appConfig.keepFocus);
  // Goes through set-keep-focus so the main process applies setFocusable();
  // save-config alone only wrote the file and left the window unchanged.
  api.setKeepFocus(appConfig.keepFocus);
});

providerSwitch.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-provider]');
  if (!button) return;
  appConfig.provider = button.dataset.provider;
  syncProviderSwitch();
});

// Window controls
minimizeBtn.addEventListener('click', () => api.minimizeWindow());
closeBtn.addEventListener('click', () => api.quitApp());

// Response actions
captureBtn.addEventListener('click', captureAndAnalyze);
clearBtn.addEventListener('click', clearResponse);
askBtn.addEventListener('click', askFollowUp);
questionInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !busy) askFollowUp();
});

// Escape closes the settings panel or model popover
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!modelPopover.classList.contains('hidden')) closeModelPopover();
    else if (!settingsPanel.classList.contains('hidden')) closeSettingsPanel();
  }
});

// ─── Model Picker (/models auto-fetch) ──────────────────────────────────────
let cachedModels = [];
let cachedModelsKey = '';
let fetchingModels = false;

function currentModelId() {
  const p = providerKey();
  if (p === 'openrouter') return appConfig.openrouterModel || DEFAULT_CONFIG.openrouterModel;
  if (p === 'custom') return appConfig.customModel || activeAI?.resolvedModel || '';
  return appConfig.geminiModel || DEFAULT_CONFIG.geminiModel;
}

function modelCacheKey() {
  const p = providerKey();
  if (p === 'custom') return `custom|${appConfig.customUrl || ''}|${appConfig.customKey ? 1 : 0}`;
  if (p === 'openrouter') return `openrouter|${appConfig.openrouterKey ? 1 : 0}`;
  return `gemini|${appConfig.geminiKey ? 1 : 0}`;
}

function syncModelPickerLabel() {
  const id = currentModelId();
  const label = id || (providerKey() === 'custom' ? 'Auto model' : 'Select model');
  modelPickerLabel.textContent = label;
  modelPickerBtn.title = id ? `Model: ${id}` : 'Switch AI model';
}

function setModelStatus(message, isError = false) {
  if (!message) {
    modelListStatus.classList.add('hidden');
    modelListStatus.classList.remove('is-error');
    modelListStatus.textContent = '';
    return;
  }
  modelListStatus.textContent = message;
  modelListStatus.classList.toggle('is-error', isError);
  modelListStatus.classList.remove('hidden');
}

function renderModelList(filter = '') {
  const q = filter.trim().toLowerCase();
  const selected = currentModelId();
  const items = q
    ? cachedModels.filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
    : cachedModels;

  modelList.replaceChildren();
  if (!items.length) {
    setModelStatus(cachedModels.length ? 'No matching models' : 'No models returned');
    return;
  }
  setModelStatus('');

  const frag = document.createDocumentFragment();
  for (const m of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'model-item';
    btn.setAttribute('role', 'option');
    const isSel = m.id === selected;
    if (isSel) {
      btn.classList.add('is-selected');
      btn.setAttribute('aria-selected', 'true');
    }

    const idSpan = document.createElement('span');
    idSpan.className = 'model-item-id';
    idSpan.textContent = m.id;
    idSpan.title = m.label !== m.id ? `${m.label} (${m.id})` : m.id;
    btn.append(idSpan);

    if (isSel) {
      const check = document.createElement('span');
      check.className = 'model-item-check';
      check.textContent = '✓';
      btn.append(check);
    }

    btn.addEventListener('click', () => selectModel(m.id));
    frag.append(btn);
  }
  modelList.append(frag);
}

async function fetchModels(force = false) {
  if (fetchingModels) return;
  const key = modelCacheKey();
  if (!force && cachedModelsKey === key && cachedModels.length) {
    renderModelList(modelSearchInput.value);
    return;
  }
  if (!activeAI || typeof activeAI.listModels !== 'function') {
    cachedModels = [];
    modelList.replaceChildren();
    setModelStatus('Configure provider in Settings first', true);
    return;
  }

  fetchingModels = true;
  modelRefreshBtn.classList.add('spinning');
  modelList.replaceChildren();
  setModelStatus('Fetching /models...');

  try {
    const list = await activeAI.listModels();
    cachedModels = Array.isArray(list) ? list : [];
    cachedModelsKey = key;
    renderModelList(modelSearchInput.value);
  } catch (err) {
    cachedModels = [];
    setModelStatus(err.message || 'Failed to fetch /models', true);
  } finally {
    fetchingModels = false;
    modelRefreshBtn.classList.remove('spinning');
  }
}

function selectModel(modelId) {
  const p = providerKey();
  if (p === 'openrouter') appConfig.openrouterModel = modelId;
  else if (p === 'custom') appConfig.customModel = modelId;
  else appConfig.geminiModel = modelId;

  api.saveConfig(appConfig);
  applyConfigToAI();
  closeModelPopover();
  showToast(`Model: ${modelId}`);
}

function openModelPopover() {
  modelPopover.classList.remove('hidden');
  modelPickerBtn.setAttribute('aria-expanded', 'true');
  modelSearchInput.value = '';
  fetchModels(false);
}

function closeModelPopover() {
  modelPopover.classList.add('hidden');
  modelPickerBtn.setAttribute('aria-expanded', 'false');
}

modelPickerBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (modelPopover.classList.contains('hidden')) openModelPopover();
  else closeModelPopover();
});

modelRefreshBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  fetchModels(true);
});

modelSearchInput.addEventListener('input', () => {
  renderModelList(modelSearchInput.value);
});

document.addEventListener('click', (e) => {
  if (!modelPopover.classList.contains('hidden') && !e.target.closest('.model-bar')) {
    closeModelPopover();
  }
});

// Ctrl/Cmd+Enter anywhere fires a capture
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !busy) captureAndAnalyze();
});

// ─── IPC Events (shortcuts from main process) ───────────────────────────────
api.onCaptureStart(() => {
  setBusy(true);
  setStatus('working', 'Capturing screen...');
});

api.onScreenshotCaptured(async (base64Image) => {
  if (!requireAI()) return;
  // Global-hotkey captures also start a fresh context; see captureAndAnalyze.
  chatHistory = [];
  lastScreenshot = base64Image;
  appendUserMessage('Screenshot');
  showLoading('Analyzing screen...');
  try {
    await attachKnowledge('');
    showResponse(await activeAI.analyzeScreenshot(base64Image, []));
  } catch (err) {
    showError(err.message);
  } finally {
    setBusy(false);
  }
});

api.onCaptureError((msg) => showError(msg));

if (api.onStartTyping) api.onStartTyping(focusQuestionInput);

api.onTransparencyChanged((level) => {
  const pct = Number(level) || 0;
  transparencyBadge.textContent = `${pct}%`;
  opacityValue.textContent = `${pct}%`;
  if (Number(opacitySlider.value) !== pct) opacitySlider.value = String(pct);
  appConfig.opacity = pct / 100;
  paintOpacitySlider();
});

// Alt+I hands focus to the overlay for typing; see main.js. Everything else is
// keyboard-only so the window never steals focus from the app in use.
// The activation request travels over IPC, so the window may still be
// mid-activation when this fires: retry on the next couple of frames.
function focusQuestionInput() {
  revealLog();
  const grab = (attempt) => {
    questionInput.focus();
    const ok = document.activeElement === questionInput;
    if (!ok && attempt < 6) setTimeout(() => grab(attempt + 1), 40);
  };
  grab(0);
}

// ─── Start ──────────────────────────────────────────────────────────────────
async function init() {
  try {
    const savedConfig = await api.getConfig();
    if (savedConfig) appConfig = { ...DEFAULT_CONFIG, ...savedConfig };
  } catch (err) {
    console.error('Failed to load config:', err);
  }

  applyConfigToAI();
  syncWindowControls();
  showToast(readyStatusText());
}

init();
