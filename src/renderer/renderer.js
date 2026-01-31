const { ipcRenderer } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

let pdfjsLib = null;
let pdfjsReady = null;

const ensurePdfJsLoaded = async () => {
  if (!pdfjsReady) {
    pdfjsReady = (async () => {
      try {
        const pdfModuleUrl = pathToFileURL(
          path.join(__dirname, '../../node_modules/pdfjs-dist/legacy/build/pdf.mjs')
        ).toString();
        console.log('[PDF.js] Loading from local module:', pdfModuleUrl);
        pdfjsLib = await import(pdfModuleUrl);
        pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
          path.join(__dirname, '../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')
        ).toString();
        console.log('[PDF.js] Loaded successfully from local module');
        console.log('[PDF.js] Worker source:', pdfjsLib.GlobalWorkerOptions.workerSrc);
      } catch (error) {
        console.error('[PDF.js] Failed to load from local module:', error);
        throw error;
      }
    })();
  }

  return pdfjsReady;
};

const state = {
  pdf: null,
  pdfData: null,
  outline: [],
  selectedIds: new Set(),  // Multi-select support
  lastSelectedId: null,  // For SHIFT+click range selection
  currentPage: 1,
  zoom: 1.1,
  filePath: null,
  history: [],
  historyIndex: -1,
  collapsedNodes: new Set(),
  lastActionName: null,
  dirty: false,  // Track if document is modified
  savedHistoryIndex: 0  // Track the history index when last saved
};

const elements = {
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

// Check if single selection (for actions that require it)
const hasSingleSelection = () => state.selectedIds.size === 1;
const hasSelection = () => state.selectedIds.size > 0;
const getFirstSelectedId = () => state.selectedIds.values().next().value;
const getSelectedItems = () => state.outline.filter(item => state.selectedIds.has(item.id));

// Update dirty state
const updateDirtyState = () => {
  state.dirty = state.historyIndex !== state.savedHistoryIndex;
  if (elements.fileName) {
    if (state.dirty) {
      elements.fileName.classList.add('dirty');
    } else {
      elements.fileName.classList.remove('dirty');
    }
  }
};

// Update filename display
const updateFileName = () => {
  if (elements.fileName && state.filePath) {
    const path = require('path');
    elements.fileName.textContent = path.basename(state.filePath);
  } else if (elements.fileName) {
    elements.fileName.textContent = '';
  }
  updateDirtyState();
};

const MAX_HISTORY = 10;

const saveHistory = (actionName = 'change') => {
  const snapshot = JSON.parse(JSON.stringify(state.outline));
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

const updateUndoRedoButtons = () => {
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

const undo = () => {
  if (state.historyIndex > 0) {
    state.historyIndex--;
    state.outline = JSON.parse(JSON.stringify(state.history[state.historyIndex].snapshot));
    refreshOutline();
    updateUndoRedoButtons();
    updateDirtyState();
  }
};

const redo = () => {
  if (state.historyIndex < state.history.length - 1) {
    state.historyIndex++;
    state.outline = JSON.parse(JSON.stringify(state.history[state.historyIndex].snapshot));
    refreshOutline();
    updateUndoRedoButtons();
    updateDirtyState();
  }
};

const startRename = () => {
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
    refreshOutline();
  });
  
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      input.blur();
    } else if (event.key === 'Escape') {
      refreshOutline();
    }
  });
  
  title.replaceWith(input);
  input.focus();
  input.select();
};

const outlineActions = {
  add: () => addOutlineItem({ asChild: false }),
  addChild: () => addOutlineItem({ asChild: true }),
  delete: () => deleteOutlineItem(),
  indent: () => adjustLevel(1),
  outdent: () => adjustLevel(-1),
  moveUp: () => moveItem(-1),
  moveDown: () => moveItem(1),
  rename: () => startRename(),
  setPage: () => openPageModal()
};

