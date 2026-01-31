import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { applyOutlineToPdf, extractOutline } from '../shared/outline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read version from package.json
const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');
const APP_VERSION = packageJson.version;

let mainWindow = null;
let pendingFilePath = null;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'PDF Outline Editor',
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  
  // When the window is ready, open any pending file
  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingFilePath) {
      openFileInRenderer(pendingFilePath);
      pendingFilePath = null;
    }
  });
  
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

// Open a file in the renderer
const openFileInRenderer = async (filePath) => {
  if (!mainWindow) return;
  
  try {
    const data = await readFile(filePath);
    const outline = await extractOutline(data);
    mainWindow.webContents.send('open-file', { filePath, data: data.buffer, outline });
  } catch (err) {
    console.error('Failed to open file:', err);
  }
};

// Handle file open from command line arguments
const handleArgv = (argv) => {
  // Look for PDF files in arguments
  const pdfFile = argv.find(arg => arg.endsWith('.pdf') && !arg.startsWith('-'));
  if (pdfFile) {
    const filePath = path.resolve(pdfFile);
    if (mainWindow && mainWindow.webContents) {
      openFileInRenderer(filePath);
    } else {
      pendingFilePath = filePath;
    }
  }
};

// Handle files dropped onto the app icon (macOS)
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow && mainWindow.webContents) {
    openFileInRenderer(filePath);
  } else {
    pendingFilePath = filePath;
  }
});

app.whenReady().then(() => {
  createWindow();
  
  // Handle command line arguments
  handleArgv(process.argv);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed (including on macOS)
app.on('window-all-closed', () => {
  app.quit();
});

ipcMain.handle('get-app-version', () => APP_VERSION);

ipcMain.handle('open-pdf-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Open PDF',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile']
  });

  if (canceled || filePaths.length === 0) {
    return null;
  }

  const filePath = filePaths[0];
  const data = await readFile(filePath);
  const outline = await extractOutline(data);
  return { filePath, data: data.buffer, outline };
});

// Save (overwrite original with backup)
ipcMain.handle('save-pdf', async (_event, { sourcePath, outline }) => {
  if (!sourcePath) {
    return null;
  }

  // Create backup
  const backupPath = sourcePath + '.backup';
  try {
    await copyFile(sourcePath, backupPath);
  } catch (err) {
    console.error('Failed to create backup:', err);
  }

  const sourceData = await readFile(sourcePath);
  const updated = await applyOutlineToPdf(sourceData, outline);
  await writeFile(sourcePath, Buffer.from(updated));
  return { filePath: sourcePath };
});

// Save As (choose new location)
ipcMain.handle('save-pdf-as', async (_event, { sourcePath, outline }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save PDF As',
    defaultPath: sourcePath ?? 'outline.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });

  if (canceled || !filePath) {
    return null;
  }

  const sourceData = await readFile(sourcePath);
  const updated = await applyOutlineToPdf(sourceData, outline);
  await writeFile(filePath, Buffer.from(updated));
  return { filePath };
});
