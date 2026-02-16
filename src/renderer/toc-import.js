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
  // Export button stays enabled once entries are available, even during matching
  exportBtn.disabled = !lastExtractedEntries || lastExtractedEntries.length === 0;
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

// ===== Combined Page Data Extraction =====

/**
 * Extract a candidate page number from a single text line.
 * Returns the number if found, or null.
 */
const extractPageNumberFromLine = (lineText) => {
  if (!lineText) return null;
  const trimmed = lineText.trim();

  // Exact match: line is just a number (1-4 digits)
  if (/^\d{1,4}$/.test(trimmed)) return parseInt(trimmed, 10);

  // Decorated pattern: "— 101 —", "- 101 -", "| 101 |", etc.
  const decoratedMatch = trimmed.match(/^[\s—–\-|.·•*_~]+?(\d{1,4})[\s—–\-|.·•*_~]*$/);
  if (decoratedMatch) return parseInt(decoratedMatch[1], 10);

  // Number at the edge of a reasonably short line (header/footer)
  if (trimmed.length < 120) {
    // End of line (common position for page numbers)
    const endMatch = trimmed.match(/[\s—–\-|,]+(\d{1,4})$/);
    if (endMatch) return parseInt(endMatch[1], 10);

    // Start of line, but NOT if followed by "." or ")" (section numbering like "1.", "2)")
    const startMatch = trimmed.match(/^(\d{1,4})[\s—–\-|]/);
    if (startMatch && !/^\d+[.°):]/.test(trimmed)) {
      return parseInt(startMatch[1], 10);
    }
  }

  return null;
};

/**
 * Try extracting a page number from an ordered list of candidate lines.
 * First match wins.
 */
const extractPageNumberFromLines = (lines) => {
  for (const line of lines) {
    const num = extractPageNumberFromLine(line);
    if (num !== null) return num;
  }
  return null;
};

/**
 * Score how many consecutive pages in a number sequence increment by exactly 1.
 * Higher score = more consistent = more likely to be actual page numbers.
 */
const scoreConsistency = (nums) => {
  let score = 0;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] !== null && nums[i - 1] !== null && nums[i] === nums[i - 1] + 1) {
      score++;
    }
  }
  return score;
};

/**
 * Extract both full text and page-number candidates from every PDF page in a single pass.
 * Returns { pageTexts: string[], pageCandidates: { top: number|null, bottom: number|null }[] }
 */
const extractAllPageData = async (pdfDoc, signal = null, logFn = null) => {
  const pageTexts = [];      // 0-indexed: pageTexts[0] = PDF page 1
  const pageCandidates = []; // 0-indexed: { top, bottom } for each page

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    throwIfAborted(signal);
    if (logFn && (pageNum % 50 === 0 || pageNum === 1)) {
      logFn(`  Scanning page ${pageNum}/${pdfDoc.numPages}...`);
    }

    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();

    // Full text for title matching
    pageTexts.push(textContent.items.map(item => item.str).join(' '));

    // Group text items into lines by Y coordinate for page-number detection
    const lineMap = new Map();
    for (const item of textContent.items) {
      const text = String(item.str || '').trim();
      if (!text) continue;
      const y = Math.round((item.transform?.[5] || 0) / 3) * 3;
      if (!lineMap.has(y)) lineMap.set(y, []);
      lineMap.get(y).push(text);
    }

    if (lineMap.size === 0) {
      pageCandidates.push({ top: null, bottom: null });
      continue;
    }

    // Sort Y values descending (top of page = high Y first)
    const sortedYs = Array.from(lineMap.keys()).sort((a, b) => b - a);

    // Top area: first 2 lines (highest Y values)
    const topLines = sortedYs.slice(0, 2)
      .map(y => lineMap.get(y).join(' ').trim());

    // Bottom area: last 2 lines (lowest Y values), reversed so outermost is first
    const bottomLines = [...sortedYs.slice(-2)].reverse()
      .map(y => lineMap.get(y).join(' ').trim());

    pageCandidates.push({
      top: extractPageNumberFromLines(topLines),
      bottom: extractPageNumberFromLines(bottomLines)
    });
  }

  return { pageTexts, pageCandidates };
};

