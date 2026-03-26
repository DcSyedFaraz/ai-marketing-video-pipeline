// ── Global Batch Poller ───────────────────────────────────────────────────────
// A shared Runware connection + polling loop that checks ALL registered
// task UUIDs in ONE batched getResponse call per tick.
//
// Usage (main routes):
//   import { globalPoller, makeVideoCompleteHandler, makeErrorHandler } from '../lib/globalPoller.js';
//   await globalPoller.getConnection().videoInference({ ...payload, skipResponse: true });
//   globalPoller.register(taskUUID, { type: 'video', label: 'Veo', onComplete: makeVideoCompleteHandler(taskUUID, 'veo'), onError: makeErrorHandler(taskUUID) });
//
// For story/podcast: instantiate with new GlobalPoller() and call .init(apiKey)

import { Runware } from '@runware/sdk-js';
import { EventEmitter } from 'events';
import path from 'path';
import { unlink } from 'fs/promises';
import { loadHistory, updateHistoryEntry } from './history.js';
import { downloadVideo } from './helpers.js';
import { concatVideos, mixMusicIntoVideo } from './ffmpeg.js';

const POLL_INTERVAL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// SSE event emitter — shared between globalPoller and server.js
export const sseEmitter = new EventEmitter();

export class GlobalPoller {
  /**
   * @param {string} [label] - Label prefix for console logs (default: 'GlobalPoller')
   */
  constructor(label = 'GlobalPoller') {
    this._label = label;
    this._conn = null;
    this._apiKey = null;
    this._tasks = new Map(); // taskUUID → { type, label, registeredAt, timeoutMs, onComplete, onError }
    this._interval = null;
    this._busy = false;
    this._initialized = false;
  }

  /**
   * Connect to Runware and start the polling interval.
   * @param {string} apiKey
   */
  async init(apiKey) {
    this._apiKey = apiKey;
    this._conn = new Runware({ apiKey });
    await this._conn.ensureConnection();
    this._initialized = true;
    console.log(`[${this._label}] Connected to Runware WebSocket`);

    this._interval = setInterval(() => this._tick(), POLL_INTERVAL_MS);
    console.log(`[${this._label}] Polling interval started (${POLL_INTERVAL_MS}ms)`);
  }

  /**
   * Return the underlying Runware connection (for submitting tasks).
   */
  getConnection() {
    return this._conn;
  }

  /**
   * Register a task UUID for polling.
   * @param {string} taskUUID
   * @param {object} opts
   * @param {'video'|'image'} [opts.type='video']
   * @param {string} [opts.label]
   * @param {number} [opts.timeoutMs]
   * @param {Function} opts.onComplete  async (result) => void
   * @param {Function} opts.onError     async (err) => void
   */
  register(taskUUID, { type = 'video', label = taskUUID.slice(0, 8), timeoutMs = DEFAULT_TIMEOUT_MS, onComplete, onError }) {
    if (this._tasks.has(taskUUID)) {
      console.log(`[${this._label}] Task ${taskUUID} already registered — skipping duplicate`);
      return;
    }
    this._tasks.set(taskUUID, { type, label, registeredAt: Date.now(), timeoutMs, onComplete, onError });
    console.log(`[${this._label}] Registered ${label} | taskUUID: ${taskUUID} | type: ${type} | pending: ${this._tasks.size}`);
  }

  /**
   * Check if a task is currently registered.
   */
  has(taskUUID) {
    return this._tasks.has(taskUUID);
  }

  get pendingCount() {
    return this._tasks.size;
  }