const refreshOutline = () => {
  elements.outlineList.innerHTML = '';

  if (state.outline.length === 0) {
    elements.outlineList.innerHTML = '<div class="empty-state">No outline yet. Add a title to begin.</div>';
    return;
  }

  // Use DocumentFragment for batched DOM operations (better performance for large outlines)
  const fragment = document.createDocumentFragment();

  state.outline.forEach((item, index) => {
    const hasChildren = index < state.outline.length - 1 && state.outline[index + 1].level > item.level;
    const isCollapsed = state.collapsedNodes.has(item.id);
    const isHidden = shouldHideItem(item, index);
    
    if (isHidden) return;

    // Check if this is the last child at its level (for the L-shaped connector)
    let isLastChild = true;
    for (let i = index + 1; i < state.outline.length; i++) {
      if (state.outline[i].level < item.level) {
        break;
      }
      if (state.outline[i].level === item.level) {
        isLastChild = false;
        break;
      }
    }

    // Determine which ancestor levels need vertical lines (continuing down)
    const ancestorLines = new Set();
    for (let level = 0; level < item.level; level++) {
      for (let i = index + 1; i < state.outline.length; i++) {
        if (state.outline[i].level < level) break;
        if (state.outline[i].level === level) {
          ancestorLines.add(level);
          break;
        }
      }
    }

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
          // This is the connector segment (L or T shape)
          segment.classList.add('connector');
          if (!isLastChild) {
            segment.classList.add('continue');
          }
        } else if (ancestorLines.has(lvl)) {
          // This is a pass-through vertical line
          segment.classList.add('has-line');
        }
        
        treeIndent.appendChild(segment);
      }
      row.appendChild(treeIndent);
    }

    const toggle = document.createElement('span');
    toggle.className = 'outline-toggle';
    toggle.textContent = hasChildren ? (isCollapsed ? '▶' : '▼') : '•';
    if (hasChildren) {
      toggle.style.cursor = 'pointer';
    }
    
    if (hasChildren) {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isCollapsed) {
          state.collapsedNodes.delete(item.id);
        } else {
          state.collapsedNodes.add(item.id);
        }
        refreshOutline();
      });
    }

    const title = document.createElement('span');
    title.className = 'outline-title';
    title.textContent = item.title;
    title.style.flex = '1';

    row.append(toggle, title);
    fragment.append(row);

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
      scrollToPage(item.pageIndex + 1);
    });

    row.addEventListener('dblclick', (e) => {
      e.preventDefault();
      startRename();
    });

    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (!state.selectedIds.has(item.id)) {
        state.selectedIds.clear();
        state.selectedIds.add(item.id);
        state.lastSelectedId = item.id;
      }
      refreshOutline();
      openContextMenu(event.clientX, event.clientY);
    });

    row.addEventListener('dragstart', (event) => {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', index.toString());
    });
  });

  // Append all at once for better performance
  elements.outlineList.appendChild(fragment);
  
  // Update button states based on selection
  updateButtonStates();
};

// Update toolbar buttons and context menu based on selection
const updateButtonStates = () => {
  const single = hasSingleSelection();
  const any = hasSelection();
  
  // Buttons that require single selection
  const singleOnlyButtons = ['renameTitle', 'setPage', 'moveUp', 'moveDown'];
  singleOnlyButtons.forEach(id => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.disabled = !single;
    }
  });
  
  // Buttons that require any selection
  const anySelectionButtons = ['deleteTitle', 'indentTitle', 'outdentTitle'];
  anySelectionButtons.forEach(id => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.disabled = !any;
    }
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

const shouldHideItem = (item, index) => {
  // Check if any ancestor is collapsed
  for (let i = index - 1; i >= 0; i--) {
    const ancestor = state.outline[i];
    // Found a potential parent (lower level means higher in hierarchy)
    if (ancestor.level < item.level) {
      // If this ancestor is collapsed, hide this item
      if (state.collapsedNodes.has(ancestor.id)) {
        return true;
      }
    }
    // If we encounter an item at the same level or higher, it's not an ancestor
    if (ancestor.level <= item.level && i < index - 1) {
      // Continue checking for other potential ancestors
      continue;
    }
  }
  return false;
};

const addOutlineItem = ({ asChild }) => {
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
  refreshOutline();
};

const deleteOutlineItem = () => {
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
  refreshOutline();
};

const adjustLevel = (delta) => {
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
  
  refreshOutline();
};

const moveItem = (delta) => {
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
  refreshOutline();
};

