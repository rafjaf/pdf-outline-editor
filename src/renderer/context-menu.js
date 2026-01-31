/**
 * Context menu handling
 */

import { elements } from './state.js';

// Open context menu at position
export const openContextMenu = (x, y) => {
  elements.contextMenu.style.display = 'flex';
  elements.contextMenu.style.left = `${x}px`;
  elements.contextMenu.style.top = `${y}px`;
  
  // Adjust if it would overflow the bottom
  const menuRect = elements.contextMenu.getBoundingClientRect();
  const windowHeight = window.innerHeight;
  if (menuRect.bottom > windowHeight) {
    const adjustedY = windowHeight - menuRect.height - 8;
    elements.contextMenu.style.top = `${Math.max(8, adjustedY)}px`;
  }
  
  // Adjust if it would overflow the right
  const windowWidth = window.innerWidth;
  if (menuRect.right > windowWidth) {
    const adjustedX = windowWidth - menuRect.width - 8;
    elements.contextMenu.style.left = `${Math.max(8, adjustedX)}px`;
  }
};

// Close context menu
export const closeContextMenu = () => {
  elements.contextMenu.style.display = 'none';
};

// Setup context menu event handlers
export const setupContextMenuHandlers = (outlineActions) => {
  document.addEventListener('click', () => closeContextMenu());
  
  elements.contextMenu.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    
    if (button.disabled || button.classList.contains('disabled')) {
      event.stopPropagation();
      return;
    }
    
    const action = button.dataset.action;
    if (action && outlineActions[action]) {
      outlineActions[action]();
    }
    closeContextMenu();
  });
};
