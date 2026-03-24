// Core Runware polling helpers
import { Runware } from '@runware/sdk-js';

const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 10 * 60 * 1000;

/**
 * Submit one image inference task async (skipResponse: true). Does NOT wait for result.
 * Returns the taskUUID that was submitted.
 */
export async function imageSubmit(runware, payload, label) {
  const taskUUID = payload.taskUUID;
  console.log(`[${label}] Submitting image task ${taskUUID} (skipResponse)...`);
  try {
    await runware.imageInference({ ...payload, skipResponse: true });
  } catch (submitErr) {
    const msg = submitErr?.message || (typeof submitErr === 'string' ? submitErr : JSON.stringify(submitErr));
    console.error(`[${label}] Image submit failed:`, submitErr);
    throw new Error(`Image submit failed: ${msg}`);
  }
  console.log(`[${label}] Image task ${taskUUID} submitted OK.`);
  return taskUUID;
}

/**
 * Generate one image on its OWN dedicated connection.
 * Uses the same submit-with-skipResponse + getResponse poll pattern as submitAndPoll (video).
 * Each scene gets its own connection to avoid WebSocket contention with large base64 payloads.
 */
export async function imageSubmitAndPollOwn(apiKey, payload, label) {
  const taskUUID = payload.taskUUID;
  console.log(`[${label}] Opening dedicated connection for task ${taskUUID}...`);
  const conn = new Runware({ apiKey });
  try {
    await conn.ensureConnection();
    console.log(`[${label}] Connection ready. Submitting imageInference (skipResponse) for task ${taskUUID}...`);

    const submitStart = Date.now();

    try {
      await conn.imageInference({ ...payload, includeCost: true, skipResponse: true, deliveryMethod: 'async' });
    } catch (submitErr) {
      const msg = submitErr?.message || (typeof submitErr === 'string' ? submitErr : JSON.stringify(submitErr));
      console.error(`[${label}] Image submit failed:`, submitErr);
      throw new Error(`Image submit failed: ${msg}`);
    }
    console.log(`[${label}] Image task ${taskUUID} submitted OK. Polling every ${POLL_INTERVAL_MS / 1000}s...`);

    let attempt = 0;
    const deadline = Date.now() + MAX_WAIT_MS;

    while (Date.now() < deadline) {
      attempt++;
      const elapsed = ((Date.now() - submitStart) / 1000).toFixed(1);
      console.log(`[${label}] Image poll #${attempt} | elapsed: ${elapsed}s | taskUUID: ${taskUUID}`);

      try {
        const responses = await conn.getResponse({ taskUUID });
        console.log(`[${label}] Image poll #${attempt} | getResponse → ${responses?.length ?? 0} item(s)`);

        if (responses?.length) {
          for (const r of responses) {
            // Log the FULL raw response so every field is visible in console
            console.log(`[${label}] Image poll #${attempt} | raw:`, JSON.stringify(r));
            if (r.error) throw new Error(`API error: ${JSON.stringify(r.error)}`);
            const imgURL = r.imageURL || r.url || r.outputURL;
            if (imgURL) {
              const cost = r.cost ?? r.taskCost ?? r.inferCost ?? null;
              console.log(`[${label}] ✅ Image ready after ${elapsed}s | cost: ${cost !== null ? '$' + cost : 'N/A'} | url: ${imgURL.slice(0, 80)}...`);
              return { ...r, imageURL: imgURL, cost };
            }
          }
          console.log(`[${label}] Image poll #${attempt} | no imageURL yet — keys present: ${responses.map(r => Object.keys(r).join(',')).join(' | ')}`);
        } else {
          console.log(`[${label}] Image poll #${attempt} | no result yet...`);
        }
      } catch (err) {
        const msg = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
        console.error(`[${label}] Image poll #${attempt} | ERROR:`, err);
        throw err instanceof Error ? err : new Error(msg);
      }

      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`Timed out after ${MAX_WAIT_MS / 1000}s waiting for image.`);

  } finally {
    try { conn.disconnect(); } catch { }
    console.log(`[${label}] Dedicated connection closed.`);
  }
}

/**
 * Poll a single image task until imageURL arrives.
 */
