/**
 * Invisible — Knowledge Base (local document index)
 * @author Zen (zhwzein)
 * @github https://github.com/zhwzein/invisible
 * @license MIT
 */

// Nothing here trains a model. The folder is converted into a local text index;
// the few passages that match a question are pasted into the system prompt of
// that one request. The model stays untouched, the folder never leaves the
// machine, and only the matched passages travel to the provider.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Bumped to 2 when images joined the index; an older cache has no `images`
// field, so it must be rebuilt once rather than trusted.
const INDEX_VERSION = 2;
const MAX_FILE_BYTES = 40 * 1024 * 1024;
const MAX_FILES = 400;
const CHUNK_TARGET = 900;
const CHUNK_OVERLAP = 150;
const SUPPORTED = new Set(['.pdf', '.txt', '.md', '.markdown']);
// Images are never read as text and never OCR'd. They are listed here only so
// retrieval knows they exist; the file itself is handed to the model as a real
// image when a question needs it.
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

const MAX_IMAGES = 60;

let pdfjsPromise = null;

// pdfjs-dist is loaded lazily: it is only needed once a PDF actually exists in
// the folder, and a load failure must not take the whole app down.
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const mod = require('pdfjs-dist/legacy/build/pdf.js');
      const pdfjs = mod.default || mod;
      // No worker thread in the main process: run the extraction inline.
      if (pdfjs.GlobalWorkerOptions) {
        pdfjs.GlobalWorkerOptions.workerSrc = require.resolve('pdfjs-dist/legacy/build/pdf.worker.js');
      }
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

async function extractPdf(filePath) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(fs.readFileSync(filePath));
  // Only text is read, never rendered, so the canvas/Path2D polyfill warnings
  // are noise. Standard font data is still pointed at so cmap-less PDFs extract.
  const standardFontDataUrl = path.join(
    path.dirname(require.resolve('pdfjs-dist/package.json')),
    'standard_fonts'
  ) + path.sep;
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true,
    standardFontDataUrl,
    verbosity: 0,
  }).promise;

  const pages = [];
  try {
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = '';
      const parts = [];
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        parts.push(item.str);
        if (item.hasEOL) {
          parts.push('\n');
          line = '';
        }
      }
      pages.push(parts.join('').replace(/[ \t]+\n/g, '\n'));
      page.cleanup();
    }
  } finally {
    doc.destroy();
  }
  return pages.join('\n\n');
}

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return extractPdf(filePath);
  return fs.readFileSync(filePath, 'utf8');
}

// Sentences are the natural boundary, so chunks stay readable when they reach
// the model instead of cutting a word in half.
function chunkText(text, source) {
  const clean = String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!clean) return [];

  const sentences = clean.match(/[^.!?\n]+[.!?]*\n?/g) || [clean];
  const chunks = [];
  let buffer = '';

  const flush = () => {
    const body = buffer.trim();
    if (body.length >= 40) chunks.push({ source, text: body });
    buffer = body.length > CHUNK_OVERLAP ? body.slice(-CHUNK_OVERLAP) : '';
  };

  for (const sentence of sentences) {
    if (buffer.length + sentence.length > CHUNK_TARGET) flush();
    buffer += sentence;
  }
  flush();

  return chunks;
}

// Images are collected separately: they never become text, so they cannot be
// chunked or searched the way a document is. They are handed to the model as
// pixels later, which is why no OCR step exists anywhere in this file.
function listDocuments(folder) {
  const entries = fs.readdirSync(folder, { withFileTypes: true });
  const files = [];
  const images = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    const isText = SUPPORTED.has(ext);
    const isImage = IMAGE_EXT.has(ext);
    if (!isText && !isImage) continue;
    const full = path.join(folder, entry.name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.size > MAX_FILE_BYTES) continue;
    const record = { path: full, name: entry.name, mtimeMs: stat.mtimeMs, size: stat.size };
    if (isImage) {
      if (images.length < MAX_IMAGES) images.push(record);
      continue;
    }
    files.push(record);
    if (files.length >= MAX_FILES) break;
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  // Newest first: when a question matches no filename the freshest images are
  // the ones most likely to be the ones being asked about.
  images.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { files, images };
}

// The signature decides whether the cache may be reused, so a renamed or
// edited file triggers exactly one re-index and nothing else does.
function signatureOf(folder, files, images) {
  const payload = JSON.stringify({
    v: INDEX_VERSION,
    folder,
    files: files.map((f) => [f.name, f.mtimeMs, f.size]),
    images: (images || []).map((f) => [f.name, f.mtimeMs, f.size]),
  });
  return crypto.createHash('sha1').update(payload).digest('hex');
}

function indexCachePath(userDataDir) {
  return path.join(userDataDir, 'knowledge', 'index.json');
}

function readCache(userDataDir) {
  try {
    const raw = fs.readFileSync(indexCachePath(userDataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === INDEX_VERSION && Array.isArray(parsed.chunks)) return parsed;
  } catch { /* no usable cache */ }
  return null;
}

function writeCache(userDataDir, payload) {
  const file = indexCachePath(userDataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
}

// ─── BM25 ───────────────────────────────────────────────────────────────────
// Small enough to live in memory and good enough to find the right passage.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at', 'for',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these',
  'those', 'as', 'by', 'with', 'from', 'or', 'not', 'no', 'do', 'does', 'did',
  'yang', 'dan', 'atau', 'untuk', 'dengan', 'pada', 'dari', 'ke', 'di', 'itu',
  'ini', 'adalah', 'akan', 'tidak', 'juga', 'dalam', 'sebagai', 'oleh', 'agar',
]);

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9\u00c0-\u024f\u0600-\u06ff]+/i)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function buildIndex(chunks) {
  const docs = chunks.map((chunk) => {
    const tokens = tokenize(chunk.text);
    const tf = new Map();
    for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
    return { ...chunk, tf, length: tokens.length };
  });

  const df = new Map();
  for (const doc of docs) {
    for (const token of doc.tf.keys()) df.set(token, (df.get(token) || 0) + 1);
  }

  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / (docs.length || 1);
  return { docs, df, avgLength };
}

