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
  const selectedIds = new Set(getSelectedItems().map(item => item.id));
  if (selectedIds.size === 0) return;
  
  saveHistory(delta > 0 ? 'Indent titles' : 'Outdent titles');

  const selectedIndices = state.outline
    .map((item, idx) => (selectedIds.has(item.id) ? idx : -1))
    .filter(idx => idx >= 0)
    .sort((a, b) => a - b);

  const rootIndices = selectedIndices.filter((idx) => {
    const currentLevel = state.outline[idx].level;
    for (let i = idx - 1; i >= 0; i--) {
      if (state.outline[i].level < currentLevel) {
        return !selectedIds.has(state.outline[i].id);
      }
    }
    return true;
  });

  for (const rootIdx of rootIndices) {
    const rootItem = state.outline[rootIdx];
    const rootOriginalLevel = rootItem.level;

    let rootNewLevel = Math.max(0, rootOriginalLevel + delta);

    if (rootIdx > 0) {
      const prevItem = state.outline[rootIdx - 1];
      rootNewLevel = Math.min(rootNewLevel, prevItem.level + 1);
    } else {
      rootNewLevel = 0;
    }

    const appliedDelta = rootNewLevel - rootOriginalLevel;
    if (appliedDelta === 0) continue;

    let endIdx = rootIdx;
    for (let i = rootIdx + 1; i < state.outline.length; i++) {
      if (state.outline[i].level <= rootOriginalLevel) break;
      endIdx = i;
    }

    for (let i = rootIdx; i <= endIdx; i++) {
      state.outline[i].level = Math.max(0, state.outline[i].level + appliedDelta);
    }
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
    delete item.unverified;
    delete item.uncertain;
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
    saveHistory('Edit target page');
    item.pageIndex = pageNumber - 1;
    delete item.unverified;
    delete item.uncertain;
    if (refreshCallback) refreshCallback();
  }
};