export async function imagePoll(runware, taskUUID, label) {
  const submitStart = Date.now();
  let attempt = 0;
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    attempt++;
    const elapsed = ((Date.now() - submitStart) / 1000).toFixed(1);
    console.log(`[${label}] Image poll #${attempt} | elapsed: ${elapsed}s | taskUUID: ${taskUUID}`);

    try {
      const responses = await runware.getResponse({ taskUUID });
      console.log(`[${label}] Image poll #${attempt} | getResponse → ${responses?.length ?? 0} item(s)`);

      if (responses?.length) {
        for (const r of responses) {
          // Log the FULL raw response so every field is visible in console
          console.log(`[${label}] Image poll #${attempt} | raw:`, JSON.stringify(r));
          if (r.error) throw new Error(`API error: ${JSON.stringify(r.error)}`);
          const imgURL = r.imageURL || r.url || r.outputURL;
          if (imgURL) {
            const cost = r.cost ?? r.taskCost ?? r.inferCost ?? null;
            console.log(`[${label}] ✅ Image ready after ${elapsed}s | cost: ${cost !== null ? '$' + cost : 'N/A'} | url: ${imgURL.slice(0, 80)}...`);
            return { ...r, imageURL: imgURL, cost };
          }
        }
        console.log(`[${label}] Image poll #${attempt} | no imageURL yet — keys present: ${responses.map(r => Object.keys(r).join(',')).join(' | ')}`);
      } else {
        console.log(`[${label}] Image poll #${attempt} | no result yet...`);
      }
    } catch (err) {
      const msg = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
      console.error(`[${label}] Image poll #${attempt} | ERROR:`, err);
      throw err instanceof Error ? err : new Error(msg);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out after ${MAX_WAIT_MS / 1000}s waiting for image.`);
}

/**
 * Submit an image inference task async then poll until imageURL arrives (convenience wrapper).
 */
export async function imageSubmitAndPoll(runware, payload, label, taskUUID) {
  await imageSubmit(runware, payload, label);
  return imagePoll(runware, taskUUID, label);
}

export async function submitAndPoll(runware, payload, label, taskUUID) {
  console.log(`\n[${label}] Submitting task ${taskUUID} (async, skipResponse, includeCost)...`);
  const { frameImages, ...loggablePayload } = payload;
  console.log(`[${label}] Payload:`, JSON.stringify(loggablePayload));
  const submitStart = Date.now();
  try {
    await runware.videoInference({ ...payload, includeCost: true, skipResponse: true });
  } catch (submitErr) {
    const submitErrMsg = submitErr?.message || (typeof submitErr === 'string' ? submitErr : JSON.stringify(submitErr));
    console.error(`[${label}] Submit failed (full):`, submitErr);
    throw new Error(`Submit failed: ${submitErrMsg}`);
  }
  console.log(`[${label}] Task submitted OK. Polling every ${POLL_INTERVAL_MS / 1000}s...`);

  let attempt = 0;
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    attempt++;
    const elapsed = ((Date.now() - submitStart) / 1000).toFixed(1);
    console.log(`[${label}] Poll #${attempt} | elapsed: ${elapsed}s | taskUUID: ${taskUUID}`);

    try {
      const responses = await runware.getResponse({ taskUUID });
      console.log(`[${label}] Poll #${attempt} | getResponse → ${responses?.length ?? 0} item(s)`);

      if (responses?.length) {
        for (const r of responses) {
          // Log the FULL raw response so every field is visible in console
          console.log(`[${label}] Poll #${attempt} | raw:`, JSON.stringify(r));
          if (r.error) throw new Error(`API error: ${JSON.stringify(r.error)}`);
          if (r.status === 'success' && r.videoURL) {
            const cost = r.cost ?? r.taskCost ?? r.inferCost ?? null;
            console.log(`[${label}] ✅ SUCCESS after ${elapsed}s | cost: ${cost !== null ? '$' + cost : 'not returned by API'} | URL: ${r.videoURL}`);
            return { ...r, cost };
          }
        }
        console.log(`[${label}] Poll #${attempt} | no videoURL yet — keys present: ${responses.map(r => Object.keys(r).join(',')).join(' | ')}`);
      } else {
        console.log(`[${label}] Poll #${attempt} | no result yet...`);
      }
    } catch (err) {
      const pollErrMsg = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
      console.error(`[${label}] Poll #${attempt} | ERROR (full):`, err);
      throw err instanceof Error ? err : new Error(pollErrMsg);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out after ${MAX_WAIT_MS / 1000}s waiting for video.`);
}

export async function checkOnce(runware, taskUUID, label) {
  console.log(`[${label}] Manual check for taskUUID: ${taskUUID}`);
  const responses = await runware.getResponse({ taskUUID });
  console.log(`[${label}] Manual check → ${responses?.length ?? 0} item(s)`);
  if (responses?.length) {
    for (const r of responses) {
      console.log(`[${label}] item:`, JSON.stringify({ status: r.status, videoURL: r.videoURL || null, error: r.error || null }));
      if (r.error) throw new Error(`API error: ${JSON.stringify(r.error)}`);
      if (r.status === 'success' && r.videoURL) return r;
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════
//  BATCH POLLER — single connection, one polling loop for N tasks
// ══════════════════════════════════════════════════════════════════

/**
 * Centralized poller that checks multiple tasks on a single Runware connection.
 * Instead of N connections each polling independently, one loop round-robins through
 * all registered taskUUIDs calling getResponse() for each.
 */
export class BatchPoller {
  /**
   * @param {object} runware - An already-connected Runware SDK instance
   * @param {object} opts
   * @param {number} opts.pollIntervalMs - Delay between full poll cycles (default 2000)
   * @param {number} opts.taskTimeoutMs - Per-task timeout (default 600000 = 10 min)
   */
  constructor(runware, { pollIntervalMs = 2000, taskTimeoutMs = MAX_WAIT_MS } = {}) {
    this._runware = runware;
    this._pollIntervalMs = pollIntervalMs;
    this._taskTimeoutMs = taskTimeoutMs;
    this._pending = new Map(); // taskUUID → { type, label, registeredAt, resolve, reject, promise }
    this._running = false;
    this._destroyed = false;
    this._cycle = 0;
  }

  /**
   * Register a task for polling.
   * @param {string} taskUUID
   * @param {'image'|'video'} type
   * @param {string} label - Logging label
   * @returns {Promise<object>} Resolves with the result when the task completes
   */
  register(taskUUID, type, label) {
    if (this._destroyed) throw new Error('BatchPoller has been destroyed');
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    this._pending.set(taskUUID, { type, label, registeredAt: Date.now(), resolve, reject, promise });
    console.log(`[BatchPoller] Registered ${label} | taskUUID: ${taskUUID} | type: ${type} | pending: ${this._pending.size}`);
    if (!this._running) this._startLoop();
    return promise;
  }

  /** Stop the loop and reject all pending tasks. */
  destroy() {
    this._destroyed = true;
    this._running = false;
    for (const [uuid, entry] of this._pending) {
      entry.reject(new Error(`BatchPoller destroyed while ${entry.label} was pending`));
    }
    this._pending.clear();
  }

  get pendingCount() { return this._pending.size; }

  async _startLoop() {
    if (this._running) return;
    this._running = true;
    console.log('[BatchPoller] Polling loop started');

    while (this._running && this._pending.size > 0) {
      this._cycle++;
      const ids = [...this._pending.keys()];
      console.log(`[BatchPoller] ── Cycle #${this._cycle} | checking ${ids.length} task(s) ──`);

      for (const taskUUID of ids) {
        if (this._destroyed) return;
        const entry = this._pending.get(taskUUID);
        if (!entry) continue;

        // Check timeout
        const elapsed = (Date.now() - entry.registeredAt) / 1000;
        if (Date.now() - entry.registeredAt > this._taskTimeoutMs) {
          console.error(`[BatchPoller] ${entry.label} | TIMEOUT after ${elapsed.toFixed(1)}s`);
          entry.reject(new Error(`Timed out after ${this._taskTimeoutMs / 1000}s waiting for ${entry.type}`));
          this._pending.delete(taskUUID);
          continue;
        }

        try {
          const responses = await this._runware.getResponse({ taskUUID });
          if (!responses?.length) continue;

          for (const r of responses) {
            if (r.error) {
              console.error(`[BatchPoller] ${entry.label} | API error: ${JSON.stringify(r.error)}`);
              entry.reject(new Error(`API error: ${JSON.stringify(r.error)}`));
              this._pending.delete(taskUUID);
              break;
            }

            const result = entry.type === 'image'
              ? this._checkImageResult(r)
              : this._checkVideoResult(r);

            if (result) {
              console.log(`[BatchPoller] ✅ ${entry.label} | completed after ${elapsed.toFixed(1)}s | cost: ${result.cost !== null ? '$' + result.cost : 'N/A'}`);
              entry.resolve(result);
              this._pending.delete(taskUUID);
              break;
            }
          }
        } catch (err) {
          console.error(`[BatchPoller] ${entry.label} | poll error:`, err?.message || err);
          entry.reject(err instanceof Error ? err : new Error(String(err)));
          this._pending.delete(taskUUID);
        }
      }

      if (this._pending.size > 0 && this._running) {
        await new Promise(r => setTimeout(r, this._pollIntervalMs));
      }
    }

    this._running = false;
    console.log('[BatchPoller] Polling loop ended');
  }

  _checkImageResult(r) {
    const imgURL = r.imageURL || r.url || r.outputURL;
    if (imgURL) {
      const cost = r.cost ?? r.taskCost ?? r.inferCost ?? null;
      return { ...r, imageURL: imgURL, cost };
    }
    return null;
  }

  _checkVideoResult(r) {
    if (r.status === 'success' && r.videoURL) {
      const cost = r.cost ?? r.taskCost ?? r.inferCost ?? null;
      return { ...r, cost };
    }
    return null;
  }
}

/**
 * Single-shot check for an image task result on an existing connection.
 * Used by recheck-generating to probe image tasks.
 */
export async function checkImageOnce(runware, taskUUID, label) {
  console.log(`[${label}] Image check for taskUUID: ${taskUUID}`);
  const responses = await runware.getResponse({ taskUUID });
  if (responses?.length) {
    for (const r of responses) {
      if (r.error) throw new Error(`API error: ${JSON.stringify(r.error)}`);
      const imgURL = r.imageURL || r.url || r.outputURL;
      if (imgURL) {
        const cost = r.cost ?? r.taskCost ?? r.inferCost ?? null;
        return { ...r, imageURL: imgURL, cost };
      }
    }
  }
  return null;
}
