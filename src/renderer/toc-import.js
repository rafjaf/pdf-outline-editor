/**
 * TOC Import - Extract a table of contents from an external source
 * using an LLM (OpenAI or Ollama) and match it against the current PDF.
 */

import { state } from './state.js';
import { saveHistory } from './history.js';
import { refreshOutline } from './outline-renderer.js';
import { getSettings } from './settings-modal.js';
import { ensurePdfJsLoaded, getPdfjsLib } from './pdf-viewer.js';

const { ipcRenderer } = require('electron');

let activeImport = null;
let lastExtractedEntries = null;
let logAutoScroll = true;
let waitingDotsTimer = null;

// ===== Modal Management =====

export const openTocImportModal = () => {
  if (!state.pdf) {
    alert('Please open a PDF file first.');
    return;
  }

  const modal = document.getElementById('tocImportModal');
  document.getElementById('tocImportStatus').textContent = '';
  resetLog();
  lastExtractedEntries = null;
  setImportRunningState(false);
  document.getElementById('tocPageRange').value = '';
  getSettings().then((settings) => {
    document.getElementById('tocProviderOverride').value = settings.llmProvider || 'openai';
  }).catch(() => {
    document.getElementById('tocProviderOverride').value = 'openai';
  });
  document.getElementById('tocPdfExtractMode').value = 'auto';

  document.querySelector('input[name="tocSource"][value="external-pdf"]').checked = true;
  updatePageRangeVisibility();

  modal.style.display = 'flex';
};

const closeTocImportModal = () => {
  document.getElementById('tocImportModal').style.display = 'none';
};

const updatePageRangeVisibility = () => {
  const source = document.querySelector('input[name="tocSource"]:checked')?.value;
  document.getElementById('pageRangeGroup').style.display = source === 'current-pdf' ? 'block' : 'none';
  document.getElementById('pdfModeGroup').style.display =
    source === 'current-pdf' || source === 'external-pdf' ? 'block' : 'none';
};

const setStatus = (msg, isError = false) => {
  const el = document.getElementById('tocImportStatus');
  el.textContent = msg;
  el.style.color = isError ? '#dc3545' : 'var(--muted)';
};

const resetLog = () => {
  const el = document.getElementById('tocImportLog');
  if (!el) return;
  el.textContent = '';
  logAutoScroll = true;
};

const appendLog = (text) => {
  const el = document.getElementById('tocImportLog');
  if (!el || !text) return;
  el.textContent += text;
  if (logAutoScroll) {
    el.scrollTop = el.scrollHeight;
  }
};

const appendLogLine = (text) => {
  appendLog(`${text}\n`);
};

const startWaitingDots = () => {
  if (waitingDotsTimer) clearInterval(waitingDotsTimer);
  appendLog('[System] Waiting for model output');
  waitingDotsTimer = setInterval(() => {
    appendLog('.');
  }, 5000);
};

const stopWaitingDots = () => {
  if (!waitingDotsTimer) return;
  clearInterval(waitingDotsTimer);
  waitingDotsTimer = null;
  appendLog('\n');
};

const setImportRunningState = (running) => {
  const startBtn = document.getElementById('tocImportStart');
  const closeBtn = document.getElementById('tocImportClose');
  const exportBtn = document.getElementById('tocImportExport');
  startBtn.disabled = running;
  closeBtn.textContent = running ? 'Cancel' : 'Close';
  exportBtn.disabled = running || !lastExtractedEntries || lastExtractedEntries.length === 0;
};

const throwIfAborted = (signal) => {
  if (signal?.aborted) {
    throw new DOMException('Import cancelled', 'AbortError');
  }
};

// ===== Page Range Parser =====

const parsePageRange = (rangeStr, maxPage) => {
  const pages = new Set();
  const parts = rangeStr.split(',').map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = Math.max(1, start); i <= Math.min(maxPage, end); i++) {
          pages.add(i);
        }
      }
    } else {
      const num = Number(part);
      if (!isNaN(num) && num >= 1 && num <= maxPage) {
        pages.add(num);
      }
    }
  }
  return Array.from(pages).sort((a, b) => a - b);
};