const openContextMenu = (x, y) => {
  elements.contextMenu.style.display = 'flex';
  
  // Position initially to measure size
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

const closeContextMenu = () => {
  elements.contextMenu.style.display = 'none';
};

const scrollToPage = (pageNumber) => {
  const page = elements.viewer.querySelector(`[data-page-number="${pageNumber}"]`);
  if (page) {
    const distance = Math.abs(pageNumber - state.currentPage);
    const behavior = distance > 10 ? 'instant' : 'smooth';
    page.scrollIntoView({ behavior, block: 'start' });
  }
};

const setPageIndicators = () => {
  elements.currentPage.textContent = state.currentPage;
  elements.totalPages.textContent = state.pdf ? state.pdf.numPages : 1;
};

const renderPdf = async () => {
  if (!state.pdf) return;

  elements.viewer.innerHTML = '';
  const pageCount = state.pdf.numPages;
  elements.totalPages.textContent = pageCount;

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await state.pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: state.zoom });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page';
    wrapper.dataset.pageNumber = pageNumber.toString();

    wrapper.appendChild(canvas);
    elements.viewer.appendChild(wrapper);

    await page.render({ canvasContext: context, viewport }).promise;
  }

  observePages();
};

const observePages = () => {
  const pageElements = Array.from(elements.viewer.querySelectorAll('.pdf-page'));
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting);
      if (visible.length > 0) {
        const top = visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const pageNumber = Number(top.target.dataset.pageNumber || 1);
        if (state.currentPage !== pageNumber) {
          state.currentPage = pageNumber;
          setPageIndicators();
        }
      }
    },
    { root: elements.viewer, threshold: 0.4 }
  );

  pageElements.forEach((element) => observer.observe(element));
};

const collapseAll = () => {
  state.outline.forEach((item, index) => {
    const hasChildren = index < state.outline.length - 1 && state.outline[index + 1].level > item.level;
    if (hasChildren) {
      state.collapsedNodes.add(item.id);
    }
  });
  refreshOutline();
};

const expandAll = () => {
  state.collapsedNodes.clear();
  refreshOutline();
};

const fitToWidth = async () => {
  if (!state.pdf) return;
  
  // Get the first page to calculate optimal zoom
  const page = await state.pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const viewerWidth = elements.viewer.clientWidth - 40; // Account for padding
  const optimalZoom = viewerWidth / viewport.width;
  
  // Update zoom slider and state
  state.zoom = optimalZoom;
  const zoomSlider = document.getElementById('zoomSlider');
  zoomSlider.value = Math.round(optimalZoom * 100);
  
  await renderPdf();
};

const loadPdfData = async ({ data, filePath, outline = [] }) => {
  await ensurePdfJsLoaded();
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
  elements.dropZone.style.display = 'none';
  
  // Refresh outline BEFORE rendering PDF pages so it shows immediately
  refreshOutline();
  
  // Allow the browser to paint the outline before starting heavy PDF rendering
  await new Promise(resolve => requestAnimationFrame(resolve));
  
  await renderPdf();
};

const handleDrop = async (event) => {
  event.preventDefault();
  const file = event.dataTransfer.files[0];
  if (!file) return;
  const data = await file.arrayBuffer();
  await loadPdfData({ data, filePath: file.path, outline: [] });
};

const requestOpenPdf = async () => {
  const result = await ipcRenderer.invoke('open-pdf-dialog');
  if (!result) return;
  await loadPdfData({
    data: result.data,
    filePath: result.filePath,
    outline: result.outline
  });
};

const requestSavePdf = async () => {
  if (!state.pdfData || !state.filePath) {
    return;
  }
  await ipcRenderer.invoke('save-pdf', {
    sourcePath: state.filePath,
    outline: state.outline
  });
  state.savedHistoryIndex = state.historyIndex;
  updateDirtyState();
  updateFileName();
};

const requestSavePdfAs = async () => {
  if (!state.pdfData) {
    return;
  }
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
};

