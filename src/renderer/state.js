/**
 * Application state management
 * Central state object and selection helpers
 */

// Global application state
export const state = {
  pdf: null,
  pdfData: null,
  outline: [],
  selectedIds: new Set(),  // Multi-select support
  lastSelectedId: null,    // For SHIFT+click range selection
  currentPage: 1,
  zoom: 1.1,
  filePath: null,
  history: [],
  historyIndex: -1,
  collapsedNodes: new Set(),
  lastActionName: null,
  dirty: false,            // Track if document is modified
  savedHistoryIndex: 0     // Track the history index when last saved
};

// Cached DOM elements for performance
export const elements = {
  viewer: document.getElementById('viewer'),
  outlineList: document.getElementById('outlineList'),
  dropZone: document.getElementById('dropZone'),
  contextMenu: document.getElementById('contextMenu'),
  currentPage: document.getElementById('currentPage'),
  totalPages: document.getElementById('totalPages'),
  undoBtn: document.getElementById('undo'),
  redoBtn: document.getElementById('redo'),
  fileName: document.getElementById('fileName')
};

// Selection helpers
export const hasSingleSelection = () => state.selectedIds.size === 1;
export const hasSelection = () => state.selectedIds.size > 0;
export const getFirstSelectedId = () => state.selectedIds.values().next().value;
export const getSelectedItems = () => state.outline.filter(item => state.selectedIds.has(item.id));

// Update dirty state based on history position
export const updateDirtyState = () => {
  state.dirty = state.historyIndex !== state.savedHistoryIndex;
  if (elements.fileName) {
    elements.fileName.classList.toggle('dirty', state.dirty);
  }
};

// Update filename display in header
export const updateFileName = () => {
  if (elements.fileName && state.filePath) {
    const path = require('path');
    elements.fileName.textContent = path.basename(state.filePath);
  } else if (elements.fileName) {
    elements.fileName.textContent = '';
  }
  updateDirtyState();
};

// Check if an item should be hidden (any ancestor is collapsed)
export const shouldHideItem = (item, index) => {
  let currentLevel = item.level;
  
  // Walk backwards looking for ancestors (items with lower level)
  for (let i = index - 1; i >= 0 && currentLevel > 0; i--) {
    const potentialAncestor = state.outline[i];
    
    // Found an ancestor (lower level = higher in hierarchy)
    if (potentialAncestor.level < currentLevel) {
      if (state.collapsedNodes.has(potentialAncestor.id)) {
        return true;
      }
      // Continue checking higher ancestors
      currentLevel = potentialAncestor.level;
    }
  }
  return false;
};

// Find parent index of an item in the outline
export const findParentIndex = (itemIndex) => {
  if (itemIndex <= 0) return -1;
  const item = state.outline[itemIndex];
  for (let i = itemIndex - 1; i >= 0; i--) {
    if (state.outline[i].level < item.level) {
      return i;
    }
  }
  return -1;
};