const fromRoman = (text) => {
  if (!text) return null;
  const roman = text.toUpperCase().trim();
  if (!/^[IVXLCDM]+$/.test(roman)) return null;
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let i = 0; i < roman.length; i++) {
    const curr = values[roman[i]];
    const next = values[roman[i + 1]] || 0;
    total += curr < next ? -curr : curr;
  }
  return total > 0 ? total : null;
};

const parseEntriesPayload = (payload) => {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const entries = parsed.entries || parsed.toc || parsed.items || parsed;
  if (!Array.isArray(entries)) {
    throw new Error('JSON does not contain an entries array');
  }

  return entries.map(e => ({
    title: String(e.title || 'Untitled').trim(),
    page: parseInt(e.page, 10) || 0,
    level: Math.max(1, parseInt(e.level, 10) || 1)
  }));
};

// ===== PDF Text Extraction =====

const extractTextFromPdf = async (pdfDoc, pageNumbers = null, signal = null) => {
  const pages = pageNumbers || Array.from({ length: pdfDoc.numPages }, (_, i) => i + 1);
  const texts = [];

  for (const pageNum of pages) {
    throwIfAborted(signal);
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const text = textContent.items.map(item => item.str).join(' ');
    texts.push({ pageNum, text });
  }

  return texts;
};

const extractAllPageTexts = async (pdfDoc, signal = null) => {
  const texts = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    throwIfAborted(signal);
    const page = await pdfDoc.getPage(i);
    const textContent = await page.getTextContent();
    texts.push(textContent.items.map(item => item.str).join(' '));
  }
  return texts; // 0-indexed: texts[0] = page 1
};

const extractPrintedPageLabels = async (pdfDoc, signal = null) => {
  const labelsPerPage = [];

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    throwIfAborted(signal);
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const lineMap = new Map();

    for (const item of textContent.items) {
      const text = String(item.str || '').trim();
      if (!text) continue;

      const y = Math.round((item.transform?.[5] || 0) / 3) * 3;
      if (!lineMap.has(y)) lineMap.set(y, []);
      lineMap.get(y).push(text);
    }

    const sortedLines = Array.from(lineMap.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([, lineItems]) => lineItems.join(' ').trim())
      .filter(Boolean);

    const candidateLines = [];
    if (sortedLines[0]) candidateLines.push(sortedLines[0]);
    if (sortedLines.length > 1) candidateLines.push(sortedLines[sortedLines.length - 1]);

    const pageLabels = new Set();
    for (const line of candidateLines) {
      const nums = line.match(/\b\d{1,4}\b/g) || [];
      nums.forEach(n => pageLabels.add(parseInt(n, 10)));

      const romans = line.match(/\b[ivxlcdmIVXLCDM]{1,10}\b/g) || [];
      romans.forEach((romanToken) => {
        const romanValue = fromRoman(romanToken);
        if (romanValue) pageLabels.add(romanValue);
      });
    }

    labelsPerPage.push(pageLabels);
  }

  return labelsPerPage;
};

// ===== Image Rendering (for image-based PDFs) =====

const renderPagesToImages = async (pdfDoc, pageNumbers, signal = null) => {
  const images = [];
  for (const pageNum of pageNumbers) {
    throwIfAborted(signal);
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    const dataUrl = canvas.toDataURL('image/png');
    images.push(dataUrl.replace('data:image/png;base64,', ''));
  }
  return images;
};

// ===== LLM Prompts =====

const TOC_SYSTEM_PROMPT = `You are a TOC extraction assistant. You extract tables of contents from documents and return structured JSON.`;