function searchIndex(index, query, limit = 4) {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !index.docs.length) return [];

  const total = index.docs.length;
  const k1 = 1.5;
  const b = 0.75;

  const scored = index.docs.map((doc) => {
    let score = 0;
    for (const term of terms) {
      const freq = doc.tf.get(term);
      if (!freq) continue;
      const docFreq = index.df.get(term) || 0;
      const idf = Math.log(1 + (total - docFreq + 0.5) / (docFreq + 0.5));
      const norm = freq + k1 * (1 - b + b * (doc.length / (index.avgLength || 1)));
      score += idf * ((freq * (k1 + 1)) / norm);
    }
    return { doc, score };
  });

  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, limit)
    .map((entry) => ({ source: entry.doc.source, text: entry.doc.text, score: entry.score }));
}

// ─── Public API ─────────────────────────────────────────────────────────────

// Returns the cached index when the folder contents are unchanged, otherwise
// re-reads every document. `force` skips the cache check.
async function buildIndexFor(folder, userDataDir, { force = false } = {}) {
  if (!folder) throw new Error('No folder selected');
  let stat;
  try { stat = fs.statSync(folder); } catch { throw new Error('Folder not found'); }
  if (!stat.isDirectory()) throw new Error('Path is not a folder');

  const { files, images } = listDocuments(folder);
  const signature = signatureOf(folder, files, images);

  if (!force) {
    const cached = readCache(userDataDir);
    if (cached && cached.signature === signature) {
      return { ...cached, fromCache: true };
    }
  }

  const chunks = [];
  const failures = [];
  let emptyFiles = 0;

  for (const file of files) {
    try {
      const text = await extractText(file.path);
      const produced = chunkText(text, file.name);
      if (!produced.length) emptyFiles += 1;
      chunks.push(...produced);
    } catch (err) {
      failures.push(`${file.name}: ${err.message}`);
    }
  }

  const payload = {
    version: INDEX_VERSION,
    signature,
    folder,
    files: files.map((f) => ({ name: f.name, size: f.size, mtimeMs: f.mtimeMs })),
    images: images.map((f) => ({ name: f.name, size: f.size, mtimeMs: f.mtimeMs })),
    chunks,
    emptyFiles,
    failures,
    builtAt: new Date().toISOString(),
  };

  writeCache(userDataDir, payload);
  return { ...payload, fromCache: false };
}

// Images cannot be scored by content without OCR, so they are matched by name.
// A question naming a file ("the receipt one") picks that image; anything else
// falls back to the newest images, which is what someone asking about a picture
// they just dropped into the folder means.
function searchImages(payload, query, limit = 3) {
  const images = (payload && Array.isArray(payload.images)) ? payload.images : [];
  if (!images.length) return [];

  const terms = [...new Set(tokenize(query))];
  const scored = images.map((image, position) => {
    const name = String(image.name || '').toLowerCase().replace(/\.[a-z0-9]+$/, '');
    const nameTerms = new Set(tokenize(name));
    let score = 0;
    for (const term of terms) {
      if (nameTerms.has(term)) score += 2;
      else if (name.includes(term) && term.length > 2) score += 1;
    }
    // Later entries are newer (the list is sorted newest first), so recency acts
    // as a weak tie-breaker instead of a filter.
    return { image, score: score - position * 0.001 };
  });

  const named = scored.filter((entry) => entry.score > 0);
  const pool = named.length ? named : scored;
  return pool.slice(0, limit).map((entry) => ({
    name: entry.image.name,
    path: path.join(payload.folder, entry.image.name),
    score: entry.score,
  }));
}

// A question typed by the user rarely happens when the point is a picture on
// screen: the screenshot is the question. With no query there is nothing to
// score, so a small folder is sent whole (it fits the prompt anyway) and a large
// one is reduced to its file list plus whatever fits the budget, newest first.
// Returns { context, full } — `full` tells the caller nothing had to be dropped.
function fullContext(payload, maxChars = 20000) {
  const chunks = (payload && Array.isArray(payload.chunks)) ? payload.chunks : [];
  if (!chunks.length) return { context: '', full: true };

  const parts = [];
  let used = 0;
  for (const chunk of chunks) {
    const block = `[${chunk.source}]\n${chunk.text}`;
    if (used + block.length > maxChars && parts.length) {
      return {
        context: `${parts.join('\n\n')}\n\nThe folder holds more documents than are shown here (${chunks.length} passages in total); name the file you want if this is not enough.`,
        full: false,
      };
    }
    parts.push(block);
    used += block.length;
  }
  return { context: parts.join('\n\n'), full: true };
}

function indexSummary(payload) {
  if (!payload) return { folder: '', fileCount: 0, chunkCount: 0, builtAt: null, emptyFiles: 0, imageCount: 0 };
  return {
    folder: payload.folder || '',
    fileCount: Array.isArray(payload.files) ? payload.files.length : 0,
    chunkCount: Array.isArray(payload.chunks) ? payload.chunks.length : 0,
    imageCount: Array.isArray(payload.images) ? payload.images.length : 0,
    builtAt: payload.builtAt || null,
    emptyFiles: payload.emptyFiles || 0,
    failures: payload.failures || [],
  };
}

module.exports = {
  buildIndexFor,
  indexSummary,
  searchIndex,
  searchImages,
  fullContext,
  buildIndex,
  chunkText,
};
