/**
 * Invisible — AI Providers
 * @author Zen (zhwzein)
 * @github https://github.com/zhwzein/invisible
 * @license MIT
 */

// ─── Shared ─────────────────────────────────────────────────────────────────
// Every provider routes its HTTP calls through the main process (aiFetch) so
// the renderer CSP can stay at connect-src 'self' and arbitrary user-supplied
// endpoints work without CORS problems.

// One rule set for every call: screenshots, typed questions and follow-ups all
// travel through it, so the answer style never changes with the entry point.
const ANSWER_RULES = `Give the correct, valid answer immediately. The answer is the first thing you write.
- No preface, no restating the question, no "great question", no describing what you will do.
- No closing summary, no caveats unless they change the answer, no offering further help.
- Give one answer. Pick the most likely reading of an ambiguous request instead of asking back.
- Answer the question asked and stop. Extra facts the source happens to contain are not part of the answer.
- Add a qualifier only when omitting it makes the answer wrong, and keep it to one clause.
- Include a solution only when the solution is the answer: ordered steps for how-to, working code for code, the calculation for math. Otherwise omit steps entirely.
- Prose is one or two sentences. No headings. No bullet lists unless the request asks for a list.`;

// Sent alongside every screenshot. The answer rules already arrive as the system
// instruction, so this only says what to do with the image. A screenshot usually
// carries a question of its own, and that question — not the whole screen — is
// what must be answered.
const ANALYSIS_PROMPT =
  'The screen contains a question. Answer exactly that question and nothing else. ' +
  'Ignore the overlay\'s own interface (its window, buttons and earlier answers) and ignore any ' +
  'decorative duplicate of the question written in a fancy font. If the question asks for one detail, ' +
  'give only that detail.';

function transport() {
  const api = window.electronAPI;
  if (!api || typeof api.aiFetch !== 'function') {
    throw new Error('Transport unavailable — restart the app.');
  }
  return api.aiFetch;
}

async function postJson(url, headers, body) {
  const res = await transport()({ url, method: 'POST', headers, body });
  if (!res.ok) {
    let detail = res.text || `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(res.text);
      detail = parsed.error?.message || parsed.message || detail;
    } catch { /* plain-text error body */ }
    if (res.status === 405) {
      detail += ' — this path rejects POST. Use the chat endpoint, usually <base>/v1/chat/completions.';
    }
    const err = new Error(detail.substring(0, 500));
    err.status = res.status;
    throw err;
  }
  try {
    return JSON.parse(res.text);
  } catch {
    throw new Error('Endpoint did not return JSON');
  }
}

async function postStream(url, headers, body, extractDelta, onChunk, signal = null) {
  if (typeof onChunk !== 'function' || typeof fetch !== 'function') return null;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(body),
    signal: signal || undefined,
  });
  if (!res.ok || !res.body) return null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload);
        const delta = extractDelta(parsed);
        if (delta) {
          fullText += delta;
          onChunk(fullText);
        }
      } catch { /* ignore partial/non-JSON SSE frames */ }
    }
  }
  return fullText || null;
}

// Base URL -> completion URL. Servers advertise themselves as "GET /api/v1/models
// lists the current contract", so users copy a listing path (or only the base)
// into the Endpoint URL field and the completion POST lands on a GET-only route.
// Normalising here keeps their pasted value usable instead of failing with 405.
// Bare hosts also get a scheme so "hisoka.ai/api/v1" works as typed.
function normalizeChatUrl(raw) {
  let url = String(raw || '').trim().replace(/\/+$/, '');
  if (!url) return '';

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    // Tolerate a pasted fragment such as "://host/path" or "//host/path".
    url = url.replace(/^[:\/]+/, '');
    url = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url)
      ? `http://${url}`
      : `https://${url}`;
  }

  url = url.replace(/\/models$/i, '').replace(/\/+$/, '');
  if (/\/(chat\/completions|completions|chat)$/i.test(url)) return url;
  return `${url}/chat/completions`;
}

