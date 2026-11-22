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
  customSystemPrompt: '',
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
const customSystemPromptInput = $('customSystemPromptInput');

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
const historyBtn = $('historyBtn');
const historyPanel = $('historyPanel');
const closeHistoryBtn = $('closeHistoryBtn');
const newChatBtn = $('newChatBtn');
const historyList = $('historyList');
const presetBar = $('presetBar');
const micBtn = $('micBtn');
const floatingBtn = $('floatingBtn');
const settingsFloatingBtn = $('settingsFloatingBtn');
const floatingStatusSub = $('floatingStatusSub');
const minimizeBtn = $('minimizeBtn');
const closeBtn = $('closeBtn');

const captureBtn = $('captureBtn');
const cropBtn = $('cropBtn');
const clearBtn = $('clearBtn');
const cropModal = $('cropModal');
const cropCanvas = $('cropCanvas');
const cancelCropBtn = $('cancelCropBtn');
const cancelCropFooterBtn = $('cancelCropFooterBtn');
const confirmCropBtn = $('confirmCropBtn');
const questionInput = $('questionInput');
const askBtn = $('askBtn');
const stopBtn = $('stopBtn');
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
  if (cropBtn) cropBtn.disabled = isBusy;
  clearBtn.disabled = isBusy;
  askBtn.disabled = isBusy;
  questionInput.disabled = isBusy;
  if (stopBtn) {
    askBtn.classList.toggle('hidden', isBusy);
    stopBtn.classList.toggle('hidden', !isBusy);
  }
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
    activeAI.customSystemPrompt = appConfig.customSystemPrompt || '';
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
  if (customSystemPromptInput) customSystemPromptInput.value = appConfig.customSystemPrompt || '';
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
  if (customSystemPromptInput) appConfig.customSystemPrompt = customSystemPromptInput.value.trim();

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
    .replace(
      /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
      '<span class="md-image-card"><img class="md-image-preview" src="$2" alt="$1" loading="lazy" data-src="$2" data-alt="$1" /><span class="md-image-bar"><span class="md-image-caption">$1</span><button type="button" class="md-image-download" data-src="$2" data-alt="$1">Download</button></span></span>'
    )
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
}

function markdownToHtml(markdown) {
  const codeBlocks = [];
  let html = escapeHtml(markdown).replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(
      `<div class="code-block-wrap"><button type="button" class="code-copy-btn">Copy</button><pre><code>${code.replace(/\n$/, '')}</code></pre></div>`
    );
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
  saveCurrentSession(role, String(text));
}

