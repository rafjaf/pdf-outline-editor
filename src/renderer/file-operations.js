/**
 * File operations - load, save, and handle file dialogs
 */

import { state, updateFileName, updateDirtyState, elements, setToolbarEnabled } from './state.js';
import { updateUndoRedoButtons } from './history.js';
import { refreshOutline } from './outline-renderer.js';
import { ensurePdfJsLoaded, getPdfjsLib, renderPdf, setPageIndicators } from './pdf-viewer.js';

const { ipcRenderer } = require('electron');

// Show error dialog to user
const showError = (title, message) => {
  console.error(`${title}: ${message}`);
  // Could use ipcRenderer to show a native dialog, but console is simpler
  alert(`${title}\n\n${message}`);
};

// Load PDF data into the application
export const loadPdfData = async ({ data, filePath, outline = [] }) => {
  try {
    await ensurePdfJsLoaded();
    const pdfjsLib = getPdfjsLib();
    
    state.filePath = filePath;
    state.pdfData = data;
    state.pdf = await pdfjsLib.getDocument({ data }).promise;
    state.outline = outline.map((item) => ({
      id: item.id ?? crypto.randomUUID(),
      title: item.title ?? 'Untitled',
      pageIndex: item.pageIndex ?? 0,
      level: item.level ?? 0
    }));
    state.currentPage = 1;
    state.history = [{ snapshot: JSON.parse(JSON.stringify(state.outline)), actionName: 'Open file' }];
    state.historyIndex = 0;
    state.savedHistoryIndex = 0;
    state.selectedIds.clear();
    state.lastSelectedId = null;
    state.collapsedNodes.clear();
    
    setPageIndicators();
    updateUndoRedoButtons();
    updateFileName();
    setToolbarEnabled(true);
    elements.dropZone.style.display = 'none';
    
    // Refresh outline BEFORE rendering PDF pages so it shows immediately
    refreshOutline();
    
    // Allow the browser to paint the outline before starting heavy PDF rendering
    await new Promise(resolve => requestAnimationFrame(resolve));
    
    await renderPdf();
  } catch (error) {
    showError('Failed to load PDF', error.message);
  }
};

// Handle file dropped on the application
export const handleFileDrop = async (event) => {
  event.preventDefault();
  const file = event.dataTransfer.files[0];
  if (!file) return;
  
  try {
    const data = await file.arrayBuffer();
    await loadPdfData({ data, filePath: file.path, outline: [] });
  } catch (error) {
    showError('Failed to open file', error.message);
  }
};

// Request to open a PDF via dialog
export const requestOpenPdf = async () => {
  try {
    const result = await ipcRenderer.invoke('open-pdf-dialog');
    if (!result) return;
    await loadPdfData({
      data: result.data,
      filePath: result.filePath,
      outline: result.outline
    });
  } catch (error) {
    showError('Failed to open PDF', error.message);
  }
};

// Request to save the current PDF
export const requestSavePdf = async () => {
  if (!state.pdfData || !state.filePath) return;
  
  try {
    await ipcRenderer.invoke('save-pdf', {
      sourcePath: state.filePath,
      outline: state.outline
    });
    
    state.savedHistoryIndex = state.historyIndex;
    updateDirtyState();
    updateFileName();
  } catch (error) {
    showError('Failed to save PDF', error.message);
  }
};

// Request to save the PDF with a new name
export const requestSavePdfAs = async () => {
  if (!state.pdfData) return;
  
  try {
    const result = await ipcRenderer.invoke('save-pdf-as', {
      sourcePath: state.filePath,
      outline: state.outline
    });
    
    if (result && result.filePath) {
      state.filePath = result.filePath;
      state.savedHistoryIndex = state.historyIndex;
      updateDirtyState();
      updateFileName();
    }
  } catch (error) {
    showError('Failed to save PDF', error.message);
  }
};
