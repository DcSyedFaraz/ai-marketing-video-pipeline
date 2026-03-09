// ── Story History Storage ────────────────────────────────────────────────────
// Separate from main history to avoid clutter.
// Stored at output/story_history.json.

import { existsSync, readFileSync, writeFileSync } from 'fs';

const STORY_HISTORY_FILE = 'output/story_history.json';

export function loadStoryHistory() {
  try {
    if (existsSync(STORY_HISTORY_FILE)) {
      return JSON.parse(readFileSync(STORY_HISTORY_FILE, 'utf8'));
    }
  } catch {}
  return [];
}

export function saveStoryHistory(history) {
  try {
    writeFileSync(STORY_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (e) {
    console.error('[StoryHistory] Failed to save:', e.message);
  }
}

export function addStoryEntry(entry) {
  const history = loadStoryHistory();
  history.unshift(entry);
  saveStoryHistory(history);
  return entry;
}

export function updateStoryEntry(taskUUID, updates) {
  const history = loadStoryHistory();
  const idx = history.findIndex(h => h.taskUUID === taskUUID);
  if (idx !== -1) {
    history[idx] = { ...history[idx], ...updates };
    saveStoryHistory(history);
    return history[idx];
  }
  return null;
}

/**
 * Update a specific scene within a story entry.
 * @param {string} taskUUID
 * @param {number} sceneIndex — 0-based index into the scenes array
 * @param {object} updates — fields to merge into the scene object
 */
export function updateSceneInStory(taskUUID, sceneIndex, updates) {
  const history = loadStoryHistory();
  const idx = history.findIndex(h => h.taskUUID === taskUUID);
  if (idx !== -1 && history[idx].scenes && history[idx].scenes[sceneIndex]) {
    history[idx].scenes[sceneIndex] = { ...history[idx].scenes[sceneIndex], ...updates };
    saveStoryHistory(history);
    return history[idx];
  }
  return null;
}