/**
 * Build a mapping from printed page numbers to PDF page indices (0-based).
 * Determines whether page numbers are at the top or bottom of the page
 * by comparing sequence consistency.
 */
const buildPageNumberMap = (pageCandidates, logFn = null) => {
  const topNums = pageCandidates.map(c => c.top);
  const bottomNums = pageCandidates.map(c => c.bottom);

  const topScore = scoreConsistency(topNums);
  const bottomScore = scoreConsistency(bottomNums);

  const useTop = topScore > bottomScore;
  const chosenNums = useTop ? topNums : bottomNums;
  const position = useTop ? 'top' : 'bottom';

  const printedToPdf = new Map(); // printedPageNumber → pdfPageIndex (0-based)
  const pdfToPrinted = new Map(); // pdfPageIndex (0-based) → printedPageNumber

  for (let i = 0; i < chosenNums.length; i++) {
    const num = chosenNums[i];
    if (num !== null && num > 0) {
      // First occurrence wins in case of duplicates
      if (!printedToPdf.has(num)) {
        printedToPdf.set(num, i);
      }
      pdfToPrinted.set(i, num);
    }
  }

  if (logFn) {
    logFn(`[System] Page numbers detected at ${position} of pages (consistency: top=${topScore}, bottom=${bottomScore}). ${printedToPdf.size} pages mapped.`);
  }

  return { printedToPdf, pdfToPrinted, position };
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

/**
 * Check if a title matches on the target page or within a small distance.
 * Returns the matched page index, or null if no match.
 */
const titleMatchesPageArea = (title, pageTexts, targetPageIdx, maxDistance = 1) => {
  if (targetPageIdx >= 0 && targetPageIdx < pageTexts.length &&
      titleMatchesPage(title, pageTexts[targetPageIdx])) {
    return targetPageIdx;
  }

  for (let d = 1; d <= maxDistance; d++) {
    const left = targetPageIdx - d;
    const right = targetPageIdx + d;
    if (left >= 0 && titleMatchesPage(title, pageTexts[left])) return left;
    if (right < pageTexts.length && titleMatchesPage(title, pageTexts[right])) return right;
  }

  return null;
};

/**
 * Search for a title's text across a range of PDF pages.
 * Returns the first matching page index, or null.
 */
const searchTitleInRange = (title, pageTexts, lowerBound, upperBound) => {
  const start = Math.max(0, lowerBound);
  const end = Math.min(pageTexts.length - 1, upperBound);
  for (let i = start; i <= end; i++) {
    if (titleMatchesPage(title, pageTexts[i])) return i;
  }
  return null;
};

/**
 * Two-pass matching of TOC entries against the PDF.
 *
 * Pass 1 – page-number lookup:
 *   For each entry whose printed page number is in the page map, look up the
 *   corresponding PDF page and check if the title text appears on it (or
 *   within ±2 pages to handle unnumbered chapter openers).
 *   • Title found  → verified  (black)
 *   • Title absent → uncertain (orange)
 *
 * Pass 2 – title search:
 *   For entries with no page match in the map, search for the title between
 *   the closest resolved neighbours.
 *   • Title found  → uncertain  (orange)
 *   • Title absent → unverified (red) – fall back to last known page
 */
const matchEntriesAgainstPdf = (entries, pageTexts, printedToPdf, logFn) => {
  const results = new Array(entries.length).fill(null);

  // ---- Pass 1 ----
  logFn('[System] Pass 1: matching entries by printed page number...');
  let pass1Verified = 0;
  let pass1Uncertain = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.page <= 0 || !printedToPdf.has(entry.page)) continue;

    const pdfPageIdx = printedToPdf.get(entry.page);
    const titlePageIdx = titleMatchesPageArea(entry.title, pageTexts, pdfPageIdx, 2);

    if (titlePageIdx !== null) {
      results[i] = { pageIndex: titlePageIdx, confidence: 'verified' };
      pass1Verified++;
    } else {
      results[i] = { pageIndex: pdfPageIdx, confidence: 'uncertain' };
      pass1Uncertain++;
    }
  }

  logFn(`[System] Pass 1 result: ${pass1Verified + pass1Uncertain}/${entries.length} resolved (${pass1Verified} verified, ${pass1Uncertain} uncertain).`);

  // ---- Pass 2 ----
  const unresolvedCount = results.filter(r => r === null).length;
  if (unresolvedCount > 0) {
    logFn(`[System] Pass 2: searching for ${unresolvedCount} remaining entries by title text...`);
    let pass2Found = 0;
    let pass2NotFound = 0;

    for (let i = 0; i < entries.length; i++) {
      if (results[i] !== null) continue;

      // Determine search bounds from nearest resolved neighbours
      let lowerBound = 0;
      let upperBound = pageTexts.length - 1;

      for (let j = i - 1; j >= 0; j--) {
        if (results[j] !== null) {
          lowerBound = results[j].pageIndex;
          break;
        }
      }
      for (let j = i + 1; j < entries.length; j++) {
        if (results[j] !== null) {
          upperBound = results[j].pageIndex;
          break;
        }
      }

      const found = searchTitleInRange(entries[i].title, pageTexts, lowerBound, upperBound);

      if (found !== null) {
        results[i] = { pageIndex: found, confidence: 'uncertain' };
        pass2Found++;
      } else {
        results[i] = { pageIndex: Math.max(0, lowerBound), confidence: 'unverified' };
        pass2NotFound++;
      }
    }

    logFn(`[System] Pass 2 result: ${pass2Found} found by title, ${pass2NotFound} not found.`);
  }

  return results;
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
    // Enable JSON export as soon as entries are available (even while matching)
    document.getElementById('tocImportExport').disabled = false;

    // Step 4: Match against current PDF
    setStatus(`Matching ${entries.length} entries against current PDF...`);
    appendLogLine(`\n[System] Matching ${entries.length} entries against current PDF pages.`);

    appendLogLine('[System] Scanning all PDF pages for page numbers and text...');
    const { pageTexts, pageCandidates } = await extractAllPageData(
      state.pdf, signal, (msg) => appendLogLine(msg)
    );
    throwIfAborted(signal);

    const { printedToPdf } = buildPageNumberMap(pageCandidates, (msg) => appendLogLine(msg));

    // Two-pass matching: page-number lookup then title search
    const matchResults = matchEntriesAgainstPdf(
      entries, pageTexts, printedToPdf, (msg) => appendLogLine(msg)
    );

    // Build outline items from match results
    const newOutline = entries.map((entry, i) => {
      const result = matchResults[i];
      const item = {
        id: crypto.randomUUID(),
        title: entry.title,
        pageIndex: result.pageIndex,
        level: entry.level - 1 // Convert from 1-based (LLM) to 0-based (internal)
      };

      if (result.confidence === 'uncertain') {
        item.uncertain = true;
      } else if (result.confidence === 'unverified') {
        item.unverified = true;
      }

      return item;
    });

    // Step 5: Apply to outline
    saveHistory('Import TOC');
    state.outline = newOutline;
    state.selectedIds.clear();
    state.lastSelectedId = null;
    refreshOutline();

    const verifiedCount = newOutline.filter(i => !i.unverified && !i.uncertain).length;
    const uncertainCount = newOutline.filter(i => i.uncertain).length;
    const unverifiedCount = newOutline.filter(i => i.unverified).length;

    let summary = `Imported ${newOutline.length} entries:`;
    summary += ` ${verifiedCount} verified`;
    if (uncertainCount > 0) summary += `, ${uncertainCount} uncertain (orange)`;
    if (unverifiedCount > 0) summary += `, ${unverifiedCount} not found (red)`;
    summary += '.';

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