  /**
   * One poll cycle: collect all pending UUIDs, send ONE batched getResponse call,
   * match responses back, call onComplete/onError for finished tasks.
   */
  async _tick() {
    if (this._busy || this._tasks.size === 0) return;
    this._busy = true;

    try {
      const ids = [...this._tasks.keys()];

      // ── Check timeouts first ──────────────────────────────────────────────
      const now = Date.now();
      for (const taskUUID of ids) {
        const entry = this._tasks.get(taskUUID);
        if (!entry) continue;
        if (now - entry.registeredAt > entry.timeoutMs) {
          console.error(`[${this._label}] ${entry.label} | TIMEOUT after ${((now - entry.registeredAt) / 1000).toFixed(1)}s`);
          this._tasks.delete(taskUUID);
          entry.onError(new Error(`Timed out after ${entry.timeoutMs / 1000}s`)).catch(e =>
            console.error(`[${this._label}] onError threw:`, e?.message)
          );
        }
      }

      const pendingIds = [...this._tasks.keys()];
      if (pendingIds.length === 0) return;

      // ── Batch getResponse via direct REST API ──────────────────────────────
      const requestPayload = pendingIds.map(uuid => ({ taskType: 'getResponse', taskUUID: uuid }));
      console.log(`[${this._label}] ── Tick | ${pendingIds.length} task(s) | Request:`, JSON.stringify(requestPayload));

      let responses;
      try {
        const res = await fetch('https://api.runware.ai/v1', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this._apiKey}`,
          },
          body: JSON.stringify(requestPayload),
        });
        const json = await res.json();
        responses = json?.data ?? json;
        if (!res.ok) {
          console.error(`[${this._label}] HTTP ${res.status}:`, JSON.stringify(json));
          return;
        }
      } catch (connErr) {
        console.error(`[${this._label}] fetch error:`, connErr?.message || connErr);
        return; // Will retry next tick
      }

      console.log(`[${this._label}] ── Response (${responses?.length ?? 0} item(s)):`, JSON.stringify(responses));

      if (!responses?.length) return;

      // ── Match each response to its task entry ──────────────────────────────
      for (const r of responses) {
        const uuid = r.taskUUID;
        if (!uuid) continue;
        const entry = this._tasks.get(uuid);
        if (!entry) continue;

        const elapsed = ((Date.now() - entry.registeredAt) / 1000).toFixed(1);

        const apiErr = r.error || r.errors?.[0];
        if (apiErr) {
          console.error(`[${this._label}] ${entry.label} | API error: ${JSON.stringify(apiErr)}`);
          this._tasks.delete(uuid);
          entry.onError(new Error(`API error: ${JSON.stringify(apiErr)}`)).catch(e =>
            console.error(`[${this._label}] onError threw:`, e?.message)
          );
          continue;
        }

        const result = entry.type === 'image'
          ? this._checkImageResult(r)
          : this._checkVideoResult(r);

        if (result) {
          console.log(`[${this._label}] ✅ ${entry.label} | completed after ${elapsed}s | cost: ${result.cost !== null ? '$' + result.cost : 'N/A'}`);
          this._tasks.delete(uuid);
          // Non-blocking: error in onComplete does not affect other tasks
          entry.onComplete(result).catch(e =>
            console.error(`[${this._label}] onComplete threw for ${entry.label}:`, e?.message)
          );
        }
      }
    } catch (err) {
      console.error(`[${this._label}] Tick error:`, err?.message || err);
    } finally {
      this._busy = false;
    }
  }

  _checkVideoResult(r) {
    if (r.videoURL) {
      const cost = r.cost ?? r.taskCost ?? r.inferCost ?? null;
      return { ...r, cost };
    }
    return null;
  }

  _checkImageResult(r) {
    const imgURL = r.imageURL || r.url || r.outputURL;
    if (imgURL) {
      const cost = r.cost ?? r.taskCost ?? r.inferCost ?? null;
      return { ...r, imageURL: imgURL, cost };
    }
    return null;
  }
}

// ── Main singleton for veo/avatar/lipsync/bridge routes ───────────────────────
export const globalPoller = new GlobalPoller('GlobalPoller');

/**
 * Initialize the main global poller singleton. Call once on server startup.
 */
export async function initGlobalPoller(apiKey) {
  await globalPoller.init(apiKey);
}

/**
 * Restore pending tasks from history.json on server restart.
 * Tasks registered here use generic video download handlers.
 */
export async function restorePendingTasks() {
  const history = loadHistory();
  const pending = history.filter(h => h.status === 'pending');
  if (pending.length === 0) {
    console.log('[GlobalPoller] No pending tasks to restore');
    return;
  }
  for (const entry of pending) {
    const onComplete = entry._pipeline
      ? makeBridgeRestoreHandler(entry.taskUUID, entry._pipeline)
      : makeVideoCompleteHandler(entry.taskUUID, entry.type);
    globalPoller.register(entry.taskUUID, {
      type: 'video',
      label: `Restore-${entry.type}-${entry.taskUUID.slice(0, 8)}`,
      onComplete,
      onError: makeErrorHandler(entry.taskUUID),
    });
  }
  console.log(`[GlobalPoller] Restored ${pending.length} pending task(s) from history`);
}

// ── Reusable completion handler factories ────────────────────────────────────

/**
 * Returns an async onComplete handler that downloads the video,
 * updates history, and emits an SSE event.
 */
export function makeVideoCompleteHandler(taskUUID, type) {
  return async (result) => {
    const typeMap = { avatar: 'avatar', veo: 'veo', bridge: 'bridge_final', lipsync: 'lipsync' };
    const prefix = typeMap[type] || type || 'video';
    const filename = `${prefix}_${Date.now()}.mp4`;
    const outputPath = path.join('output', filename);

    console.log(`[GlobalPoller] Downloading ${type} video → ${outputPath}`);
    await downloadVideo(result.videoURL, outputPath);
    console.log(`[GlobalPoller] ✅ Download complete: ${filename}`);

    const updated = updateHistoryEntry(taskUUID, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      videoUrl: `/output/${filename}`,
      videoURL: result.videoURL,
      filename,
      cost: result.cost ?? null,
      costSource: result.cost != null ? 'api' : null,
    });

    sseEmitter.emit('task-complete', {
      taskUUID,
      type,
      status: 'completed',
      videoUrl: `/output/${filename}`,
      entry: updated,
    });
  };
}

/**
 * Returns an async onComplete handler for bridge tasks restored after a server restart.
 * Uses the _pipeline paths stored in the history entry to run concat + music mix.
 * @param {string} taskUUID
 * @param {{ sourceVideoPath: string, bridgeGenerated: string, bridgeConcatted: string, bridgeFinal: string, musicPath: string|null }} pipeline
 */
export function makeBridgeRestoreHandler(taskUUID, pipeline) {
  const { sourceVideoPath, bridgeGenerated, bridgeWithMusic, bridgeConcatted, bridgeFinal, musicPath, musicScope } = pipeline;
  return async (result) => {
    try {
      console.log(`[GlobalPoller] [Bridge-Restore] Downloading bridge video → ${bridgeGenerated}`);
      await downloadVideo(result.videoURL, bridgeGenerated);

      let bridgeClipForConcat = bridgeGenerated;
      if (musicPath && musicScope === 'bridge-only' && bridgeWithMusic) {
        console.log(`[GlobalPoller] [Bridge-Restore] Mixing music into bridge clip → ${bridgeWithMusic}`);
        await mixMusicIntoVideo(bridgeGenerated, musicPath, bridgeWithMusic, 0.25);
        bridgeClipForConcat = bridgeWithMusic;
      }

      console.log(`[GlobalPoller] [Bridge-Restore] Concatenating: ${sourceVideoPath} + ${bridgeClipForConcat} → ${bridgeConcatted}`);
      await concatVideos(sourceVideoPath, bridgeClipForConcat, bridgeConcatted);
      console.log(`[GlobalPoller] [Bridge-Restore] ✅ Concatenation complete`);

      if (musicPath && musicScope !== 'bridge-only') {
        console.log(`[GlobalPoller] [Bridge-Restore] Mixing music into full video: ${musicPath}`);
        await mixMusicIntoVideo(bridgeConcatted, musicPath, bridgeFinal, 0.25);
        await unlink(bridgeConcatted).catch(() => {});
      }

      const filename = path.basename(bridgeFinal);
      const updated = updateHistoryEntry(taskUUID, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        videoUrl: `/output/${filename}`,
        videoURL: result.videoURL,
        filename,
        cost: result.cost ?? null,
        costSource: result.cost != null ? 'api' : null,
      });

      sseEmitter.emit('task-complete', {
        taskUUID,
        type: 'bridge',
        status: 'completed',
        videoUrl: `/output/${filename}`,
        entry: updated,
      });
    } finally {
      await unlink(bridgeGenerated).catch(() => {});
      if (bridgeWithMusic) await unlink(bridgeWithMusic).catch(() => {});
    }
  };
}

/**
 * Returns an async onError handler that marks history as failed
 * and emits an SSE event.
 */
export function makeErrorHandler(taskUUID, type) {
  return async (err) => {
    const errMsg = err?.message || String(err);
    console.error(`[GlobalPoller] ❌ Task ${taskUUID} failed: ${errMsg}`);
    updateHistoryEntry(taskUUID, {
      status: 'failed',
      error: errMsg,
      completedAt: new Date().toISOString(),
    });
    sseEmitter.emit('task-complete', { taskUUID, type, status: 'failed', error: errMsg });
  };
}
