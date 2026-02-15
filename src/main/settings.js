/**
 * Settings management
 * Stores LLM configuration in ~/.config/pdf-outline-editor/settings.json
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'pdf-outline-editor');
const CONFIG_FILE = path.join(CONFIG_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  llmProvider: 'openai',
  openaiApiKey: '',
  openaiModel: 'gpt-5-mini',
  ollamaPort: 11434,
  ollamaModel: 'llama3'
};

export const loadSettings = async () => {
  try {
    const data = await readFile(CONFIG_FILE, 'utf-8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
};

export const saveSettings = async (settings) => {
  await mkdir(CONFIG_DIR, { recursive: true });
  const toSave = {
    llmProvider: settings.llmProvider || DEFAULT_SETTINGS.llmProvider,
    openaiApiKey: settings.openaiApiKey || '',
    openaiModel: settings.openaiModel || DEFAULT_SETTINGS.openaiModel,
    ollamaPort: settings.ollamaPort || DEFAULT_SETTINGS.ollamaPort,
    ollamaModel: settings.ollamaModel || DEFAULT_SETTINGS.ollamaModel
  };
  await writeFile(CONFIG_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
  return toSave;
};
