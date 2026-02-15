/**
 * Settings modal for LLM configuration
 */

const { ipcRenderer } = require('electron');

let settingsCache = null;

// Open the settings modal and populate fields
export const openSettingsModal = async () => {
  const modal = document.getElementById('settingsModal');
  const settings = await ipcRenderer.invoke('get-settings');
  settingsCache = settings;

  document.getElementById('settingsProvider').value = settings.llmProvider;
  document.getElementById('settingsApiKey').value = settings.openaiApiKey;
  document.getElementById('settingsOpenaiModel').value = settings.openaiModel;
  document.getElementById('settingsOllamaPort').value = settings.ollamaPort;
  document.getElementById('settingsOllamaModel').value = settings.ollamaModel;

  updateProviderVisibility(settings.llmProvider);
  modal.style.display = 'flex';
};

const closeSettingsModal = () => {
  document.getElementById('settingsModal').style.display = 'none';
};

const updateProviderVisibility = (provider) => {
  document.getElementById('openaiSettings').style.display = provider === 'openai' ? 'block' : 'none';
  document.getElementById('ollamaSettings').style.display = provider === 'ollama' ? 'block' : 'none';
};

const saveSettingsFromModal = async () => {
  const settings = {
    llmProvider: document.getElementById('settingsProvider').value,
    openaiApiKey: document.getElementById('settingsApiKey').value,
    openaiModel: document.getElementById('settingsOpenaiModel').value,
    ollamaPort: parseInt(document.getElementById('settingsOllamaPort').value, 10) || 11434,
    ollamaModel: document.getElementById('settingsOllamaModel').value
  };

  await ipcRenderer.invoke('save-settings', settings);
  settingsCache = settings;
  closeSettingsModal();
};

// Get current settings (cached or from main process)
export const getSettings = async () => {
  if (settingsCache) return settingsCache;
  settingsCache = await ipcRenderer.invoke('get-settings');
  return settingsCache;
};

// Setup event handlers
export const setupSettingsModalHandlers = () => {
  document.getElementById('settingsProvider').addEventListener('change', (e) => {
    updateProviderVisibility(e.target.value);
  });

  document.getElementById('settingsCancel').addEventListener('click', closeSettingsModal);
  document.getElementById('settingsSave').addEventListener('click', saveSettingsFromModal);

  document.getElementById('settingsModal').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeSettingsModal();
  });

  document.getElementById('settingsModal').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSettingsModal();
  });
};
