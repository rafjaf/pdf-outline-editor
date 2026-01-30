import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  openPdf: () => ipcRenderer.invoke('open-pdf-dialog'),
  savePdf: (payload) => ipcRenderer.invoke('save-pdf-dialog', payload)
});
