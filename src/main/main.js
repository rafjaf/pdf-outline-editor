import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { applyOutlineToPdf, extractOutline } from '../shared/outline.js';
import { loadSettings, saveSettings } from './settings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read version from package.json
const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');
const APP_VERSION = packageJson.version;

let mainWindow = null;
let pendingFilePath = null;
let isQuitting = false;

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
  
  // Handle close with unsaved changes
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    
    // Always prevent default first, then handle async logic
    event.preventDefault();
    
    // Check dirty state and show dialog
    handleCloseWithUnsavedChanges();
  });
  
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

// Handle close with unsaved changes (async helper)
const handleCloseWithUnsavedChanges = async () => {
  if (!mainWindow) return;
  
  try {
    // Ask renderer if there are unsaved changes
    const isDirty = await mainWindow.webContents.executeJavaScript('window.isDirty ? window.isDirty() : false');
    
    if (!isDirty) {
      // No unsaved changes, just close
      isQuitting = true;
      mainWindow.close();
      return;
    }
    
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Save and Exit', 'Exit Without Saving', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Unsaved Changes',
      message: 'You have unsaved changes.',
      detail: 'Do you want to save your changes before exiting?'
    });
    
    if (response === 0) {
      // Save and exit
      mainWindow.webContents.send('save-before-quit');
    } else if (response === 1) {
      // Exit without saving
      isQuitting = true;
      mainWindow.close();
    }
    // response === 2: Cancel - do nothing
  } catch (err) {
    console.error('Error checking dirty state:', err);
    // On error, allow close
    isQuitting = true;
    mainWindow.close();
  }
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

// Handle quit request from renderer after saving
ipcMain.on('quit-app', () => {
  isQuitting = true;
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

// Settings
ipcMain.handle('get-settings', async () => {
  return loadSettings();
});

ipcMain.handle('save-settings', async (_event, settings) => {
  return saveSettings(settings);
});

// Open file dialog for TOC import (PDF or text)
ipcMain.handle('open-toc-file-dialog', async (_event, filter) => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Select TOC Source File',
    filters: [filter],
    properties: ['openFile']
  });

  if (canceled || filePaths.length === 0) return null;

  const filePath = filePaths[0];
  const data = await readFile(filePath);
  return { filePath, data: data.buffer };
});

ipcMain.handle('save-toc-json-dialog', async (_event, payload) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Export Extracted TOC JSON',
    defaultPath: 'toc.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });

  if (canceled || !filePath) return null;

  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  return { filePath };
});
