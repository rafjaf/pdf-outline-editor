import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { applyOutlineToPdf, extractOutline } from '../shared/outline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const createWindow = () => {
  const mainWindow = new BrowserWindow({
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
};

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

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

ipcMain.handle('save-pdf-dialog', async (_event, { sourcePath, outline }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save PDF with Outline',
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
