// ── History Tab + Gallery + Manual Check ─────────────────────────────────────
// POST /api/check/:taskUUID  — manually poll a pending task
// GET  /api/history          — list all history entries
// DELETE /api/history/:uuid  — remove a history entry
// GET  /api/videos           — list output MP4 files (gallery)
// DELETE /api/videos/:file   — delete a video file

import { Router } from 'express';
import { Runware } from '@runware/sdk-js';
import { readdir, unlink } from 'fs/promises';
import path from 'path';

import { checkOnce } from '../lib/runware.js';
import { downloadVideo } from '../lib/helpers.js';
import { loadHistory, saveHistory, updateHistoryEntry } from '../lib/history.js';

const router = Router();
const API_KEY = process.env.RUNWARE_API_KEY;

// Manual check for a pending task
router.post('/api/check/:taskUUID', async (req, res) => {
  const { taskUUID } = req.params;
  const history = loadHistory();
  const entry = history.find(h => h.taskUUID === taskUUID);

  if (!entry) return res.status(404).json({ error: 'Task not found in history.' });
  if (entry.status === 'completed') return res.json({ status: 'completed', entry });
  if (entry.status === 'failed') return res.json({ status: 'failed', entry });

  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };

  log(`[Check] Manual check for taskUUID: ${taskUUID}`);
  log(`[Check] Type: ${entry.type} | Model: ${entry.modelLabel || entry.model}`);

  const runware = new Runware({ apiKey: API_KEY });
  try {
    await runware.ensureConnection();
    log(`[Check] Connected to Runware WebSocket`);

    const result = await checkOnce(runware, taskUUID, 'Check');

    if (!result) {
      log(`[Check] Status: still processing / not ready yet`);
      return res.json({ status: 'pending', entry, logs });
    }

    log(`[Check] ✅ Result ready! videoURL: ${result.videoURL}`);

    const typeMap = { avatar: 'avatar', veo: 'veo', bridge: 'bridge_final', lipsync: 'lipsync' };
    const prefix = typeMap[entry.type] || entry.type || 'video';
    const filename = `${prefix}_${Date.now()}.mp4`;
    const outputPath = path.join('output', filename);
    log(`[Check] Downloading → ${outputPath}`);
    await downloadVideo(result.videoURL, outputPath);
    log(`[Check] ✅ Download complete: ${filename}`);

    const resolvedCost = result.cost ?? null;
    log(`[Check] Cost: ${resolvedCost !== null ? '$' + resolvedCost : 'not returned by API'}`);

    const updated = updateHistoryEntry(taskUUID, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      videoUrl: `/output/${filename}`,
      videoURL: result.videoURL,
      filename,
      cost: resolvedCost,
      costSource: resolvedCost !== null ? 'api' : null,
    });

    res.json({ status: 'completed', entry: updated, logs });

  } catch (err) {
    const errMsg = err?.message || JSON.stringify(err);
    log(`[Check] ❌ ERROR: ${errMsg}`);
    console.error(`[Check] ERROR (full):`, err);
    const updated = updateHistoryEntry(taskUUID, { status: 'failed', error: errMsg });
    res.status(500).json({ status: 'failed', error: errMsg, entry: updated, logs });
  } finally {
    runware.disconnect();
  }
});

// Get full history
router.get('/api/history', (req, res) => {
  res.json({ history: loadHistory() });
});

// Remove a history entry
router.delete('/api/history/:taskUUID', (req, res) => {
  const { taskUUID } = req.params;
  const history = loadHistory().filter(h => h.taskUUID !== taskUUID);
  saveHistory(history);
  res.json({ success: true });
});

// List output MP4s (gallery)
router.get('/api/videos', async (req, res) => {
  try {
    const files = await readdir('output');
    const videos = files
      .filter(f => f.endsWith('.mp4'))
      .map(f => ({
        filename: f,
        url: `/output/${f}`,
        type: f.startsWith('avatar_') ? 'avatar' : f.startsWith('lipsync_') ? 'lipsync' : f.startsWith('bridge_') || f.startsWith('combined_') ? 'bridge' : 'veo',
        created: f.split('_')[1]?.replace('.mp4', '') || '0',
      }))
      .sort((a, b) => parseInt(b.created) - parseInt(a.created));
    res.json({ videos });
  } catch {
    res.json({ videos: [] });
  }
});

// Delete a video file
router.delete('/api/videos/:filename', async (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9_.-]/g, '');
  try {
    await unlink(path.join('output', filename));
    res.json({ success: true });
  } catch {
    res.status(404).json({ error: 'File not found.' });
  }
});

export default router;
