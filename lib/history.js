import { existsSync, readFileSync, writeFileSync } from 'fs';

const HISTORY_FILE = 'output/history.json';

export function loadHistory() {
  try {
    if (existsSync(HISTORY_FILE)) {
      return JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch {}
  return [];
}

export function saveHistory(history) {
  try {
    writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (e) {
    console.error('[History] Failed to save:', e.message);
  }
}

export function addHistoryEntry(entry) {
  const history = loadHistory();
  history.unshift(entry);
  saveHistory(history);
  return entry;
}

export function updateHistoryEntry(taskUUID, updates) {
  const history = loadHistory();
  const idx = history.findIndex(h => h.taskUUID === taskUUID);
  if (idx !== -1) {
    history[idx] = { ...history[idx], ...updates };
    saveHistory(history);
    return history[idx];
  }
  return null;
}
