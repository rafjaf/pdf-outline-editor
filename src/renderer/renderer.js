const { ipcRenderer } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleSearchPaths = [process.cwd(), __dirname];
const pdfPath = require.resolve('pdfjs-dist/legacy/build/pdf.js', { paths: moduleSearchPaths });
const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.js', { paths: moduleSearchPaths });
const pdfjsLib = require(pdfPath);

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).toString();

const state = {
  pdf: null,
  pdfData: null,
  outline: [],
  selectedId: null,
  currentPage: 1,
  zoom: 1.1,
  filePath: null
};

const elements = {
  viewer: document.getElementById('viewer'),
  outlineList: document.getElementById('outlineList'),
  dropZone: document.getElementById('dropZone'),
  contextMenu: document.getElementById('contextMenu'),
  currentPage: document.getElementById('currentPage'),
  totalPages: document.getElementById('totalPages')
};

const outlineActions = {
  add: () => addOutlineItem({ asChild: false }),
  addChild: () => addOutlineItem({ asChild: true }),
  delete: () => deleteOutlineItem(),
  indent: () => adjustLevel(1),
  outdent: () => adjustLevel(-1),
  moveUp: () => moveItem(-1),
  moveDown: () => moveItem(1)
};

const refreshOutline = () => {
  elements.outlineList.innerHTML = '';

  if (state.outline.length === 0) {
    elements.outlineList.innerHTML = '<div class="empty-state">No outline yet. Add a title to begin.</div>';
    return;
  }

  state.outline.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = `outline-item outline-level-${Math.min(item.level, 3)} ${item.id === state.selectedId ? 'active' : ''}`;
    row.draggable = true;
    row.dataset.id = item.id;
    row.dataset.index = index;

    const page = document.createElement('div');
    page.textContent = `p.${item.pageIndex + 1}`;
    page.style.fontSize = '12px';
    page.style.color = 'var(--muted)';

    const title = document.createElement('span');
    title.textContent = item.title;

    row.append(page, title);
    elements.outlineList.append(row);

    row.addEventListener('click', () => {
      state.selectedId = item.id;
      refreshOutline();
      scrollToPage(item.pageIndex + 1);
    });

    row.addEventListener('dblclick', () => {
      const input = document.createElement('input');
      input.value = item.title;
      input.addEventListener('blur', () => {
        item.title = input.value || 'Untitled';
        refreshOutline();
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          input.blur();
        }
      });
      row.replaceChildren(page, input);
      input.focus();
    });

    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      state.selectedId = item.id;
      refreshOutline();
      openContextMenu(event.clientX, event.clientY);
    });

    row.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', index.toString());
    });
  });
};

const addOutlineItem = ({ asChild }) => {
  if (!state.pdf) return;

  const baseIndex = state.outline.findIndex((item) => item.id === state.selectedId);
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
  state.selectedId = item.id;
  refreshOutline();
};

const deleteOutlineItem = () => {
  if (!state.selectedId) return;
  const index = state.outline.findIndex((item) => item.id === state.selectedId);
  if (index >= 0) {
    state.outline.splice(index, 1);
    state.selectedId = state.outline[index]?.id ?? state.outline[index - 1]?.id ?? null;
    refreshOutline();
  }
};

const adjustLevel = (delta) => {
  const item = state.outline.find((entry) => entry.id === state.selectedId);
  if (!item) return;
  item.level = Math.max(0, item.level + delta);
  refreshOutline();
};

const moveItem = (delta) => {
  const index = state.outline.findIndex((item) => item.id === state.selectedId);
  if (index < 0) return;
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= state.outline.length) return;
  const [removed] = state.outline.splice(index, 1);
  state.outline.splice(nextIndex, 0, removed);
  refreshOutline();
};

const openContextMenu = (x, y) => {
  elements.contextMenu.style.display = 'flex';
  elements.contextMenu.style.left = `${x}px`;
  elements.contextMenu.style.top = `${y}px`;
};

const closeContextMenu = () => {
  elements.contextMenu.style.display = 'none';
};

const scrollToPage = (pageNumber) => {
  const page = elements.viewer.querySelector(`[data-page-number="${pageNumber}"]`);
  if (page) {
    page.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

const loadPdfData = async ({ data, filePath, outline = [] }) => {
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
  setPageIndicators();
  elements.dropZone.style.display = 'none';
  await renderPdf();
  refreshOutline();
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
  if (!state.pdfData) {
    return;
  }
  await ipcRenderer.invoke('save-pdf-dialog', {
    sourcePath: state.filePath,
    outline: state.outline
  });
};

document.getElementById('openPdf').addEventListener('click', requestOpenPdf);
document.getElementById('savePdf').addEventListener('click', requestSavePdf);

document.getElementById('addTitle').addEventListener('click', () => outlineActions.add());
document.getElementById('addChild').addEventListener('click', () => outlineActions.addChild());
document.getElementById('deleteTitle').addEventListener('click', () => outlineActions.delete());
document.getElementById('indentTitle').addEventListener('click', () => outlineActions.indent());
document.getElementById('outdentTitle').addEventListener('click', () => outlineActions.outdent());
document.getElementById('moveUp').addEventListener('click', () => outlineActions.moveUp());
document.getElementById('moveDown').addEventListener('click', () => outlineActions.moveDown());

document.getElementById('prevPage').addEventListener('click', () => scrollToPage(Math.max(1, state.currentPage - 1)));
document.getElementById('nextPage').addEventListener('click', () => scrollToPage(Math.min(state.pdf?.numPages ?? 1, state.currentPage + 1)));

document.getElementById('zoomSlider').addEventListener('input', async (event) => {
  state.zoom = Number(event.target.value) / 100;
  await renderPdf();
});

elements.outlineList.addEventListener('dragover', (event) => {
  event.preventDefault();
});

elements.outlineList.addEventListener('drop', (event) => {
  event.preventDefault();
  const sourceIndex = Number(event.dataTransfer.getData('text/plain'));
  const target = event.target.closest('.outline-item');
  if (!target) return;
  const targetIndex = Number(target.dataset.index);
  const [removed] = state.outline.splice(sourceIndex, 1);
  state.outline.splice(targetIndex, 0, removed);
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
  const action = event.target.dataset.action;
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

setPageIndicators();
refreshOutline();
