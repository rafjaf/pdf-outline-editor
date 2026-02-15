/**
 * PDF viewer rendering and navigation
 */

import { state, elements } from './state.js';

const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');

let pdfjsLib = null;
let pdfjsReady = null;
let renderSequence = 0;
let activeObserver = null;
let renderedPages = new Set();
let queuedPages = new Set();
let renderQueue = [];
let renderWorkerRunning = false;
let scrollPauseTimer = null;

// Get the correct path to node_modules, handling both dev and production
const getNodeModulesPath = () => {
  const devPath = path.join(__dirname, '../../node_modules');
  const prodPath = path.join(__dirname, '../../app.asar.unpacked/node_modules');
  const asarPath = path.join(process.resourcesPath || '', 'app.asar.unpacked/node_modules');
  
  if (fs.existsSync(asarPath)) return asarPath;
  if (fs.existsSync(prodPath)) return prodPath;
  return devPath;
};

// Ensure PDF.js is loaded (lazy loading)
export const ensurePdfJsLoaded = async () => {
  if (!pdfjsReady) {
    pdfjsReady = (async () => {
      try {
        const nodeModulesPath = getNodeModulesPath();
        const pdfModulePath = path.join(nodeModulesPath, 'pdfjs-dist/legacy/build/pdf.mjs');
        const pdfModuleUrl = pathToFileURL(pdfModulePath).toString();
        console.log('[PDF.js] Loading from:', pdfModuleUrl);
        
        pdfjsLib = await import(pdfModuleUrl);
        pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
          path.join(nodeModulesPath, 'pdfjs-dist/legacy/build/pdf.worker.mjs')
        ).toString();
        
        console.log('[PDF.js] Loaded successfully');
      } catch (error) {
        console.error('[PDF.js] Failed to load:', error);
        throw error;
      }
    })();
  }

  return pdfjsReady;
};

// Get the loaded PDF.js library
export const getPdfjsLib = () => pdfjsLib;

const queuePage = (pageNumber, { front = false } = {}) => {
  if (renderedPages.has(pageNumber) || queuedPages.has(pageNumber)) return;
  queuedPages.add(pageNumber);
  if (front) {
    renderQueue.unshift(pageNumber);
  } else {
    renderQueue.push(pageNumber);
  }
};

const prioritizePage = (pageNumber) => {
  if (renderedPages.has(pageNumber)) return;

  if (queuedPages.has(pageNumber)) {
    renderQueue = renderQueue.filter((num) => num !== pageNumber);
    renderQueue.unshift(pageNumber);
    return;
  }

  queuedPages.add(pageNumber);
  renderQueue.unshift(pageNumber);
};

const renderSinglePage = async (sessionId, pageNumber) => {
  if (!state.pdf || sessionId !== renderSequence) return;

  const wrapper = elements.viewer.querySelector(`[data-page-number="${pageNumber}"]`);
  if (!wrapper) return;

  const page = await state.pdf.getPage(pageNumber);
  if (sessionId !== renderSequence) return;

  const viewport = page.getViewport({ scale: state.zoom });
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  await page.render({ canvasContext: context, viewport }).promise;
  if (sessionId !== renderSequence) return;

  wrapper.innerHTML = '';
  wrapper.style.minHeight = '';
  wrapper.appendChild(canvas);
  wrapper.classList.remove('pdf-page-loading');
  renderedPages.add(pageNumber);
};

const startRenderWorker = async (sessionId) => {
  if (renderWorkerRunning) return;
  renderWorkerRunning = true;

  try {
    while (sessionId === renderSequence && renderQueue.length > 0) {
      const pageNumber = renderQueue.shift();
      if (pageNumber == null) continue;

      queuedPages.delete(pageNumber);
      if (renderedPages.has(pageNumber)) continue;

      await renderSinglePage(sessionId, pageNumber);
    }
  } finally {
    renderWorkerRunning = false;
    if (sessionId === renderSequence && renderQueue.length > 0) {
      startRenderWorker(sessionId);
    }
  }
};