function buildMessage(role) {
  const msg = document.createElement('div');
  msg.className = `msg ${role}`;

  const label = document.createElement('span');
  label.className = 'msg-label';
  label.textContent = messageLabel(role);

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (role === 'ai') {
    const head = document.createElement('div');
    head.className = 'msg-head';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'msg-copy-btn';
    copyBtn.textContent = 'Copy';
    head.append(label, copyBtn);
    msg.append(head, bubble);
  } else {
    msg.append(label, bubble);
  }

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

// ─── Streaming Response & Cancellation Helper ───────────────────────────────
let streamingBubble = null;
let lastFloatingPush = 0;
let currentAbortController = null;
let activeRequestId = 0;

function beginRequest() {
  if (currentAbortController) {
    try { currentAbortController.abort(); } catch {}
  }
  currentAbortController = typeof AbortController === 'function' ? new AbortController() : null;
  activeRequestId += 1;
  return { id: activeRequestId, signal: currentAbortController ? currentAbortController.signal : null };
}

function isStaleRequest(id) {
  return id !== activeRequestId;
}

function stopActiveRequest() {
  if (!busy) return;
  activeRequestId += 1;
  if (currentAbortController) {
    try { currentAbortController.abort(); } catch {}
    currentAbortController = null;
  }
  if (cropModal && !cropModal.classList.contains('hidden')) {
    cropModal.classList.add('hidden');
  }
  clearPending();
  if (streamingBubble) {
    streamingBubble.bubble.classList.remove('is-streaming');
    const partial = streamingBubble.body.textContent || '';
    if (partial.trim()) rememberTurn('assistant', partial);
    streamingBubble = null;
  }
  pushFloatingAnswer('Stopped', false);
  setBusy(false);
  setStatus('ready', 'Stopped');
}

function pushFloatingAnswer(text, streaming) {
  if (!api || !api.isMobile || !floatingActive || typeof api.updateFloatingAnswer !== 'function') return;
  const now = Date.now();
  if (streaming && now - lastFloatingPush < 180) return;
  lastFloatingPush = now;
  api.updateFloatingAnswer(text, streaming);
}

function handleStreamChunk(partialText) {
  if (!streamingBubble) {
    clearPending();
    revealLog();
    const { msg, bubble } = buildMessage('ai');
    bubble.classList.add('is-streaming');
    const body = document.createElement('div');
    body.className = 'msg-body';
    bubble.append(body);
    chatLog.append(msg);
    streamingBubble = { msg, bubble, body };
  }
  streamingBubble.body.innerHTML = markdownToHtml(String(partialText));
  scrollToEnd();
  pushFloatingAnswer(partialText, true);
}

function showResponse(text) {
  if (streamingBubble) {
    streamingBubble.bubble.classList.remove('is-streaming');
    streamingBubble.body.innerHTML = markdownToHtml(String(text));
    rememberTurn('assistant', text);
    streamingBubble = null;
    scrollToEnd();
  } else {
    appendAiMessage(text);
  }
  pushFloatingAnswer(text, false);
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
  if (streamingBubble) {
    streamingBubble.msg.remove();
    streamingBubble = null;
  }
  pushFloatingAnswer(`Error: ${message}`, false);
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
  const req = beginRequest();
  setBusy(true);
  setStatus('working', 'Capturing screen...');

  chatHistory = [];

  try {
    const base64Image = await api.captureScreen();
    if (isStaleRequest(req.id)) return;
    if (!base64Image) throw new Error('Failed to capture screen');

    lastScreenshot = base64Image;
    appendUserMessage('Screenshot');
    showLoading('Analyzing screen...');
    await attachKnowledge('');
    if (isStaleRequest(req.id)) return;
    const response = await activeAI.analyzeScreenshot(
      base64Image,
      [],
      (chunk) => { if (!isStaleRequest(req.id)) handleStreamChunk(chunk); },
      req.signal
    );
    if (isStaleRequest(req.id)) return;
    showResponse(response);
  } catch (err) {
    if (isStaleRequest(req.id) || err?.name === 'AbortError') return;
    showError(err.message);
  } finally {
    if (!isStaleRequest(req.id)) setBusy(false);
  }
}

// ─── Region / Area Crop Capture ─────────────────────────────────────────────
let cropImage = null;
let cropRect = null;
let cropDragging = false;
let cropStart = null;

function drawCropCanvas() {
  if (!cropImage || !cropCanvas) return;
  const ctx = cropCanvas.getContext('2d');
  ctx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
  ctx.drawImage(cropImage, 0, 0, cropCanvas.width, cropCanvas.height);

  if (cropRect && cropRect.w > 4 && cropRect.h > 4) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
    ctx.clip();
    ctx.drawImage(cropImage, 0, 0, cropCanvas.width, cropCanvas.height);
    ctx.restore();
    ctx.strokeStyle = '#4d9cff';
    ctx.lineWidth = 2;
    ctx.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
  }
}

function openCropModal(base64Image) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onerror = () => resolve(null);
    img.onload = () => {
      cropImage = img;
      cropRect = null;
      cropModal.classList.remove('hidden');

      const stage = cropCanvas.parentElement;
      const maxW = Math.max(200, stage.clientWidth - 24);
      const maxH = Math.max(200, stage.clientHeight - 24);
      const scale = Math.min(maxW / img.width, maxH / img.height, 1);
      cropCanvas.width = Math.round(img.width * scale);
      cropCanvas.height = Math.round(img.height * scale);
      drawCropCanvas();

      const close = (result) => {
        cropModal.classList.add('hidden');
        cancelCropBtn.onclick = null;
        if (cancelCropFooterBtn) cancelCropFooterBtn.onclick = null;
        confirmCropBtn.onclick = null;
        resolve(result);
      };

      cancelCropBtn.onclick = () => close(null);
      if (cancelCropFooterBtn) cancelCropFooterBtn.onclick = () => close(null);
      confirmCropBtn.onclick = () => {
        if (!cropRect || cropRect.w < 8 || cropRect.h < 8) {
          return close(base64Image);
        }
        const sx = (cropRect.x / cropCanvas.width) * img.width;
        const sy = (cropRect.y / cropCanvas.height) * img.height;
        const sw = (cropRect.w / cropCanvas.width) * img.width;
        const sh = (cropRect.h / cropCanvas.height) * img.height;
        const out = document.createElement('canvas');
        out.width = Math.max(1, Math.round(sw));
        out.height = Math.max(1, Math.round(sh));
        out.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, out.width, out.height);
        close(out.toDataURL('image/jpeg', 0.85).split(',')[1] || base64Image);
      };
    };
    img.src = `data:image/jpeg;base64,${base64Image}`;
  });
}

