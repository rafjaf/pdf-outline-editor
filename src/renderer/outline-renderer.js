/**
 * Outline list rendering with drag and drop support
 */

import { 
  state, 
  elements, 
  shouldHideItem, 
  hasSingleSelection, 
  hasSelection, 
  getSelectedItems 
} from './state.js';
import { saveHistory } from './history.js';
import { startRename } from './outline-actions.js';

// Callbacks set by main module
let scrollToPageCallback = null;
let openContextMenuCallback = null;
let openPageModalCallback = null;

export const setCallbacks = ({ scrollToPage, openContextMenu, openPageModal }) => {
  scrollToPageCallback = scrollToPage;
  openContextMenuCallback = openContextMenu;
  openPageModalCallback = openPageModal;
};

// Update toolbar and context menu button states
export const updateButtonStates = () => {
  if (!state.pdf) {
    const buttonIds = [
      'addTitle', 'addChild', 'renameTitle', 'setPage', 'deleteTitle',
      'indentTitle', 'outdentTitle', 'moveUp', 'moveDown', 'expandAll',
      'collapseAll', 'undo', 'redo', 'importToc', 'prevPage', 'nextPage',
      'fitWidth', 'zoomSlider', 'currentPageInput'
    ];
    buttonIds.forEach((id) => {
      const control = document.getElementById(id);
      if (control) control.disabled = true;
    });
  }

  const single = hasSingleSelection();
  const any = hasSelection();
  
  // Buttons that require single selection
  const singleOnlyButtons = ['renameTitle', 'setPage', 'moveUp', 'moveDown'];
  singleOnlyButtons.forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !single;
  });
  
  // Buttons that require any selection
  const anySelectionButtons = ['deleteTitle', 'indentTitle', 'outdentTitle'];
  anySelectionButtons.forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !any;
  });
  
  // Update context menu items
  const contextActions = {
    rename: single,
    setPage: single,
    moveUp: single,
    moveDown: single,
    delete: any,
    indent: any,
    outdent: any,
    add: true,
    addChild: true
  };
  
  Object.entries(contextActions).forEach(([action, enabled]) => {
    const menuItem = elements.contextMenu.querySelector(`[data-action="${action}"]`);
    if (menuItem) {
      menuItem.disabled = !enabled;
      menuItem.classList.toggle('disabled', !enabled);
    }
  });
};

// Render the outline list
export const refreshOutline = () => {
  elements.outlineList.innerHTML = '';

  if (state.outline.length === 0) {
    elements.outlineList.innerHTML = '<div class="empty-state">No outline yet. Add a title to begin.</div>';
    return;
  }

  // Pre-compute visibility and tree structure data for O(n) performance
  const treeData = precomputeTreeData(state.outline);
  
  // Use DocumentFragment for batched DOM operations (better performance for large outlines)
  const fragment = document.createDocumentFragment();

  state.outline.forEach((item, index) => {
    const data = treeData[index];
    if (data.isHidden) return;

    const row = document.createElement('div');
    row.className = `outline-item ${state.selectedIds.has(item.id) ? 'active' : ''}`;
    row.draggable = true;
    row.dataset.id = item.id;
    row.dataset.index = index;

    // Create tree indentation with lines
    if (item.level > 0) {
      const treeIndent = document.createElement('div');
      treeIndent.className = 'tree-indent';
      
      for (let lvl = 0; lvl < item.level; lvl++) {
        const segment = document.createElement('div');
        segment.className = 'tree-segment';
        
        if (lvl === item.level - 1) {
          segment.classList.add('connector');
          if (!data.isLastChild) segment.classList.add('continue');
        } else if (data.ancestorLines.has(lvl)) {
          segment.classList.add('has-line');
        }
        
        treeIndent.appendChild(segment);
      }
      row.appendChild(treeIndent);
    }

    // Toggle button (expand/collapse or bullet)
    const toggle = document.createElement('span');
    toggle.className = 'outline-toggle';
    toggle.textContent = data.hasChildren ? (data.isCollapsed ? '▶' : '▼') : '•';
    if (data.hasChildren) {
      toggle.style.cursor = 'pointer';
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (data.isCollapsed) {
          state.collapsedNodes.delete(item.id);
        } else {
          state.collapsedNodes.add(item.id);
        }
        refreshOutline();
      });
    }

    // Title text
    const title = document.createElement('span');
    title.className = 'outline-title' + (item.unverified ? ' unverified' : item.uncertain ? ' uncertain' : '');
    title.textContent = item.title;
    title.style.flex = '1';

    row.append(toggle, title);
    fragment.append(row);

    // Event handlers
    attachRowEventHandlers(row, item, index);
  });

  elements.outlineList.appendChild(fragment);
  updateButtonStates();
};