// Render PDF pages to canvas
export const renderPdf = async ({ preserveCurrentPage = false } = {}) => {
  if (!state.pdf) return;

  const renderId = ++renderSequence;
  const pageCount = state.pdf.numPages;
  const targetPage = preserveCurrentPage
    ? Math.max(1, Math.min(pageCount, getVisibleOrCurrentPage()))
    : 1;

  if (activeObserver) {
    activeObserver.disconnect();
    activeObserver = null;
  }

  renderedPages = new Set();
  queuedPages = new Set();
  renderQueue = [];
  renderWorkerRunning = false;

  if (scrollPauseTimer) {
    clearTimeout(scrollPauseTimer);
    scrollPauseTimer = null;
  }

  elements.viewer.innerHTML = '';
  elements.totalPages.textContent = pageCount;

  const firstPage = await state.pdf.getPage(1);
  if (renderId !== renderSequence) return;
  const firstViewport = firstPage.getViewport({ scale: state.zoom });

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page pdf-page-loading';
    wrapper.dataset.pageNumber = pageNumber.toString();
    wrapper.style.minHeight = `${Math.ceil(firstViewport.height) + 24}px`;

    const placeholder = document.createElement('div');
    placeholder.className = 'pdf-page-placeholder';
    placeholder.textContent = `Page ${pageNumber} currently loading`;
    wrapper.appendChild(placeholder);

    elements.viewer.appendChild(wrapper);
  }

  if (renderId !== renderSequence) return;

  observePages();

  elements.viewer.onscroll = () => {
    if (scrollPauseTimer) clearTimeout(scrollPauseTimer);
    scrollPauseTimer = setTimeout(() => {
      const visiblePages = getVisiblePageNumbers();
      visiblePages.forEach((pageNum) => prioritizePage(pageNum));
      startRenderWorker(renderId);
    }, 120);
  };

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    queuePage(pageNumber);
  }

  getVisiblePageNumbers().forEach((pageNum) => prioritizePage(pageNum));
  startRenderWorker(renderId);

  if (preserveCurrentPage) {
    scrollToPage(targetPage, 'auto');
  }
};

const getVisiblePageNumbers = () => {
  const viewerRect = elements.viewer.getBoundingClientRect();
  const pageElements = Array.from(elements.viewer.querySelectorAll('.pdf-page'));

  return pageElements
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > viewerRect.top && rect.top < viewerRect.bottom;
    })
    .map((element) => Number(element.dataset.pageNumber || 1));
};

const getVisibleOrCurrentPage = () => {
  const viewerRect = elements.viewer.getBoundingClientRect();
  const pages = Array.from(elements.viewer.querySelectorAll('.pdf-page'));
  if (pages.length === 0) return state.currentPage;

  let bestPage = state.currentPage;
  let bestDistance = Number.POSITIVE_INFINITY;

  pages.forEach((element) => {
    const rect = element.getBoundingClientRect();
    const distance = Math.abs(rect.top - viewerRect.top);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPage = Number(element.dataset.pageNumber || state.currentPage);
    }
  });

  return bestPage;
};

// Observe pages for current page tracking
const observePages = () => {
  const pageElements = Array.from(elements.viewer.querySelectorAll('.pdf-page'));
  if (activeObserver) {
    activeObserver.disconnect();
  }

  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting);
      if (visible.length > 0) {
        const top = visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const pageNumber = Number(top.target.dataset.pageNumber || 1);
        if (state.currentPage !== pageNumber) {
          state.currentPage = pageNumber;
          setPageIndicators();
        }

        prioritizePage(pageNumber);
        startRenderWorker(renderSequence);
      }
    },
    { root: elements.viewer, threshold: 0.1 }
  );

  pageElements.forEach((element) => observer.observe(element));
  activeObserver = observer;
};

// Update page indicators in toolbar
export const setPageIndicators = () => {
  elements.currentPageInput.value = String(state.currentPage);
  elements.totalPages.textContent = state.pdf ? state.pdf.numPages : 1;
};

// Scroll to a specific page
export const scrollToPage = (pageNumber, preferredBehavior = null) => {
  if (!state.pdf) return;

  const clampedPage = Math.max(1, Math.min(state.pdf.numPages, pageNumber));
  const page = elements.viewer.querySelector(`[data-page-number="${clampedPage}"]`);
  if (page) {
    const distance = Math.abs(clampedPage - state.currentPage);
    const behavior = preferredBehavior ?? (distance > 10 ? 'auto' : 'smooth');
    page.scrollIntoView({ behavior, block: 'start' });
    state.currentPage = clampedPage;
    setPageIndicators();
    prioritizePage(clampedPage);
    startRenderWorker(renderSequence);
  }
};

// Fit PDF to viewer width
export const fitToWidth = async () => {
  if (!state.pdf) return;

  const currentPage = Math.max(1, Math.min(state.pdf.numPages, getVisibleOrCurrentPage()));
  const page = await state.pdf.getPage(currentPage);
  const viewport = page.getViewport({ scale: 1 });
  const viewerWidth = elements.viewer.clientWidth - 40;
  const optimalZoom = viewerWidth / viewport.width;
  
  state.zoom = optimalZoom;
  const zoomSlider = document.getElementById('zoomSlider');
  zoomSlider.value = Math.round(optimalZoom * 100);

  await renderPdf({ preserveCurrentPage: true });
};

// Handle zoom slider change
export const handleZoomChange = async (value) => {
  state.zoom = value / 100;
  await renderPdf({ preserveCurrentPage: true });
};