if (cropCanvas) {
  const getPos = (e) => {
    const r = cropCanvas.getBoundingClientRect();
    const pt = e.touches ? e.touches[0] : e;
    return {
      x: Math.max(0, Math.min(cropCanvas.width, ((pt.clientX - r.left) / r.width) * cropCanvas.width)),
      y: Math.max(0, Math.min(cropCanvas.height, ((pt.clientY - r.top) / r.height) * cropCanvas.height)),
    };
  };
  const onDown = (e) => {
    cropDragging = true;
    cropStart = getPos(e);
    cropRect = { x: cropStart.x, y: cropStart.y, w: 0, h: 0 };
  };
  const onMove = (e) => {
    if (!cropDragging || !cropStart) return;
    if (e.cancelable) e.preventDefault();
    const cur = getPos(e);
    cropRect = {
      x: Math.min(cropStart.x, cur.x),
      y: Math.min(cropStart.y, cur.y),
      w: Math.abs(cur.x - cropStart.x),
      h: Math.abs(cur.y - cropStart.y),
    };
    drawCropCanvas();
  };
  const onUp = () => { cropDragging = false; };

  cropCanvas.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  cropCanvas.addEventListener('touchstart', onDown, { passive: true });
  cropCanvas.addEventListener('touchmove', onMove, { passive: false });
  cropCanvas.addEventListener('touchend', onUp);
}

async function cropAndAnalyze() {
  if (busy || !requireAI()) return;
  const req = beginRequest();
  setBusy(true);
  setStatus('working', 'Capturing for crop...');
  try {
    const raw = await api.captureScreen();
    if (isStaleRequest(req.id)) return;
    if (!raw) {
      setBusy(false);
      setStatus('ready', readyStatusText());
      return;
    }
    const cropped = await openCropModal(raw);
    if (isStaleRequest(req.id)) return;
    if (!cropped) {
      setBusy(false);
      setStatus('ready', readyStatusText());
      return;
    }
    chatHistory = [];
    lastScreenshot = cropped;
    appendUserMessage('Cropped Area');
    showLoading('Analyzing area...');
    await attachKnowledge('');
    if (isStaleRequest(req.id)) return;
    const response = await activeAI.analyzeScreenshot(
      cropped,
      [],
      (chunk) => { if (!isStaleRequest(req.id)) handleStreamChunk(chunk); },
      req.signal
    );
    if (isStaleRequest(req.id)) return;
    showResponse(response);
  } catch (err) {
    if (isStaleRequest(req.id) || err?.name === 'AbortError') return;
    showError(err.message);
  } finally {
    if (!isStaleRequest(req.id)) setBusy(false);
  }
}

async function askFollowUp() {
  const question = questionInput.value.trim();
  if (!question || busy || !requireAI()) return;

  const req = beginRequest();
  const history = chatHistory.slice();
  questionInput.value = '';
  appendUserMessage(question);
  showLoading('Thinking...');

  try {
    await attachKnowledge(question);
    if (isStaleRequest(req.id)) return;
    const response = await activeAI.askFollowUp(
      question,
      lastScreenshot,
      history,
      (chunk) => { if (!isStaleRequest(req.id)) handleStreamChunk(chunk); },
      req.signal
    );
    if (isStaleRequest(req.id)) return;
    showResponse(response);
  } catch (err) {
    if (isStaleRequest(req.id) || err?.name === 'AbortError') return;
    showError(err.message);
  } finally {
    if (!isStaleRequest(req.id)) setBusy(false);
  }
}

function clearResponse() {
  clearPending();
  currentSessionId = null;
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
if (cropBtn) cropBtn.addEventListener('click', cropAndAnalyze);
clearBtn.addEventListener('click', clearResponse);
askBtn.addEventListener('click', askFollowUp);
if (stopBtn) stopBtn.addEventListener('click', stopActiveRequest);
questionInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !busy) askFollowUp();
});