const TOC_TEXT_PROMPT = `Extract the table of contents from the following text and return it as a JSON object with a single key "entries" containing an array.

Each entry must have:
- "title" (string): The heading text, cleaned of page numbers, leader dots, dashes, and formatting artifacts.
- "page" (integer): The page number as printed in the TOC. Use 0 if no page number is found.
- "level" (integer): The hierarchy level, starting at 1 for top-level headings (e.g. parts, chapters), 2 for sections, 3 for subsections, etc.

CRITICAL RULES:
1. Preserve the exact order from the source.
2. No level skipping: level 1 can only have level 2 children, level 2 can only have level 3 children, etc. If the source skips levels, promote items to fill gaps.
3. Clean title text thoroughly: remove leader dots (....), dashes (---), page numbers at the end, tab characters, and decorative formatting.
4. Return ONLY valid JSON. No markdown code fences, no extra text before or after.
5. If you see numbering like "1.", "1.1", "1.1.1" etc., use the numbering depth as a hint for the hierarchy level but keep the numbers in the title.
6. Assume the possible hierarchy, when present, is generally of this form (or equivalent in another language): Partie, Titre, Sous-titre, Chapitre, Section, Sous-section, §, I, A, 1, a), 1°, (i). Use this as a strong structural prior.

Return format: {"entries": [{"title": "...", "page": 1, "level": 1}, ...]}

Here is the text:
`;

const TOC_VISION_PROMPT = `These images show pages containing a table of contents from a document. Read the TOC from the images and extract it as a JSON object with a single key "entries" containing an array.

Each entry must have:
- "title" (string): The heading text, cleaned of page numbers, leader dots, dashes, and formatting artifacts.
- "page" (integer): The page number as printed in the TOC. Use 0 if no page number is found.
- "level" (integer): The hierarchy level, starting at 1 for top-level headings (e.g. parts, chapters), 2 for sections, 3 for subsections, etc.

CRITICAL RULES:
1. Preserve the exact order from the source.
2. No level skipping: level 1 can only have level 2 children, level 2 can only have level 3 children, etc. If the source skips levels, promote items to fill gaps.
3. Clean title text thoroughly: remove leader dots (....), dashes (---), page numbers at the end, and decorative formatting.
4. Return ONLY valid JSON. No markdown code fences, no extra text before or after.
5. If you see numbering like "1.", "1.1", "1.1.1" etc., use the numbering depth as a hint for the hierarchy level but keep the numbers in the title.
6. Assume the possible hierarchy, when present, is generally of this form (or equivalent in another language): Partie, Titre, Sous-titre, Chapitre, Section, Sous-section, §, I, A, 1, a), 1°, (i). Use this as a strong structural prior.

Return format: {"entries": [{"title": "...", "page": 1, "level": 1}, ...]}`;

// ===== LLM API Calls =====

const callOpenAI = async (settings, messages, { onChunk, signal }) => {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.openaiApiKey}`
    },
    body: JSON.stringify({
      model: settings.openaiModel,
      messages,
      temperature: 1,
      response_format: { type: 'json_object' },
      stream: true
    }),
    signal
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI API error: ${response.status}`);
  }

  if (!response.body) {
    throw new Error('OpenAI response stream is unavailable');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    throwIfAborted(signal);
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;

      const dataPayload = line.replace(/^data:\s*/, '');
      if (dataPayload === '[DONE]') {
        return full;
      }

      try {
        const data = JSON.parse(dataPayload);
        const delta = data.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          if (onChunk) onChunk(delta);
        }
      } catch {
        // Ignore malformed stream lines
      }
    }
  }

  return full;
};

const callOllama = async (settings, messages, { onChunk, signal }) => {
  const port = settings.ollamaPort || 11434;
  const response = await fetch(`http://localhost:${port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.ollamaModel,
      messages,
      stream: true,
      format: 'json'
    }),
    signal
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error('Ollama response stream is unavailable');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    throwIfAborted(signal);
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      try {
        const chunk = JSON.parse(line);
        const content = chunk.message?.content;
        if (content) {
          full += content;
          if (onChunk) onChunk(content);
        }
        if (chunk.done) {
          return full;
        }
      } catch {
        // Ignore malformed stream lines
      }
    }
  }

  return full;
};

const callLLM = async (settings, { text, images }, { onChunk, signal }) => {
  const isVision = images && images.length > 0;

  if (settings.llmProvider === 'openai') {
    if (!settings.openaiApiKey) {
      throw new Error('OpenAI API key not configured. Please set it in Settings.');
    }

    let userContent;
    if (isVision) {
      userContent = [
        { type: 'text', text: TOC_VISION_PROMPT },
        ...images.map(img => ({
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${img}` }
        }))
      ];
    } else {
      userContent = TOC_TEXT_PROMPT + text;
    }

    const messages = [
      { role: 'system', content: TOC_SYSTEM_PROMPT },
      { role: 'user', content: userContent }
    ];

    return callOpenAI(settings, messages, { onChunk, signal });

  } else if (settings.llmProvider === 'ollama') {
    let messages;
    if (isVision) {
      messages = [
        { role: 'system', content: TOC_SYSTEM_PROMPT },
        { role: 'user', content: TOC_VISION_PROMPT, images }
      ];
    } else {
      messages = [
        { role: 'system', content: TOC_SYSTEM_PROMPT },
        { role: 'user', content: TOC_TEXT_PROMPT + text }
      ];
    }

    return callOllama(settings, messages, { onChunk, signal });

  } else {
    throw new Error(`Unknown LLM provider: ${settings.llmProvider}`);
  }
};

