/**
 * TOC Import - Extract a table of contents from an external source
 * using an LLM (OpenAI, an OpenAI-compatible server, or Ollama) and match it
 * against the current PDF.
 */

import { state } from './state.js';
import { saveHistory } from './history.js';
import { refreshOutline } from './outline-renderer.js';
import { getSettings } from './settings-modal.js';
import { ensurePdfJsLoaded, getPdfjsLib } from './pdf-viewer.js';
import { detectPdfHeadings } from './heading-detection.js';
import { refineHeadingsWithAi } from '../shared/heading-ai.js';

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
    // Cached PDF.js responses can all resolve as microtasks; yield periodically
    // so progress paints and the Cancel button receives events during reads.
    if (texts.length % 10 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }

  return texts;
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

const openAICompatibleEndpoint = (baseUrl) => {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');

  if (!path.endsWith('/chat/completions')) {
    url.pathname = path.endsWith('/v1')
      ? `${path}/chat/completions`
      : `${path}/v1/chat/completions`;
  }

  return url.toString();
};

const callOpenAIChatCompletions = async ({ url, apiKey, model, providerName }, messages, { onChunk, signal, maxOutputTokens }) => {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      temperature: 1,
      response_format: { type: 'json_object' },
      stream: true,
      ...(maxOutputTokens ? (providerName === 'OpenAI'
        ? { max_completion_tokens: maxOutputTokens }
        : { max_tokens: maxOutputTokens }) : {})
    }),
    signal
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `${providerName} API error: ${response.status}`);
  }

  if (!response.body) {
    throw new Error(`${providerName} response stream is unavailable`);
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

const callOllama = async (settings, messages, { onChunk, signal, maxOutputTokens }) => {
  const port = settings.ollamaPort || 11434;
  const response = await fetch(`http://localhost:${port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.ollamaModel,
      messages,
      stream: true,
      format: 'json',
      ...(maxOutputTokens ? { options: { num_predict: maxOutputTokens } } : {})
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

const callLLM = async (settings, { text, images, systemPrompt = TOC_SYSTEM_PROMPT, userPrompt }, { onChunk, signal, maxOutputTokens }) => {
  const isVision = images && images.length > 0;

  if (settings.llmProvider === 'openai' || settings.llmProvider === 'openai-compatible') {
    const isCompatible = settings.llmProvider === 'openai-compatible';
    if (!settings.openaiApiKey) {
      if (!isCompatible) {
        throw new Error('OpenAI API key not configured. Please set it in Settings.');
      }
    }
    if (isCompatible && !settings.openaiCompatibleUrl) {
      throw new Error('OpenAI-compatible URL not configured. Please set it in Settings.');
    }
    if (isCompatible && !settings.openaiCompatibleModel) {
      throw new Error('OpenAI-compatible model not configured. Please set it in Settings.');
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
      userContent = userPrompt ?? TOC_TEXT_PROMPT + text;
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ];

    const connection = isCompatible
      ? {
          url: openAICompatibleEndpoint(settings.openaiCompatibleUrl),
          apiKey: settings.openaiCompatibleApiKey,
          model: settings.openaiCompatibleModel,
          providerName: 'OpenAI-compatible'
        }
      : {
          url: 'https://api.openai.com/v1/chat/completions',
          apiKey: settings.openaiApiKey,
          model: settings.openaiModel,
          providerName: 'OpenAI'
        };

    return callOpenAIChatCompletions(connection, messages, { onChunk, signal, maxOutputTokens });

  } else if (settings.llmProvider === 'ollama') {
    let messages;
    if (isVision) {
      messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: TOC_VISION_PROMPT, images }
      ];
    } else {
      messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt ?? TOC_TEXT_PROMPT + text }
      ];
    }

    return callOllama(settings, messages, { onChunk, signal, maxOutputTokens });

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
        : importSettings.llmProvider === 'openai-compatible'
          ? `OpenAI compatible (${importSettings.openaiCompatibleModel})`
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
    const matchResults = await detectPdfHeadings(state.pdf, entries, { signal, log: appendLogLine });
    throwIfAborted(signal);
    if (document.getElementById('tocAiHeadingMatch').checked) {
      setStatus('Checking ambiguous heading candidates with AI...');
      await refineHeadingsWithAi(entries, matchResults, {
        signal,
        log: appendLogLine,
        request: async ({ text, systemPrompt, maxOutputTokens }) => {
          startWaitingDots();
          try {
            return await callLLM(importSettings, { systemPrompt, userPrompt: text }, { signal, maxOutputTokens });
          } finally {
            stopWaitingDots();
          }
        }
      });
    }
    throwIfAborted(signal);

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
