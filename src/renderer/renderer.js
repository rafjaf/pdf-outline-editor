/**
 * PDF Outline Editor - Renderer Main Entry Point
 * 
 * This module initializes the application and wires up all components.
 * The actual functionality is split across modular files for maintainability:
 * 
 * - state.js: Application state and selection helpers
 * - history.js: Undo/redo management
 * - outline-actions.js: Add, delete, move, adjust operations
 * - outline-renderer.js: Outline list rendering with drag/drop
 * - pdf-viewer.js: PDF rendering and navigation
 * - file-operations.js: Load/save operations
 * - context-menu.js: Right-click menu handling
 * - page-modal.js: Page number input modal
 * - keyboard.js: Keyboard shortcuts
 */

import { state, elements } from './state.js';
import { setRefreshCallback as setHistoryRefresh, undo, redo } from './history.js';
import { 
  setRefreshCallback as setActionsRefresh,
  addOutlineItem, 
  deleteOutlineItem, 
  adjustLevel, 
  moveItem, 
  startRename 
} from './outline-actions.js';
import { 
  setCallbacks as setOutlineCallbacks,
  refreshOutline, 
  handleOutlineDrop, 
  collapseAll, 
  expandAll 
} from './outline-renderer.js';
import { 
  renderPdf, 
  setPageIndicators, 
  scrollToPage, 
  fitToWidth, 
  handleZoomChange 
} from './pdf-viewer.js';
import { 
  loadPdfData, 
  handleFileDrop, 
  requestOpenPdf, 
  requestSavePdf, 
  requestSavePdfAs 
} from './file-operations.js';
import { openContextMenu, closeContextMenu, setupContextMenuHandlers } from './context-menu.js';
import { openPageModal, setupPageModalHandlers } from './page-modal.js';
import { setupKeyboardShortcuts } from './keyboard.js';

const { ipcRenderer } = require('electron');

// Action definitions for toolbar, context menu, and keyboard shortcuts
const outlineActions = {
  add: () => addOutlineItem({ asChild: false }),
  addChild: () => addOutlineItem({ asChild: true }),
  delete: () => deleteOutlineItem(),
  indent: () => adjustLevel(1),
  outdent: () => adjustLevel(-1),
  moveUp: () => moveItem(-1),
  moveDown: () => moveItem(1),
  rename: () => startRename(elements),
  setPage: () => openPageModal()
};

// Wire up refresh callbacks for modules that need to trigger UI updates
setHistoryRefresh(refreshOutline);
setActionsRefresh(refreshOutline);
setOutlineCallbacks({
  scrollToPage,
  openContextMenu,
  openPageModal
});

// ===== Toolbar Button Event Handlers =====

// Header actions
document.getElementById('openPdf').addEventListener('click', requestOpenPdf);
document.getElementById('savePdf').addEventListener('click', requestSavePdf);
document.getElementById('savePdfAs').addEventListener('click', requestSavePdfAs);

// Outline manipulation
document.getElementById('addTitle').addEventListener('click', outlineActions.add);
document.getElementById('addChild').addEventListener('click', outlineActions.addChild);
document.getElementById('renameTitle').addEventListener('click', outlineActions.rename);
document.getElementById('setPage').addEventListener('click', outlineActions.setPage);
document.getElementById('deleteTitle').addEventListener('click', outlineActions.delete);
document.getElementById('indentTitle').addEventListener('click', outlineActions.indent);
document.getElementById('outdentTitle').addEventListener('click', outlineActions.outdent);
document.getElementById('moveUp').addEventListener('click', outlineActions.moveUp);
document.getElementById('moveDown').addEventListener('click', outlineActions.moveDown);

// Expand/collapse and history
document.getElementById('expandAll').addEventListener('click', expandAll);
document.getElementById('collapseAll').addEventListener('click', collapseAll);
document.getElementById('undo').addEventListener('click', undo);
document.getElementById('redo').addEventListener('click', redo);

// Page navigation
document.getElementById('prevPage').addEventListener('click', () => 
  scrollToPage(Math.max(1, state.currentPage - 1))
);
document.getElementById('nextPage').addEventListener('click', () => 
  scrollToPage(Math.min(state.pdf?.numPages ?? 1, state.currentPage + 1))
);
document.getElementById('fitWidth').addEventListener('click', fitToWidth);

// Zoom control
document.getElementById('zoomSlider').addEventListener('input', (e) => 
  handleZoomChange(Number(e.target.value))
);

// ===== Outline List Drag/Drop Handlers =====

elements.outlineList.addEventListener('dragover', (e) => e.preventDefault());
elements.outlineList.addEventListener('dragleave', (event) => {
  if (!elements.outlineList.contains(event.relatedTarget)) {
    document.querySelectorAll('.drag-over-above, .drag-over-below').forEach(el => {
      el.classList.remove('drag-over-above', 'drag-over-below');
    });
  }
});
elements.outlineList.addEventListener('drop', handleOutlineDrop);

// ===== Viewer Drag/Drop for File Open =====

elements.viewer.addEventListener('dragover', (event) => {
  event.preventDefault();
  elements.dropZone.style.display = 'flex';
});
elements.viewer.addEventListener('dragleave', () => {
  if (!state.pdf) elements.dropZone.style.display = 'flex';
});
elements.viewer.addEventListener('drop', handleFileDrop);

// ===== Divider Resize Handler =====

const divider = document.getElementById('divider');
const outlinePane = document.getElementById('outlinePane');
let resizing = false;

divider.addEventListener('mousedown', () => {
  resizing = true;
  document.body.style.cursor = 'col-resize';
});

document.addEventListener('mouseup', () => {
  resizing = false;
  document.body.style.cursor = 'default';
});

document.addEventListener('mousemove', (event) => {
  if (!resizing) return;
  const newWidth = Math.min(Math.max(event.clientX, 220), 480);
  outlinePane.style.width = `${newWidth}px`;
  outlinePane.style.flex = '0 0 auto';
});

// ===== Setup Modular Components =====

setupContextMenuHandlers(outlineActions);
setupPageModalHandlers();
setupKeyboardShortcuts(outlineActions);

// ===== IPC Handlers =====

// Handle file opened from main process (CLI or drag on app icon)
ipcRenderer.on('open-file', async (event, { data, filePath, outline }) => {
  await loadPdfData({ data, filePath, outline });
});

// Handle save before quit request from main process
ipcRenderer.on('save-before-quit', async () => {
  await requestSavePdf();
  ipcRenderer.send('quit-app');
});

// Expose isDirty function for main process to check
window.isDirty = () => state.dirty;

// ===== Initialize =====

ipcRenderer.invoke('get-app-version').then((version) => {
  document.getElementById('appVersion').textContent = `v${version}`;
});

setPageIndicators();
refreshOutline();