// Pre-compute tree structure data in a single O(n) pass
const precomputeTreeData = (outline) => {
  const data = new Array(outline.length);
  
  // First pass: compute basic properties
  for (let i = 0; i < outline.length; i++) {
    const item = outline[i];
    const hasChildren = i < outline.length - 1 && outline[i + 1].level > item.level;
    const isCollapsed = state.collapsedNodes.has(item.id);
    const isHidden = shouldHideItem(item, i);
    
    data[i] = {
      hasChildren,
      isCollapsed,
      isHidden,
      isLastChild: true,
      ancestorLines: new Set()
    };
  }
  
  // Second pass: compute isLastChild and ancestorLines
  // Track the last item seen at each level
  const lastAtLevel = new Map();
  
  for (let i = outline.length - 1; i >= 0; i--) {
    const item = outline[i];
    const level = item.level;
    
    // If there's a same-level item after this one (before in reverse), this isn't the last
    if (lastAtLevel.has(level)) {
      data[i].isLastChild = false;
    }
    
    // Update ancestor lines for items before this
    lastAtLevel.set(level, i);
    
    // Clear all higher levels (they can't have continuations past this point)
    for (const [lvl] of lastAtLevel) {
      if (lvl > level) lastAtLevel.delete(lvl);
    }
  }
  
  // Third pass: compute ancestor lines (which levels need vertical lines)
  for (let i = 0; i < outline.length; i++) {
    const item = outline[i];
    for (let level = 0; level < item.level; level++) {
      // Check if there's a same-level sibling after this item
      for (let j = i + 1; j < outline.length; j++) {
        if (outline[j].level < level) break;
        if (outline[j].level === level) {
          data[i].ancestorLines.add(level);
          break;
        }
      }
    }
  }
  
  return data;
};

// Attach event handlers to a row element
const attachRowEventHandlers = (row, item, index) => {
  // Click handler with multi-select support
  row.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey) {
      // CMD/CTRL+click: toggle individual selection
      if (state.selectedIds.has(item.id)) {
        state.selectedIds.delete(item.id);
      } else {
        state.selectedIds.add(item.id);
      }
      state.lastSelectedId = item.id;
    } else if (e.shiftKey && state.lastSelectedId) {
      // SHIFT+click: range selection
      const lastIndex = state.outline.findIndex(i => i.id === state.lastSelectedId);
      const currentIndex = index;
      const [start, end] = lastIndex < currentIndex ? [lastIndex, currentIndex] : [currentIndex, lastIndex];
      for (let i = start; i <= end; i++) {
        state.selectedIds.add(state.outline[i].id);
      }
    } else {
      // Regular click: single selection
      state.selectedIds.clear();
      state.selectedIds.add(item.id);
      state.lastSelectedId = item.id;
    }
    refreshOutline();
    if (scrollToPageCallback) scrollToPageCallback(item.pageIndex + 1);
  });

  // Double-click to rename
  row.addEventListener('dblclick', (e) => {
    e.preventDefault();
    startRename(elements);
  });

  // Context menu
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (!state.selectedIds.has(item.id)) {
      state.selectedIds.clear();
      state.selectedIds.add(item.id);
      state.lastSelectedId = item.id;
    }
    refreshOutline();
    if (openContextMenuCallback) openContextMenuCallback(event.clientX, event.clientY);
  });

  // Drag and drop
  attachDragHandlers(row, index);
};

// Drag and drop handlers
const attachDragHandlers = (row, index) => {
  row.addEventListener('dragstart', (event) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', index.toString());
    row.classList.add('dragging');
  });

  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    document.querySelectorAll('.drag-over-above, .drag-over-below').forEach(el => {
      el.classList.remove('drag-over-above', 'drag-over-below');
    });
  });

  row.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    
    if (row.classList.contains('dragging')) return;
    
    document.querySelectorAll('.drag-over-above, .drag-over-below').forEach(el => {
      if (el !== row) el.classList.remove('drag-over-above', 'drag-over-below');
    });
    
    const rect = row.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    
    if (event.clientY < midpoint) {
      row.classList.add('drag-over-above');
      row.classList.remove('drag-over-below');
    } else {
      row.classList.add('drag-over-below');
      row.classList.remove('drag-over-above');
    }
  });

  row.addEventListener('dragleave', (event) => {
    const rect = row.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || 
        event.clientY < rect.top || event.clientY > rect.bottom) {
      row.classList.remove('drag-over-above', 'drag-over-below');
    }
  });
};

// Handle drop on outline list
export const handleOutlineDrop = (event) => {
  event.preventDefault();
  
  document.querySelectorAll('.drag-over-above, .drag-over-below').forEach(el => {
    el.classList.remove('drag-over-above', 'drag-over-below');
  });
  
  const target = event.target.closest('.outline-item');
  if (!target) return;
  
  const selectedItems = getSelectedItems();
  if (selectedItems.length === 0) return;
  
  const targetId = target.dataset.id;
  if (state.selectedIds.has(targetId)) return;
  
  const rect = target.getBoundingClientRect();
  const dropBelow = event.clientY > rect.top + rect.height / 2;
  
  saveHistory(selectedItems.length > 1 ? 'Move titles by drag' : 'Move title by drag');
  
  // Remove all selected items from their current positions
  const selectedIndices = selectedItems
    .map(item => state.outline.findIndex(o => o.id === item.id))
    .sort((a, b) => b - a);
  
  const removedItems = [];
  for (const idx of selectedIndices) {
    removedItems.unshift(state.outline.splice(idx, 1)[0]);
  }
  
  // Find new target index
  let newTargetIndex = state.outline.findIndex(o => o.id === targetId);
  if (newTargetIndex < 0) newTargetIndex = state.outline.length;
  if (dropBelow) newTargetIndex++;
  
  // Insert all items at target position
  state.outline.splice(newTargetIndex, 0, ...removedItems);
  refreshOutline();
};

// Collapse all items
export const collapseAll = () => {
  state.outline.forEach((item, index) => {
    const hasChildren = index < state.outline.length - 1 && state.outline[index + 1].level > item.level;
    if (hasChildren) {
      state.collapsedNodes.add(item.id);
    }
  });
  refreshOutline();
};

// Expand all items
export const expandAll = () => {
  state.collapsedNodes.clear();
  refreshOutline();
};