// ===== Response Parsing =====

const parseLLMResponse = (responseText) => {
  let parsed;
  try {
    let cleaned = responseText.trim();
    // Strip markdown code fences if present
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to extract JSON object from the response
    const match = responseText.match(/\{[\s\S]*\}/);
    if (match) {
      parsed = JSON.parse(match[0]);
    } else {
      throw new Error('Could not parse LLM response as JSON');
    }
  }

  const entries = parsed.entries || parsed.toc || parsed.items || parsed;
  if (!Array.isArray(entries)) {
    throw new Error('LLM response does not contain an entries array');
  }

  return entries.map(e => ({
    title: String(e.title || 'Untitled').trim(),
    page: parseInt(e.page, 10) || 0,
    level: Math.max(1, parseInt(e.level, 10) || 1)
  }));
};

// Ensure no level skipping in the hierarchy (operates on 1-based levels)
const normalizeHierarchy = (entries) => {
  if (entries.length === 0) return entries;

  // Ensure first entry is level 1
  const minLevel = Math.min(...entries.map(e => e.level));
  if (minLevel !== 1) {
    const adjustment = 1 - minLevel;
    entries.forEach(e => { e.level += adjustment; });
  }

  // Fix any level skips
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const curr = entries[i];
    if (curr.level > prev.level + 1) {
      curr.level = prev.level + 1;
    }
  }

  return entries;
};

// ===== Page Matching =====

const normalizeText = (text) => String(text || '')
  .normalize('NFKD')
  .replace(/[^a-zA-Z]/g, '')
  .toLowerCase();

const buildLetterBigrams = (text) => {
  const cleaned = normalizeText(text);
  if (cleaned.length < 2) return [];
  const grams = [];
  for (let i = 0; i < cleaned.length - 1; i++) {
    grams.push(cleaned.slice(i, i + 2));
  }
  return grams;
};

const diceSimilarity = (left, right) => {
  const a = buildLetterBigrams(left);
  const b = buildLetterBigrams(right);
  if (a.length === 0 || b.length === 0) return 0;

  const counts = new Map();
  a.forEach((gram) => counts.set(gram, (counts.get(gram) || 0) + 1));

  let intersection = 0;
  b.forEach((gram) => {
    const current = counts.get(gram) || 0;
    if (current > 0) {
      intersection += 1;
      counts.set(gram, current - 1);
    }
  });

  return (2 * intersection) / (a.length + b.length);
};

