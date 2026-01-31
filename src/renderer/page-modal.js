/**
 * Page number modal handling
 */

import { state, hasSingleSelection, getFirstSelectedId } from './state.js';
import { setPageForSelected } from './outline-actions.js';

// Open the page number modal
export const openPageModal = () => {
  if (!hasSingleSelection()) return;
  const firstId = getFirstSelectedId();
  const item = state.outline.find(entry => entry.id === firstId);
  if (!item) return;
  
  const modal = document.getElementById('pageModal');
  const input = document.getElementById('pageInput');
  input.value = item.pageIndex + 1;
  input.max = state.pdf?.numPages ?? 1;
  modal.style.display = 'flex';
  input.focus();
  input.select();
};

// Close the page number modal
export const closePageModal = () => {
  document.getElementById('pageModal').style.display = 'none';
};

// Confirm and apply the page number
export const confirmPageModal = () => {
  if (!hasSingleSelection()) return;
  
  const input = document.getElementById('pageInput');
  const pageNumber = parseInt(input.value, 10);
  setPageForSelected(pageNumber);
  closePageModal();
};

// Setup modal event handlers
export const setupPageModalHandlers = () => {
  document.getElementById('pageModalCancel').addEventListener('click', closePageModal);
  document.getElementById('pageModalOk').addEventListener('click', confirmPageModal);
  
  document.getElementById('pageInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      confirmPageModal();
    } else if (event.key === 'Escape') {
      closePageModal();
    }
  });
  
  document.getElementById('pageModal').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      closePageModal();
    }
  });
};
