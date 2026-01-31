/**
 * Outline manipulation actions
 * Add, delete, move, adjust level operations
 */

import { 
  state, 
  hasSingleSelection, 
  hasSelection, 
  getFirstSelectedId, 
  getSelectedItems 
} from './state.js';
import { saveHistory } from './history.js';

// Callback to refresh UI after action - set by main module
let refreshCallback = null;
export const setRefreshCallback = (callback) => {
  refreshCallback = callback;
};

// Add a new outline item
export const addOutlineItem = ({ asChild }) => {
  if (!state.pdf) return;

  saveHistory(asChild ? 'Add nested title' : 'Add title');
  
  const firstId = getFirstSelectedId();
  const baseIndex = firstId ? state.outline.findIndex((item) => item.id === firstId) : -1;
  const insertIndex = baseIndex >= 0 ? baseIndex + 1 : state.outline.length;
  const baseLevel = baseIndex >= 0 ? state.outline[baseIndex].level : 0;
  const level = asChild ? Math.min(baseLevel + 1, 6) : baseLevel;

  const item = {
    id: crypto.randomUUID(),
    title: 'New Title',
    pageIndex: state.currentPage - 1,
    level
  };

  state.outline.splice(insertIndex, 0, item);
  state.selectedIds.clear();
  state.selectedIds.add(item.id);
  state.lastSelectedId = item.id;
  
  if (refreshCallback) refreshCallback();
};

// Delete selected outline items
export const deleteOutlineItem = () => {
  if (!hasSelection()) return;
  
  // Get indices of selected items (sorted in reverse order for safe deletion)
  const indices = getSelectedItems()
    .map(item => state.outline.findIndex(o => o.id === item.id))
    .filter(idx => idx >= 0)
    .sort((a, b) => b - a);
  
  if (indices.length === 0) return;
  
  saveHistory(indices.length > 1 ? 'Delete titles' : 'Delete title');
  
  // Delete from highest index first to maintain correct indices
  for (const index of indices) {
    state.outline.splice(index, 1);
  }
  
  // Select next available item
  const lowestDeletedIndex = Math.min(...indices);
  const newSelectedId = state.outline[lowestDeletedIndex]?.id ?? 
                        state.outline[lowestDeletedIndex - 1]?.id ?? null;
  state.selectedIds.clear();
  if (newSelectedId) {
    state.selectedIds.add(newSelectedId);
    state.lastSelectedId = newSelectedId;
  }
  
  if (refreshCallback) refreshCallback();
};

// Adjust indentation level of selected items
export const adjustLevel = (delta) => {
  if (!hasSelection()) return;
  const items = getSelectedItems();
  if (items.length === 0) return;
  
  saveHistory(delta > 0 ? 'Indent titles' : 'Outdent titles');
  
  for (const item of items) {
    const idx = state.outline.findIndex(o => o.id === item.id);
    let newLevel = Math.max(0, item.level + delta);
    
    // Ensure logical hierarchy: can't exceed previous item's level + 1
    if (idx > 0) {
      const prevItem = state.outline[idx - 1];
      newLevel = Math.min(newLevel, prevItem.level + 1);
    } else {
      // First item must be level 0
      newLevel = Math.min(newLevel, 0);
    }
    
    item.level = newLevel;
  }
  
  // After adjusting, fix any children that now violate hierarchy
  for (let i = 1; i < state.outline.length; i++) {
    const prevLevel = state.outline[i - 1].level;
    if (state.outline[i].level > prevLevel + 1) {
      state.outline[i].level = prevLevel + 1;
    }
  }
  
  if (refreshCallback) refreshCallback();
};

// Move selected item up or down
export const moveItem = (delta) => {
  // Move only works with single selection
  if (!hasSingleSelection()) return;
  
  const firstId = getFirstSelectedId();
  const index = state.outline.findIndex((item) => item.id === firstId);
  if (index < 0) return;
  
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= state.outline.length) return;
  
  saveHistory(delta < 0 ? 'Move title up' : 'Move title down');
  const [removed] = state.outline.splice(index, 1);
  state.outline.splice(nextIndex, 0, removed);
  
  if (refreshCallback) refreshCallback();
};

// Start inline rename of selected item
export const startRename = (elements) => {
  if (!hasSingleSelection()) return;
  const selectedId = getFirstSelectedId();
  const item = state.outline.find(entry => entry.id === selectedId);
  if (!item) return;
  
  const row = elements.outlineList.querySelector(`[data-id="${selectedId}"]`);
  if (!row) return;
  
  const title = row.querySelector('.outline-title');
  const input = document.createElement('input');
  input.value = item.title;
  input.className = 'outline-input';
  
  // Stop clicks inside input from triggering row click or blur
  input.addEventListener('click', (event) => {
    event.stopPropagation();
  });
  
  input.addEventListener('blur', () => {
    saveHistory('Rename title');
    item.title = input.value || 'Untitled';
    if (refreshCallback) refreshCallback();
  });
  
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      input.blur();
    } else if (event.key === 'Escape') {
      if (refreshCallback) refreshCallback();
    }
  });
  
  title.replaceWith(input);
  input.focus();
  input.select();
};

// Set target page for selected item
export const setPageForSelected = (pageNumber) => {
  if (!hasSingleSelection()) return;
  const firstId = getFirstSelectedId();
  const item = state.outline.find(entry => entry.id === firstId);
  if (!item) return;
  
  const maxPage = state.pdf?.numPages ?? 1;
  if (!isNaN(pageNumber) && pageNumber >= 1 && pageNumber <= maxPage) {
    saveHistory('Set target page');
    item.pageIndex = pageNumber - 1;
    if (refreshCallback) refreshCallback();
  }
};