// Ordered fallbacks for servers whose chat route differs from the usual one.
// The first path that answers wins; only 404/405 move on to the next.
function chatCandidates(raw) {
  const primary = normalizeChatUrl(raw);
  if (!primary) return [];
  const list = [primary];
  const push = (u) => { if (u && !list.includes(u)) list.push(u); };

  if (!/\/chat\/completions$/i.test(primary)) return list;

  const base = primary.replace(/\/chat\/completions$/i, '');
  const bare = base.replace(/\/v1$/i, '');
  push(`${bare}/v1/chat/completions`);
  push(`${base}/completions`);
  push(`${bare}/completions`);
  return list;
}

// Every provider call is stateless: the model only sees what this request
// carries. Without replaying the earlier turns, a name or preference stated in
// a previous message is forgotten on the next one. History entries are
// { role: 'user' | 'assistant', text } and each provider appends the current
// turn itself, so the caller never sends it twice.
function toGeminiContents(history) {
  return history.map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(turn.text) }],
  }));
}

function toChatMessages(history) {
  return history.map((turn) => ({
    role: turn.role === 'assistant' ? 'assistant' : 'user',
    content: String(turn.text),
  }));
}

// Images stored in the knowledge folder arrive as real image bytes, so they are
// sent alongside the question with no text extraction anywhere in the path.
// The label tells the model which file a picture came from.
function imageLabel(name) {
  return `Image from the user's folder: ${String(name || 'image')}`;
}

// The "About you" field travels as a system instruction so the model treats it
// as standing context rather than as something the user just said.
function contextPrompt(context) {
  const value = String(context || '').trim();
  if (!value) return '';
  return `The user has described themselves as: ${value}\nAddress them accordingly and never ask for this information again.`;
}

// Always non-empty: the answer rules must reach the model on every single call,
// including a bare follow-up question with no screenshot attached.
function systemPrompt(context, knowledge = '', customPrompt = '') {
  const parts = [ANSWER_RULES];
  const extra = contextPrompt(context);
  if (extra) parts.push(extra);
  const custom = String(customPrompt || '').trim();
  if (custom) {
    parts.push(`Additional user instructions (follow strictly):\n${custom}`);
  }
  const passages = String(knowledge || '').trim();
  if (passages) {
    parts.push(
      'Reference material from the user\'s own documents follows. Use it as a source, not as something to ' +
      'summarise: answer only the specific thing being asked and stop there. Never list the other details the ' +
      'material happens to contain, and never echo a whole passage back. Name the source file only when it ' +
      'actually supplied the answer. If the material does not cover the question, answer normally and say ' +
      'nothing about the documents.\n\n' + passages
    );
  }
  return parts.join('\n\n');
}

// ─── Google Gemini ──────────────────────────────────────────────────────────
class GeminiAPI {
  constructor(apiKey, modelId, userContext = '') {
    this.apiKey = apiKey;
    this.modelId = modelId || 'gemini-2.0-flash';
    this.userContext = userContext;
    // Passages retrieved from the user's knowledge folder for the current turn.
    // The renderer sets it right before each call; empty means no retrieval.
    this.knowledge = '';
    // Images picked out of the same folder for this turn, as {name, mime, base64}.
    this.knowledgeImages = [];
  }

