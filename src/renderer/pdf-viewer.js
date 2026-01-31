/**
 * PDF viewer rendering and navigation
 */

import { state, elements } from './state.js';

const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');

let pdfjsLib = null;
let pdfjsReady = null;

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

// Render PDF pages to canvas
export const renderPdf = async () => {
  if (!state.pdf) return;

  elements.viewer.innerHTML = '';
  const pageCount = state.pdf.numPages;
  elements.totalPages.textContent = pageCount;

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const page = await state.pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: state.zoom });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page';
    wrapper.dataset.pageNumber = pageNumber.toString();

    wrapper.appendChild(canvas);
    elements.viewer.appendChild(wrapper);

    await page.render({ canvasContext: context, viewport }).promise;
  }

  observePages();
};

// Observe pages for current page tracking
const observePages = () => {
  const pageElements = Array.from(elements.viewer.querySelectorAll('.pdf-page'));
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
      }
    },
    { root: elements.viewer, threshold: 0.4 }
  );

  pageElements.forEach((element) => observer.observe(element));
};

// Update page indicators in toolbar
export const setPageIndicators = () => {
  elements.currentPage.textContent = state.currentPage;
  elements.totalPages.textContent = state.pdf ? state.pdf.numPages : 1;
};

// Scroll to a specific page
export const scrollToPage = (pageNumber) => {
  const page = elements.viewer.querySelector(`[data-page-number="${pageNumber}"]`);
  if (page) {
    const distance = Math.abs(pageNumber - state.currentPage);
    const behavior = distance > 10 ? 'instant' : 'smooth';
    page.scrollIntoView({ behavior, block: 'start' });
  }
};

// Fit PDF to viewer width
export const fitToWidth = async () => {
  if (!state.pdf) return;
  
  const page = await state.pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const viewerWidth = elements.viewer.clientWidth - 40;
  const optimalZoom = viewerWidth / viewport.width;
  
  state.zoom = optimalZoom;
  const zoomSlider = document.getElementById('zoomSlider');
  zoomSlider.value = Math.round(optimalZoom * 100);
  
  await renderPdf();
};

// Handle zoom slider change
export const handleZoomChange = async (value) => {
  state.zoom = value / 100;
  await renderPdf();
};