const titleMatchesPage = (title, pageText) => {
  const normTitle = normalizeText(title);
  const normPage = normalizeText(pageText);

  if (!normTitle || !normPage) return false;

  // Direct substring match
  if (normPage.includes(normTitle)) return true;

  const stopWords = new Set([
    'les', 'des', 'une', 'dans', 'pour', 'avec', 'sans', 'dont', 'entre', 'sous',
    'sur', 'aux', 'du', 'de', 'la', 'le', 'et', 'ou', 'en', 'au', 'par', 'l', 'd',
    'the', 'and', 'for', 'from', 'with', 'that', 'this'
  ]);

  const words = String(title || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z\s]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
  const pageWordsBlob = String(pageText || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z\s]/g, ' ')
    .toLowerCase();

  if (words.length >= 2) {
    const matchedWords = words.filter((w) => pageWordsBlob.includes(w)).length;
    const coverage = matchedWords / words.length;
    const minCoverage = words.length >= 6 ? 0.5 : 0.67;
    if (coverage >= minCoverage) return true;
  }

  const pageTokens = pageWordsBlob.split(/\s+/).filter(Boolean);
  const titleTokenCount = Math.max(1, String(title || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length);

  let best = 0;
  for (let start = 0; start < pageTokens.length; start++) {
    for (let span = Math.max(2, titleTokenCount - 6); span <= titleTokenCount + 8; span++) {
      const end = start + span;
      if (end > pageTokens.length) continue;
      const windowText = pageTokens.slice(start, end).join(' ');
      const score = diceSimilarity(title, windowText);
      if (score > best) best = score;
    }
  }

  const threshold = normTitle.length > 40 ? 0.78 : 0.88;
  if (best >= threshold) return true;

  return false;
};

const verifyTitleAroundPage = (title, pageTexts, pageIdx, maxDistance = 2) => {
  if (pageIdx < 0 || pageIdx >= pageTexts.length) return false;
  if (titleMatchesPage(title, pageTexts[pageIdx])) return true;

  for (let distance = 1; distance <= maxDistance; distance++) {
    const left = pageIdx - distance;
    const right = pageIdx + distance;

    if (left >= 0 && titleMatchesPage(title, pageTexts[left])) return true;
    if (right < pageTexts.length && titleMatchesPage(title, pageTexts[right])) return true;
  }

  return false;
};

const inferMissingPrintedLabels = (labelsPerPage) => {
  const inferred = labelsPerPage.map(set => new Set(set));
  const anchors = [];

  for (let pageIdx = 0; pageIdx < inferred.length; pageIdx++) {
    const numericLabels = Array.from(inferred[pageIdx]).filter(v => Number.isInteger(v) && v > 0);
    if (numericLabels.length > 0) {
      anchors.push({ pageIdx, label: Math.min(...numericLabels) });
    }
  }

  if (anchors.length === 0) return inferred;

  for (let i = 0; i < anchors.length - 1; i++) {
    const left = anchors[i];
    const right = anchors[i + 1];
    const pageDistance = right.pageIdx - left.pageIdx;
    const labelDistance = right.label - left.label;

    if (pageDistance <= 0 || labelDistance !== pageDistance) continue;

    for (let pageIdx = left.pageIdx; pageIdx <= right.pageIdx; pageIdx++) {
      inferred[pageIdx].add(left.label + (pageIdx - left.pageIdx));
    }
  }

  const first = anchors[0];
  for (let pageIdx = first.pageIdx - 1; pageIdx >= 0; pageIdx--) {
    const guessed = first.label - (first.pageIdx - pageIdx);
    if (guessed > 0) inferred[pageIdx].add(guessed);
  }

  const last = anchors[anchors.length - 1];
  for (let pageIdx = last.pageIdx + 1; pageIdx < inferred.length; pageIdx++) {
    inferred[pageIdx].add(last.label + (pageIdx - last.pageIdx));
  }

  return inferred;
};