  get endpoint() {
    return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.modelId)}:generateContent`;
  }

  async _send(parts, history = [], onChunk = null, signal = null) {
    if (!this.apiKey) throw new Error('Gemini API key not set. Open settings (⚙) to add it.');

    const payload = {
      contents: [...toGeminiContents(history), { role: 'user', parts }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048, topP: 0.8 },
      systemInstruction: { parts: [{ text: systemPrompt(this.userContext, this.knowledge, this.customSystemPrompt) }] },
    };

    if (typeof onChunk === 'function') {
      try {
        const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.modelId)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`;
        const streamed = await postStream(
          streamUrl,
          {},
          payload,
          (d) => d.candidates?.[0]?.content?.parts?.[0]?.text || '',
          onChunk,
          signal
        );
        if (streamed) return streamed;
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        /* fall back to standard transport */
      }
    }

    const data = await postJson(
      `${this.endpoint}?key=${encodeURIComponent(this.apiKey)}`,
      {},
      payload
    );
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Empty response from Gemini');
    return text;
  }

  analyzeScreenshot(base64Image, history = [], onChunk = null, signal = null) {
    return this._send([
      { text: ANALYSIS_PROMPT },
      { inline_data: { mime_type: 'image/jpeg', data: base64Image } },
    ], history, onChunk, signal);
  }

  askFollowUp(question, screenshotBase64 = null, history = [], onChunk = null, signal = null) {
    const parts = [{ text: question }];
    for (const image of this.knowledgeImages || []) {
      parts.push({ text: imageLabel(image.name) });
      parts.push({ inline_data: { mime_type: image.mime, data: image.base64 } });
    }
    if (screenshotBase64) {
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: screenshotBase64 } });
    }
    return this._send(parts, history, onChunk, signal);
  }

  async listModels() {
    if (!this.apiKey) throw new Error('Gemini API key not set');
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(this.apiKey)}`;
    const res = await transport()({ url, method: 'GET', headers: {} });
    if (!res.ok) throw new Error(`Failed to fetch models (HTTP ${res.status})`);
    const parsed = JSON.parse(res.text);
    const raw = Array.isArray(parsed.models) ? parsed.models : [];
    return raw
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => {
        const id = String(m.name || '').replace(/^models\//, '');
        return { id, label: m.displayName || id };
      })
      .filter((m) => m.id);
  }
}

// ─── OpenRouter ─────────────────────────────────────────────────────────────
class OpenRouterAPI {
  constructor(apiKey, modelId, userContext = '') {
    this.apiKey = apiKey;
    this.modelId = modelId || 'openai/gpt-4o';
    this.userContext = userContext;
    this.knowledge = '';
    this.knowledgeImages = [];
  }

  async _send(content, history = [], onChunk = null, signal = null) {
    if (!this.apiKey) throw new Error('OpenRouter API key not set. Open settings (⚙) to add it.');

    const messages = [...toChatMessages(history), { role: 'user', content }];
    messages.unshift({ role: 'system', content: systemPrompt(this.userContext, this.knowledge, this.customSystemPrompt) });

    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      'HTTP-Referer': 'https://github.com/zhwzein/invisible',
      'X-Title': 'Invisible',
    };
    const body = {
      model: this.modelId,
      messages,
      temperature: 0.3,
      max_tokens: 2048,
    };

    if (typeof onChunk === 'function') {
      try {
        const streamed = await postStream(
          'https://openrouter.ai/api/v1/chat/completions',
          headers,
          { ...body, stream: true },
          (d) => d.choices?.[0]?.delta?.content || '',
          onChunk,
          signal
        );
        if (streamed) return streamed;
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        /* fall back to standard transport */
      }
    }

    const data = await postJson(
      'https://openrouter.ai/api/v1/chat/completions',
      headers,
      body
    );
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('Empty response from OpenRouter');
    return text;
  }

  analyzeScreenshot(base64Image, history = [], onChunk = null, signal = null) {
    return this._send([
      { type: 'text', text: ANALYSIS_PROMPT },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
    ], history, onChunk, signal);
  }

  askFollowUp(question, screenshotBase64 = null, history = [], onChunk = null, signal = null) {
    const content = [{ type: 'text', text: question }];
    for (const image of this.knowledgeImages || []) {
      content.push({ type: 'text', text: imageLabel(image.name) });
      content.push({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } });
    }
    if (screenshotBase64) {
      content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` } });
    }
    return this._send(content, history, onChunk, signal);
  }

  async listModels() {
    const headers = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const res = await transport()({ url: 'https://openrouter.ai/api/v1/models', method: 'GET', headers });
    if (!res.ok) throw new Error(`Failed to fetch models (HTTP ${res.status})`);
    const parsed = JSON.parse(res.text);
    const raw = Array.isArray(parsed.data) ? parsed.data : [];
    return raw
      .map((m) => ({ id: String(m.id || ''), label: String(m.name || m.id || '') }))
      .filter((m) => m.id);
  }
}

// ─── Custom OpenAI-compatible endpoint ──────────────────────────────────────
// The user pastes any OpenAI-compatible base or chat/completions URL (local
// llama.cpp, LM Studio, Ollama, vLLM, a hosted proxy, …). The pasted value is
// normalised, so "host/api/v1", "host/api/v1/models" and a bare host all work.
// The key is optional and a model is auto-detected from GET /models when the
// Model field is left empty.
class CustomAPI {
  constructor(url, apiKey, modelId, userContext = '') {
    this.rawUrl = (url || '').trim();
    this.apiKey = (apiKey || '').trim();
    this.modelId = (modelId || '').trim();
    this.userContext = userContext;
    this.knowledge = '';
    this.knowledgeImages = [];
    this.resolvedModel = null;
  }

