/**
 * Keyboard shortcuts handling
 */

import { 
  state, 
  elements, 
  shouldHideItem, 
  hasSingleSelection, 
  hasSelection, 
  getFirstSelectedId, 
  findParentIndex 
} from './state.js';
import { undo, redo } from './history.js';
import { startRename } from './outline-actions.js';
import { scrollToPage } from './pdf-viewer.js';
import { refreshOutline } from './outline-renderer.js';
import { requestOpenPdf, requestSavePdf, requestSavePdfAs } from './file-operations.js';

// Keyboard navigation helper
const navigateSelection = (delta, extendSelection = false) => {
  if (state.outline.length === 0) return;
  
  const anchorId = state.lastSelectedId || getFirstSelectedId();
  const currentIndex = anchorId ? state.outline.findIndex(i => i.id === anchorId) : -1;
  let newIndex;
  
  if (currentIndex < 0) {
    newIndex = delta > 0 ? 0 : state.outline.length - 1;
  } else {
    newIndex = Math.max(0, Math.min(state.outline.length - 1, currentIndex + delta));
  }
  
  // Skip collapsed items
  const isVisible = (idx) => !shouldHideItem(state.outline[idx], idx);
  while (newIndex >= 0 && newIndex < state.outline.length && !isVisible(newIndex)) {
    newIndex += delta;
  }
  
  if (newIndex >= 0 && newIndex < state.outline.length) {
    if (extendSelection) {
      state.selectedIds.add(state.outline[newIndex].id);
    } else {
      state.selectedIds.clear();
      state.selectedIds.add(state.outline[newIndex].id);
    }
    state.lastSelectedId = state.outline[newIndex].id;
    refreshOutline();
    scrollToPage(state.outline[newIndex].pageIndex + 1);
  }
};

// Setup keyboard shortcuts
export const setupKeyboardShortcuts = (outlineActions) => {
  document.addEventListener('keydown', (event) => {
    // Don't handle shortcuts when in input elements
    const tagName = event.target.tagName.toLowerCase();
    if (tagName === 'input' || tagName === 'textarea') return;
    
    const isMeta = event.metaKey || event.ctrlKey;
    const isShift = event.shiftKey;
    
    // File operations
    if (isMeta && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      requestOpenPdf();
      return;
    }
    if (isMeta && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (isShift) {
        requestSavePdfAs();
      } else {
        requestSavePdf();
      }
      return;
    }
    
    // Undo/Redo
    if (isMeta && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (isShift) {
        redo();
      } else {
        undo();
      }
      return;
    }
    if (isMeta && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
      return;
    }
    
    // Add title
    if (isMeta && (event.key === 't' || event.key === 'T')) {
      event.preventDefault();
      if (isShift) {
        outlineActions.addChild();
      } else {
        outlineActions.add();
      }
      return;
    }
    
    // Arrow key navigation
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (isMeta) {
        outlineActions.moveUp();
      } else {
        navigateSelection(-1, isShift);
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (isMeta) {
        outlineActions.moveDown();
      } else {
        navigateSelection(1, isShift);
      }
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (isMeta) {
        outlineActions.outdent();
      } else if (hasSingleSelection()) {
        const firstId = getFirstSelectedId();
        const idx = state.outline.findIndex(i => i.id === firstId);
        const item = state.outline[idx];
        const hasChildren = idx < state.outline.length - 1 && state.outline[idx + 1].level > item.level;
        
        if (hasChildren && !state.collapsedNodes.has(firstId)) {
          state.collapsedNodes.add(firstId);
          refreshOutline();
        } else {
          const parentIdx = findParentIndex(idx);
          if (parentIdx >= 0) {
            const parentId = state.outline[parentIdx].id;
            state.collapsedNodes.add(parentId);
            state.selectedIds.clear();
            state.selectedIds.add(parentId);
            state.lastSelectedId = parentId;
            refreshOutline();
          }
        }
      }
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (isMeta) {
        outlineActions.indent();
      } else if (hasSingleSelection()) {
        const firstId = getFirstSelectedId();
        if (state.collapsedNodes.has(firstId)) {
          state.collapsedNodes.delete(firstId);
          refreshOutline();
        }
      }
      return;
    }
    
    // Rename
    if (event.key === 'F2' || event.key === 'Enter') {
      if (hasSingleSelection()) {
        event.preventDefault();
        startRename(elements);
      }
      return;
    }
    
    // Delete
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (hasSelection() && !isMeta) {
        event.preventDefault();
        outlineActions.delete();
      }
      return;
    }
    
    // Select all
    if (isMeta && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      state.outline.forEach(item => state.selectedIds.add(item.id));
      refreshOutline();
      return;
    }
  });
};