const openPageModal = () => {
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

const closePageModal = () => {
  document.getElementById('pageModal').style.display = 'none';
};

const confirmPageModal = () => {
  if (!hasSingleSelection()) return;
  const firstId = getFirstSelectedId();
  const item = state.outline.find(entry => entry.id === firstId);
  if (!item) return;
  
  const input = document.getElementById('pageInput');
  const pageNumber = parseInt(input.value, 10);
  if (!isNaN(pageNumber) && pageNumber >= 1 && pageNumber <= (state.pdf?.numPages ?? 1)) {
    saveHistory('Set target page');
    item.pageIndex = pageNumber - 1;
    refreshOutline();
  }
  closePageModal();
};

document.getElementById('openPdf').addEventListener('click', requestOpenPdf);
document.getElementById('savePdf').addEventListener('click', requestSavePdf);
document.getElementById('savePdfAs').addEventListener('click', requestSavePdfAs);

document.getElementById('addTitle').addEventListener('click', () => outlineActions.add());
document.getElementById('addChild').addEventListener('click', () => outlineActions.addChild());
document.getElementById('renameTitle').addEventListener('click', () => outlineActions.rename());
document.getElementById('setPage').addEventListener('click', () => outlineActions.setPage());
document.getElementById('deleteTitle').addEventListener('click', () => outlineActions.delete());
document.getElementById('indentTitle').addEventListener('click', () => outlineActions.indent());
document.getElementById('outdentTitle').addEventListener('click', () => outlineActions.outdent());
document.getElementById('moveUp').addEventListener('click', () => outlineActions.moveUp());
document.getElementById('moveDown').addEventListener('click', () => outlineActions.moveDown());
document.getElementById('expandAll').addEventListener('click', () => expandAll());
document.getElementById('collapseAll').addEventListener('click', () => collapseAll());
document.getElementById('undo').addEventListener('click', () => undo());
document.getElementById('redo').addEventListener('click', () => redo());

document.getElementById('prevPage').addEventListener('click', () => scrollToPage(Math.max(1, state.currentPage - 1)));
document.getElementById('nextPage').addEventListener('click', () => scrollToPage(Math.min(state.pdf?.numPages ?? 1, state.currentPage + 1)));
document.getElementById('fitWidth').addEventListener('click', fitToWidth);

document.getElementById('zoomSlider').addEventListener('input', async (event) => {
  state.zoom = Number(event.target.value) / 100;
  await renderPdf();
});

elements.outlineList.addEventListener('dragover', (event) => {
  event.preventDefault();
});

elements.outlineList.addEventListener('drop', (event) => {
  event.preventDefault();
  const target = event.target.closest('.outline-item');
  if (!target) return;
  const targetIndex = Number(target.dataset.index);
  
  // Get all selected items in order
  const selectedItems = getSelectedItems();
  if (selectedItems.length === 0) return;
  
  // Check if target is one of the selected items
  const targetId = target.dataset.id;
  if (state.selectedIds.has(targetId)) return;
  
  saveHistory(selectedItems.length > 1 ? 'Move titles by drag' : 'Move title by drag');
  
  // Remove all selected items from their current positions (from end to start)
  const selectedIndices = selectedItems
    .map(item => state.outline.findIndex(o => o.id === item.id))
    .sort((a, b) => b - a);
  
  const removedItems = [];
  for (const idx of selectedIndices) {
    removedItems.unshift(state.outline.splice(idx, 1)[0]);
  }
  
  // Find new target index (it may have shifted)
  let newTargetIndex = state.outline.findIndex(o => o.id === targetId);
  if (newTargetIndex < 0) newTargetIndex = state.outline.length;
  
  // Insert all items at target position
  state.outline.splice(newTargetIndex, 0, ...removedItems);
  refreshOutline();
});

elements.viewer.addEventListener('dragover', (event) => {
  event.preventDefault();
  elements.dropZone.style.display = 'flex';
});

elements.viewer.addEventListener('dragleave', () => {
  if (!state.pdf) {
    elements.dropZone.style.display = 'flex';
  }
});

elements.viewer.addEventListener('drop', handleDrop);

document.addEventListener('click', () => closeContextMenu());

elements.contextMenu.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  
  // Don't execute if disabled
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

// Page modal events
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

// Keyboard navigation helper
const navigateSelection = (delta, extendSelection = false) => {
  if (state.outline.length === 0) return;
  
  // Use lastSelectedId for extending selection, otherwise use first selected
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
      // Extend selection to include this item
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

// Find parent of an item
const findParentIndex = (itemIndex) => {
  if (itemIndex <= 0) return -1;
  const item = state.outline[itemIndex];
  for (let i = itemIndex - 1; i >= 0; i--) {
    if (state.outline[i].level < item.level) {
      return i;
    }
  }
  return -1;
};

// Global keyboard shortcuts
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
  
  // Add title - check for T key explicitly with both cases
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
        // Collapse this item
        state.collapsedNodes.add(firstId);
        refreshOutline();
      } else {
        // No children or already collapsed: select and collapse parent
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
      startRename();
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

// Handle file opened from main process (CLI or drag on app icon)
ipcRenderer.on('open-file', async (event, { data, filePath, outline }) => {
  await loadPdfData({ data, filePath, outline });
});

// Initialize version display
ipcRenderer.invoke('get-app-version').then((version) => {
  document.getElementById('appVersion').textContent = `v${version}`;
});

setPageIndicators();
refreshOutline();