const detectPageOffset = (entries, pageTexts) => {
  const samplesToCheck = entries.filter(e => e.page > 0).slice(0, 10);
  if (samplesToCheck.length === 0) return 0;

  let bestOffset = 0;
  let bestScore = 0;
  const maxOffset = pageTexts.length;

  for (let offset = -20; offset <= maxOffset; offset++) {
    let score = 0;
    for (const entry of samplesToCheck) {
      const pageIdx = entry.page + offset - 1; // 0-based index
      if (pageIdx >= 0 && pageIdx < pageTexts.length) {
        if (titleMatchesPage(entry.title, pageTexts[pageIdx])) {
          score++;
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }

  return bestOffset;
};

const detectPrintedPageOffset = (entries, labelsPerPage) => {
  const offsetVotes = new Map();

  for (const entry of entries) {
    if (!entry.page || entry.page <= 0) continue;

    for (let pageIndex = 0; pageIndex < labelsPerPage.length; pageIndex++) {
      if (!labelsPerPage[pageIndex].has(entry.page)) continue;
      const offset = pageIndex + 1 - entry.page;
      offsetVotes.set(offset, (offsetVotes.get(offset) || 0) + 1);
    }
  }

  let bestOffset = null;
  let bestVotes = 0;
  for (const [offset, votes] of offsetVotes.entries()) {
    if (votes > bestVotes) {
      bestVotes = votes;
      bestOffset = offset;
    }
  }

  return bestVotes > 0 ? { offset: bestOffset, votes: bestVotes } : null;
};

// ===== Main Import Flow =====

const startImport = async () => {
  const source = document.querySelector('input[name="tocSource"]:checked')?.value;
  if (!source) return;

  if (activeImport?.controller) return;

  const controller = new AbortController();
  const signal = controller.signal;
  activeImport = { controller };
  setImportRunningState(true);

  try {
    appendLogLine('[System] TOC import started.');
    throwIfAborted(signal);

    const settings = await getSettings();
    const providerOverride = document.getElementById('tocProviderOverride').value;
    const importSettings = {
      ...settings,
      llmProvider: providerOverride || settings.llmProvider
    };
    const extractionMode = document.getElementById('tocPdfExtractMode').value;

    // Step 1: Get content from the chosen source
    setStatus('Reading source content...');
    appendLogLine(`[System] Source: ${source}`);
    let contentText = '';
    let contentImages = null;
    let entries = null;

    if (source === 'external-json') {
      const result = await ipcRenderer.invoke('open-toc-file-dialog', { name: 'JSON', extensions: ['json'] });
      if (!result) {
        appendLogLine('[System] JSON import cancelled by user before file selection.');
        setStatus('');
        return;
      }

      throwIfAborted(signal);
      const jsonText = new TextDecoder().decode(result.data);
      entries = normalizeHierarchy(parseEntriesPayload(jsonText));
      appendLogLine(`[System] Loaded ${entries.length} entries from JSON file.`);
      setStatus('JSON loaded. Skipping LLM phase.');
    }

    if (!entries && source === 'current-pdf') {
      const rangeStr = document.getElementById('tocPageRange').value.trim();
      if (!rangeStr) {
        setStatus('Please enter a page range.', true);
        appendLogLine('[System] Missing page range.');
        return;
      }

      const pages = parsePageRange(rangeStr, state.pdf.numPages);
      if (pages.length === 0) {
        setStatus('Invalid page range.', true);
        appendLogLine('[System] Invalid page range.');
        return;
      }

      appendLogLine(`[System] Extracting text from current PDF pages: ${pages.join(', ')}.`);
      const pageData = await extractTextFromPdf(state.pdf, pages, signal);
      throwIfAborted(signal);
      const totalText = pageData.map(p => p.text).join(' ');

      const shouldUseVision = extractionMode === 'vision' ||
        (extractionMode === 'auto' && totalText.replace(/\s/g, '').length < pages.length * 50);

      if (shouldUseVision) {
        setStatus('Pages appear to be image-based. Rendering images for vision...');
        appendLogLine('[System] Low text density detected; switching to vision extraction.');
        contentImages = await renderPagesToImages(state.pdf, pages, signal);
      } else {
        contentText = pageData.map(p => `--- Page ${p.pageNum} ---\n${p.text}`).join('\n\n');
        appendLogLine(`[System] Extracted ${pageData.length} page(s) as text.`);
      }

    } else if (!entries) {
      // Open file dialog for external file
      const filterType = source === 'external-pdf'
        ? { name: 'PDF', extensions: ['pdf'] }
        : { name: 'Text', extensions: ['txt', 'md', 'text'] };

      const result = await ipcRenderer.invoke('open-toc-file-dialog', filterType);
      if (!result) {
        appendLogLine('[System] Import cancelled by user before file selection.');
        setStatus('');
        return;
      }

      throwIfAborted(signal);

      if (source === 'external-text') {
        contentText = new TextDecoder().decode(result.data);
        appendLogLine(`[System] Loaded external text file (${contentText.length} chars).`);
      } else {
        // External PDF - load and extract text
        await ensurePdfJsLoaded();
        const pdfjsLib = getPdfjsLib();
        const externalPdf = await pdfjsLib.getDocument({ data: result.data }).promise;
        appendLogLine(`[System] Loaded external PDF (${externalPdf.numPages} pages).`);
        const pageData = await extractTextFromPdf(externalPdf, null, signal);
        throwIfAborted(signal);
        const totalText = pageData.map(p => p.text).join(' ');

        const shouldUseVision = extractionMode === 'vision' ||
          (extractionMode === 'auto' && totalText.replace(/\s/g, '').length < externalPdf.numPages * 50);

        if (shouldUseVision) {
          setStatus('PDF appears to be image-based. Rendering images for vision...');
          appendLogLine('[System] Low text density detected; switching to vision extraction.');
          const allPages = Array.from({ length: externalPdf.numPages }, (_, i) => i + 1);
          contentImages = await renderPagesToImages(externalPdf, allPages, signal);
        } else {
          contentText = pageData.map(p => `--- Page ${p.pageNum} ---\n${p.text}`).join('\n\n');
          appendLogLine(`[System] Extracted ${pageData.length} page(s) as text.`);
        }
      }
    }

    throwIfAborted(signal);

    if (!entries) {
      // Step 2: Call LLM
      const providerLabel = importSettings.llmProvider === 'openai'
        ? `OpenAI (${importSettings.openaiModel})`
        : `Ollama (${importSettings.ollamaModel})`;
      setStatus(`Calling ${providerLabel}... This may take a moment.`);
      appendLogLine(`[System] Calling ${providerLabel}.`);
      startWaitingDots();

      let streamingAnnounced = false;

      const llmResponse = await callLLM(
        importSettings,
        { text: contentText, images: contentImages },
        {
          signal,
          onChunk: (chunk) => {
            if (!streamingAnnounced) {
              stopWaitingDots();
              appendLogLine('[System] Streaming model output:');
              streamingAnnounced = true;
            }
            appendLog(chunk);
          }
        }
      );

      stopWaitingDots();

      appendLogLine('\n[System] Model response stream completed.');
      throwIfAborted(signal);

      // Step 3: Parse response
      setStatus('Parsing TOC structure...');
      appendLogLine('[System] Parsing model JSON response.');
      entries = parseLLMResponse(llmResponse);
      entries = normalizeHierarchy(entries);
    }

    if (entries.length === 0) {
      setStatus('No TOC entries found in the LLM response.', true);
      appendLogLine('[System] No TOC entries found.');
      return;
    }

    lastExtractedEntries = entries.map(entry => ({
      title: entry.title,
      page: entry.page,
      level: entry.level
    }));
    setImportRunningState(true);

    // Step 4: Match against current PDF
    setStatus(`Matching ${entries.length} entries against current PDF...`);
    appendLogLine(`[System] Matching ${entries.length} entries against current PDF pages.`);
    const pageTexts = await extractAllPageTexts(state.pdf, signal);
    const rawPrintedLabels = await extractPrintedPageLabels(state.pdf, signal);
    const printedLabels = inferMissingPrintedLabels(rawPrintedLabels);
    throwIfAborted(signal);

    // Detect page offset (difference between TOC page numbers and actual PDF pages)
    const printedOffsetResult = detectPrintedPageOffset(entries, printedLabels);
    const offset = printedOffsetResult?.offset ?? detectPageOffset(entries, pageTexts);
    if (printedOffsetResult) {
      appendLogLine(`[System] Detected page offset from printed page numbers: ${offset > 0 ? '+' : ''}${offset} (${printedOffsetResult.votes} matches).`);
    } else {
      appendLogLine(`[System] Detected page offset from title matching: ${offset > 0 ? '+' : ''}${offset}.`);
    }

    // Create outline items with verification
    const newOutline = entries.map(entry => {
      let pageIdx = Math.max(0, Math.min(
        state.pdf.numPages - 1,
        entry.page > 0 ? entry.page + offset - 1 : 0
      ));

      if (entry.page > 0 && !printedLabels[pageIdx]?.has(entry.page)) {
        for (let distance = 1; distance <= 5; distance++) {
          const left = pageIdx - distance;
          const right = pageIdx + distance;
          if (left >= 0 && printedLabels[left]?.has(entry.page)) {
            pageIdx = left;
            break;
          }
          if (right < printedLabels.length && printedLabels[right]?.has(entry.page)) {
            pageIdx = right;
            break;
          }
        }
      }

      // Verify that the title text appears on the target page
      const verified = verifyTitleAroundPage(entry.title, pageTexts, pageIdx, 2);

      return {
        id: crypto.randomUUID(),
        title: entry.title,
        pageIndex: pageIdx,
        level: entry.level - 1, // Convert from 1-based (LLM) to 0-based (internal)
        ...(verified ? {} : { unverified: true })
      };
    });

    // Step 5: Apply to outline
    saveHistory('Import TOC');
    state.outline = newOutline;
    state.selectedIds.clear();
    state.lastSelectedId = null;
    refreshOutline();

    const verifiedCount = newOutline.filter(i => !i.unverified).length;
    const unverifiedCount = newOutline.length - verifiedCount;

    let summary = `Imported ${newOutline.length} entries.`;
    if (offset !== 0) summary += ` Page offset: ${offset > 0 ? '+' : ''}${offset}.`;
    if (unverifiedCount > 0) summary += ` ${unverifiedCount} not verified (shown in red).`;
    else summary += ' All entries verified.';

    setStatus(summary);
    appendLogLine(`[System] ${summary}`);
    appendLogLine('[System] Import finished. You can review this log and close the dialog when ready.');

  } catch (err) {
    console.error('TOC import error:', err);
    stopWaitingDots();
    if (err?.name === 'AbortError') {
      setStatus('Import cancelled.');
      appendLogLine('[System] Import cancelled by user.');
    } else {
      setStatus(`Error: ${err.message}`, true);
      appendLogLine(`[System] Error: ${err.message}`);
    }
  } finally {
    stopWaitingDots();
    activeImport = null;
    setImportRunningState(false);
  }
};

// ===== Setup =====

export const setupTocImportHandlers = () => {
  const logElement = document.getElementById('tocImportLog');
  logElement.addEventListener('scroll', () => {
    const gap = logElement.scrollHeight - logElement.scrollTop - logElement.clientHeight;
    logAutoScroll = gap <= 8;
  });

  document.querySelectorAll('input[name="tocSource"]').forEach(radio => {
    radio.addEventListener('change', updatePageRangeVisibility);
  });

  document.getElementById('tocImportClose').addEventListener('click', () => {
    if (activeImport?.controller) {
      activeImport.controller.abort();
      setStatus('Cancelling import...');
      appendLogLine('\n[System] Cancelling import...');
      return;
    }
    closeTocImportModal();
  });

  document.getElementById('tocImportExport').addEventListener('click', async () => {
    if (!lastExtractedEntries || lastExtractedEntries.length === 0) return;
    try {
      const payload = { entries: lastExtractedEntries };
      const result = await ipcRenderer.invoke('save-toc-json-dialog', payload);
      if (!result) return;
      setStatus(`Exported JSON to ${result.filePath}`);
      appendLogLine(`[System] Exported JSON to ${result.filePath}`);
    } catch (error) {
      setStatus(`Export failed: ${error.message}`, true);
      appendLogLine(`[System] Export failed: ${error.message}`);
    }
  });

  document.getElementById('tocImportStart').addEventListener('click', startImport);

  document.getElementById('tocImportModal').addEventListener('click', (event) => {
    if (event.target !== event.currentTarget) return;
    if (activeImport?.controller) {
      activeImport.controller.abort();
      setStatus('Cancelling import...');
      appendLogLine('\n[System] Cancelling import...');
      return;
    }
    closeTocImportModal();
  });

  document.getElementById('tocImportModal').addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (activeImport?.controller) {
      activeImport.controller.abort();
      setStatus('Cancelling import...');
      appendLogLine('\n[System] Cancelling import...');
      return;
    }
    closeTocImportModal();
  });

  document.getElementById('tocPageRange').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') startImport();
  });
};