// Escape closes the settings panel, history panel, lightbox, or model popover
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (imageLightbox && !imageLightbox.classList.contains('hidden')) closeImageLightbox();
    else if (historyPanel && !historyPanel.classList.contains('hidden')) closeHistoryPanel();
    else if (!modelPopover.classList.contains('hidden')) closeModelPopover();
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
  const req = beginRequest();
  // Global-hotkey captures also start a fresh context; see captureAndAnalyze.
  chatHistory = [];
  lastScreenshot = base64Image;
  appendUserMessage('Screenshot');
  showLoading('Analyzing screen...');
  try {
    await attachKnowledge('');
    if (isStaleRequest(req.id)) return;
    const response = await activeAI.analyzeScreenshot(
      base64Image,
      [],
      (chunk) => { if (!isStaleRequest(req.id)) handleStreamChunk(chunk); },
      req.signal
    );
    if (isStaleRequest(req.id)) return;
    showResponse(response);
  } catch (err) {
    if (isStaleRequest(req.id) || err?.name === 'AbortError') return;
    showError(err.message);
  } finally {
    if (!isStaleRequest(req.id)) setBusy(false);
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

// ─── Image Preview Lightbox & Full-Size Download ────────────────────────────
const imageLightbox = $('imageLightbox');
const lightboxImg = $('lightboxImg');
const lightboxTitle = $('lightboxTitle');
const closeLightboxBtn = $('closeLightboxBtn');
const downloadLightboxBtn = $('downloadLightboxBtn');
let activeLightboxUrl = '';
let activeLightboxAlt = '';

function sanitizeFilename(name, url) {
  const clean = String(name || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  const extMatch = String(url || '').match(/\.(png|jpe?g|webp|gif|svg|bmp)(?:[?#]|$)/i);
  const ext = extMatch ? `.${extMatch[1].toLowerCase()}` : '.png';
  if (clean) return clean.endsWith(ext) ? clean : `${clean}${ext}`;
  return `image${ext}`;
}

async function downloadImageFullSize(url, alt = '') {
  if (!url) return;
  const filename = sanitizeFilename(alt, url);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 5000);
    showToast(`Downloaded ${filename}`);
  } catch {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

function openImageLightbox(url, alt = '') {
  if (!imageLightbox || !lightboxImg) return;
  activeLightboxUrl = url;
  activeLightboxAlt = alt;
  lightboxImg.src = url;
  lightboxImg.alt = alt || 'Image preview';
  if (lightboxTitle) lightboxTitle.textContent = alt || 'Image Preview';
  imageLightbox.classList.remove('hidden');
}

function closeImageLightbox() {
  if (!imageLightbox) return;
  imageLightbox.classList.add('hidden');
  if (lightboxImg) lightboxImg.src = '';
}

if (closeLightboxBtn) closeLightboxBtn.addEventListener('click', closeImageLightbox);
if (downloadLightboxBtn) {
  downloadLightboxBtn.addEventListener('click', () => {
    downloadImageFullSize(activeLightboxUrl, activeLightboxAlt);
  });
}

chatLog.addEventListener('click', async (e) => {
  const codeCopyBtn = e.target.closest('.code-copy-btn');
  if (codeCopyBtn) {
    const codeEl = codeCopyBtn.parentElement?.querySelector('code');
    if (codeEl) {
      try {
        await navigator.clipboard.writeText(codeEl.textContent || '');
        codeCopyBtn.textContent = 'Copied';
        setTimeout(() => { codeCopyBtn.textContent = 'Copy'; }, 1600);
      } catch {}
    }
    return;
  }

  const msgCopyBtn = e.target.closest('.msg-copy-btn');
  if (msgCopyBtn) {
    const msgEl = msgCopyBtn.closest('.msg');
    const bodyEl = msgEl?.querySelector('.msg-body') || msgEl?.querySelector('.msg-bubble');
    if (bodyEl) {
      try {
        await navigator.clipboard.writeText(bodyEl.innerText || bodyEl.textContent || '');
        msgCopyBtn.textContent = 'Copied';
        setTimeout(() => { msgCopyBtn.textContent = 'Copy'; }, 1600);
      } catch {}
    }
    return;
  }

  const dlBtn = e.target.closest('.md-image-download');
  if (dlBtn) {
    e.stopPropagation();
    downloadImageFullSize(dlBtn.dataset.src, dlBtn.dataset.alt);
    return;
  }
  const img = e.target.closest('.md-image-preview');
  if (img) {
    openImageLightbox(img.dataset.src || img.src, img.dataset.alt || img.alt);
  }
});

// ─── Prompt Presets ─────────────────────────────────────────────────────────
if (presetBar) {
  presetBar.addEventListener('click', (e) => {
    const chip = e.target.closest('.preset-chip');
    if (!chip || busy) return;
    const prompt = chip.dataset.prompt || '';
    if (!prompt) return;
    questionInput.value = prompt;
    askFollowUp();
  });
}

// ─── Voice Input (Speech-to-Text) ───────────────────────────────────────────
let speechRec = null;
let isListening = false;

function stopVoiceInput() {
  if (speechRec && isListening) {
    try { speechRec.stop(); } catch {}
  }
  isListening = false;
  if (micBtn) micBtn.classList.remove('is-listening');
}

if (micBtn) {
  micBtn.addEventListener('click', () => {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      showToast('Voice input not supported on this device');
      return;
    }
    if (isListening) {
      stopVoiceInput();
      return;
    }
    try {
      speechRec = new SpeechRec();
      speechRec.lang = 'id-ID';
      speechRec.interimResults = true;
      speechRec.continuous = false;

      const baseText = questionInput.value.trim();
      speechRec.onstart = () => {
        isListening = true;
        micBtn.classList.add('is-listening');
        setStatus('working', 'Listening...');
      };
      speechRec.onresult = (event) => {
        let transcript = '';
        for (let i = 0; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        questionInput.value = baseText ? `${baseText} ${transcript}`.trim() : transcript.trim();
      };
      speechRec.onerror = (event) => {
        stopVoiceInput();
        setStatus('error', `Voice error: ${event.error || 'failed'}`);
      };
      speechRec.onend = () => {
        stopVoiceInput();
        setStatus('ready', readyStatusText());
      };
      speechRec.start();
    } catch {
      stopVoiceInput();
      showToast('Unable to start microphone');
    }
  });
}

// ─── Local Multi-Session Chat History ───────────────────────────────────────
const SESSIONS_KEY = 'invisible_sessions_v1';
let currentSessionId = null;

function loadSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSessions(sessions) {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions.slice(0, 30)));
  } catch {}
}

function saveCurrentSession(role, text) {
  const sessions = loadSessions();
  let session = currentSessionId ? sessions.find((s) => s.id === currentSessionId) : null;
  if (!session) {
    currentSessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const title = String(text || 'New Chat').replace(/\s+/g, ' ').trim().slice(0, 48) || 'New Chat';
    session = { id: currentSessionId, title, updatedAt: Date.now(), messages: [] };
    sessions.unshift(session);
  }
  session.messages.push({ role, text });
  if (session.messages.length > 60) {
    session.messages = session.messages.slice(session.messages.length - 60);
  }
  session.updatedAt = Date.now();
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  writeSessions(sessions);
}

function startNewSession() {
  currentSessionId = null;
  clearResponse();
  closeHistoryPanel();
}

function loadSessionById(id) {
  const sessions = loadSessions();
  const session = sessions.find((s) => s.id === id);
  if (!session) return;

  clearPending();
  currentSessionId = session.id;
  chatHistory = [];
  chatLog.replaceChildren();
  lastScreenshot = null;

  if (session.messages && session.messages.length) {
    revealLog();
    for (const m of session.messages) {
      const uiRole = m.role === 'user' ? 'user' : 'ai';
      const { msg, bubble } = buildMessage(uiRole);
      if (uiRole === 'user') {
        bubble.textContent = String(m.text);
      } else {
        const body = document.createElement('div');
        body.className = 'msg-body';
        body.innerHTML = markdownToHtml(String(m.text));
        bubble.append(body);
      }
      chatLog.append(msg);
      chatHistory.push({ role: m.role, text: String(m.text) });
    }
    if (chatHistory.length > MAX_HISTORY_TURNS) {
      chatHistory = chatHistory.slice(chatHistory.length - MAX_HISTORY_TURNS);
    }
    scrollToEnd();
  } else {
    chatLog.classList.add('hidden');
    welcomeMsg.classList.remove('hidden');
  }

  closeHistoryPanel();
  showToast(`Loaded: ${session.title}`);
}

function deleteSessionById(id) {
  const sessions = loadSessions().filter((s) => s.id !== id);
  writeSessions(sessions);
  if (currentSessionId === id) {
    currentSessionId = null;
    clearResponse();
  }
  renderHistoryList();
}

function renderHistoryList() {
  if (!historyList) return;
  const sessions = loadSessions();
  historyList.replaceChildren();

  if (!sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'No saved conversations yet.';
    historyList.append(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const s of sessions) {
    const item = document.createElement('div');
    item.className = 'history-item';
    if (s.id === currentSessionId) item.classList.add('is-active');

    const main = document.createElement('div');
    main.className = 'history-item-main';

    const title = document.createElement('div');
    title.className = 'history-item-title';
    title.textContent = s.title || 'Untitled Chat';

    const meta = document.createElement('div');
    meta.className = 'history-item-meta';
    const count = Array.isArray(s.messages) ? s.messages.length : 0;
    const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '';
    meta.textContent = `${count} msg${count === 1 ? '' : 's'} · ${when}`;

    main.append(title, meta);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'history-del-btn';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSessionById(s.id);
    });

    item.append(main, delBtn);
    item.addEventListener('click', () => loadSessionById(s.id));
    frag.append(item);
  }
  historyList.append(frag);
}

function openHistoryPanel() {
  if (!historyPanel) return;
  renderHistoryList();
  historyPanel.classList.remove('hidden');
}

function closeHistoryPanel() {
  if (!historyPanel) return;
  historyPanel.classList.add('hidden');
}

if (historyBtn) {
  historyBtn.addEventListener('click', () => {
    if (historyPanel.classList.contains('hidden')) openHistoryPanel();
    else closeHistoryPanel();
  });
}
if (closeHistoryBtn) closeHistoryBtn.addEventListener('click', closeHistoryPanel);
if (newChatBtn) newChatBtn.addEventListener('click', startNewSession);

// ─── Mobile Floating Overlay ────────────────────────────────────────────────
let floatingActive = false;

function syncFloatingUI(active) {
  floatingActive = Boolean(active);
  if (floatingBtn) {
    floatingBtn.classList.toggle('is-active', floatingActive);
    floatingBtn.title = floatingActive ? 'Stop Floating Overlay' : 'Start Floating Overlay';
  }
  if (settingsFloatingBtn) {
    settingsFloatingBtn.textContent = floatingActive ? 'Stop Float' : 'Start Float';
  }
  if (floatingStatusSub) {
    floatingStatusSub.textContent = floatingActive
      ? 'Floating bubble is active over other apps. Tap it to scan.'
      : 'Shows a private bubble over any app to scan what you are viewing.';
  }
}

async function toggleFloatingOverlay() {
  if (!api || !api.isMobile) return;
  if (floatingActive) {
    await api.stopFloatingOverlay();
    syncFloatingUI(false);
    showToast('Floating overlay stopped');
    return;
  }
  const res = await api.startFloatingOverlay();
  if (res && res.needsOverlayPermission) {
    showToast('Grant "Display over other apps" permission, then tap Float again');
  } else if (res && res.started) {
    syncFloatingUI(true);
    closeSettingsPanel();
  } else if (res && res.cancelled) {
    showToast('Screen capture permission cancelled');
  }
}

if (floatingBtn) floatingBtn.addEventListener('click', toggleFloatingOverlay);
if (settingsFloatingBtn) settingsFloatingBtn.addEventListener('click', toggleFloatingOverlay);
if (api && typeof api.onOverlayStateChanged === 'function') {
  api.onOverlayStateChanged(syncFloatingUI);
}

// ─── Start ──────────────────────────────────────────────────────────────────
async function init() {
  try {
    const savedConfig = await api.getConfig();
    if (savedConfig) appConfig = { ...DEFAULT_CONFIG, ...savedConfig };
  } catch (err) {
    console.error('Failed to load config:', err);
  }

  if (api && api.isMobile) {
    const labelSpan = captureBtn.querySelector('span');
    if (labelSpan) labelSpan.textContent = 'Pick Image';
    if (typeof api.checkOverlayPermissions === 'function') {
      try {
        const perm = await api.checkOverlayPermissions();
        syncFloatingUI(Boolean(perm && perm.active));
      } catch {}
    }
  }

  applyConfigToAI();
  syncWindowControls();
  showToast(readyStatusText());
}

init();
