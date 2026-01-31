/**
 * History management for undo/redo functionality
 */

import { state, elements, updateDirtyState } from './state.js';

const MAX_HISTORY = 10;

// Callback to refresh UI after history change - set by main module
let refreshCallback = null;
export const setRefreshCallback = (callback) => {
  refreshCallback = callback;
};

// Update undo/redo button states and tooltips
export const updateUndoRedoButtons = () => {
  const canUndo = state.historyIndex > 0;
  const canRedo = state.historyIndex < state.history.length - 1;
  
  if (elements.undoBtn) {
    elements.undoBtn.disabled = !canUndo;
    if (canUndo) {
      const actionName = state.history[state.historyIndex].actionName;
      elements.undoBtn.title = `Undo: ${actionName} (⌘Z)`;
    } else {
      elements.undoBtn.title = 'Nothing to undo (⌘Z)';
    }
  }
  
  if (elements.redoBtn) {
    elements.redoBtn.disabled = !canRedo;
    if (canRedo) {
      const actionName = state.history[state.historyIndex + 1].actionName;
      elements.redoBtn.title = `Redo: ${actionName} (⌘Y)`;
    } else {
      elements.redoBtn.title = 'Nothing to redo (⌘Y)';
    }
  }
};

// Save current outline state to history
export const saveHistory = (actionName = 'change') => {
  const snapshot = JSON.parse(JSON.stringify(state.outline));
  
  // Truncate any redo history
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push({ snapshot, actionName });
  state.historyIndex++;
  
  // Keep only MAX_HISTORY steps
  while (state.history.length > MAX_HISTORY + 1) {
    state.history.shift();
    state.historyIndex--;
    // Adjust saved index too
    if (state.savedHistoryIndex > 0) state.savedHistoryIndex--;
  }
  
  updateUndoRedoButtons();
  updateDirtyState();
};

// Undo last action
export const undo = () => {
  if (state.historyIndex > 0) {
    state.historyIndex--;
    state.outline = JSON.parse(JSON.stringify(state.history[state.historyIndex].snapshot));
    if (refreshCallback) refreshCallback();
    updateUndoRedoButtons();
    updateDirtyState();
  }
};

// Redo previously undone action
export const redo = () => {
  if (state.historyIndex < state.history.length - 1) {
    state.historyIndex++;
    state.outline = JSON.parse(JSON.stringify(state.history[state.historyIndex].snapshot));
    if (refreshCallback) refreshCallback();
    updateUndoRedoButtons();
    updateDirtyState();
  }
};