  get url() {
    return normalizeChatUrl(this.rawUrl);
  }

  // `/models` is the endpoint the server itself advertises, and it is a GET. Used
  // to fill in the model name when the user left the field empty.
  get modelsUrl() {
    const base = normalizeChatUrl(this.rawUrl).replace(/\/chat\/completions$/i, '');
    return `${base}/models`;
  }

  async _detectModel() {
    if (this.modelId || this.resolvedModel) return this.resolvedModel;
    try {
      const headers = {};
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
      const res = await transport()({ url: this.modelsUrl, method: 'GET', headers });
      if (!res.ok) return null;
      const parsed = JSON.parse(res.text);
      const list = Array.isArray(parsed.data) ? parsed.data : Array.isArray(parsed.models) ? parsed.models : [];
      const id = list[0]?.id || list[0]?.name;
      if (id) this.resolvedModel = String(id);
    } catch { /* model stays unset; the server may not require one */ }
    return this.resolvedModel;
  }

  async _send(content, history = [], onChunk = null, signal = null) {
    if (!this.rawUrl) throw new Error('Custom endpoint URL not set. Open settings (⚙) to add it.');

    const headers = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const messages = [...toChatMessages(history), { role: 'user', content }];
    messages.unshift({ role: 'system', content: systemPrompt(this.userContext, this.knowledge, this.customSystemPrompt) });

    const body = {
      messages,
      temperature: 0.3,
      max_tokens: 2048,
    };
    const model = this.modelId || (await this._detectModel());
    if (model) body.model = model;

    const urls = chatCandidates(this.rawUrl);
    if (typeof onChunk === 'function' && urls.length) {
      try {
        const streamed = await postStream(
          urls[0],
          headers,
          { ...body, stream: true },
          (d) => d.choices?.[0]?.delta?.content ?? d.choices?.[0]?.text ?? '',
          onChunk,
          signal
        );
        if (streamed) return streamed;
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        /* fall back to standard transport */
      }
    }

    let data = null;
    let lastErr = null;
    for (const url of urls) {
      try {
        data = await postJson(url, headers, body);
        break;
      } catch (err) {
        lastErr = err;
        // Only a wrong-route answer justifies retrying another path.
        if (err.status !== 404 && err.status !== 405) throw err;
      }
    }
    if (!data) throw lastErr || new Error('No working chat endpoint found');

    const text = data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? data.content;
    if (!text) throw new Error('Empty response from the custom endpoint');
    return text;
  }

  analyzeScreenshot(base64Image, history = [], onChunk = null, signal = null) {
    return this._send([
      { type: 'text', text: ANALYSIS_PROMPT },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
    ], history, onChunk, signal);
  }

  askFollowUp(question, screenshotBase64 = null, history = [], onChunk = null, signal = null) {
    const content = [{ type: 'text', text: question }];
    for (const image of this.knowledgeImages || []) {
      content.push({ type: 'text', text: imageLabel(image.name) });
      content.push({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } });
    }
    if (screenshotBase64) {
      content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` } });
    }
    return this._send(content, history, onChunk, signal);
  }

  async listModels() {
    if (!this.rawUrl) throw new Error('Custom endpoint URL not set');
    const headers = {};
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const res = await transport()({ url: this.modelsUrl, method: 'GET', headers });
    if (!res.ok) throw new Error(`Failed to fetch /models (HTTP ${res.status})`);
    const parsed = JSON.parse(res.text);
    const raw = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.data)
        ? parsed.data
        : Array.isArray(parsed.models)
          ? parsed.models
          : [];
    return raw
      .map((m) => {
        const id = typeof m === 'string' ? m : String(m.id || m.name || '');
        const label = typeof m === 'string' ? m : String(m.name || m.id || '');
        return { id, label };
      })
      .filter((m) => m.id);
  }
}

// Export as globals for renderer use
window.GeminiAPI = GeminiAPI;
window.OpenRouterAPI = OpenRouterAPI;
window.CustomAPI = CustomAPI;

