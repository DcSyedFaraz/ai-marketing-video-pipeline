// ── History Tab + Gallery + Manual Check ─────────────────────────────────────
// POST /api/check/:taskUUID  — register pending task with global poller
// GET  /api/history          — list all history entries
// DELETE /api/history/:uuid  — remove a history entry
// GET  /api/videos           — list output MP4 files (gallery)
// DELETE /api/videos/:file   — delete a video file

import { Router } from 'express';
import { readdir, unlink } from 'fs/promises';
import path from 'path';

import { loadHistory, saveHistory, updateHistoryEntry } from '../lib/history.js';
import { globalPoller, makeVideoCompleteHandler, makeErrorHandler } from '../lib/globalPoller.js';

const router = Router();

// Manual check — register task with global poller (result arrives via SSE)
router.post('/api/check/:taskUUID', async (req, res) => {
  const { taskUUID } = req.params;
  const history = loadHistory();
  const entry = history.find(h => h.taskUUID === taskUUID);

  if (!entry) return res.status(404).json({ error: 'Task not found in history.' });
  if (entry.status === 'completed') return res.json({ status: 'completed', entry });

  // Already registered — avoid duplicate
  if (globalPoller.has(taskUUID)) {
    return res.json({ status: 'checking', message: 'Already being polled by global poller. Watch SSE for completion.' });
  }

  // If task previously failed, reset to pending so poller re-checks it
  const wasRetried = entry.status === 'failed';
  if (wasRetried) {
    updateHistoryEntry(taskUUID, { status: 'pending', error: null });
  }

  // Register with global poller — completion fires SSE event
  globalPoller.register(taskUUID, {
    type: 'video',
    label: `Check-${entry.type}-${taskUUID.slice(0, 8)}`,
    onComplete: makeVideoCompleteHandler(taskUUID, entry.type),
    onError: makeErrorHandler(taskUUID, entry.type),
  });

  const status = wasRetried ? 'rechecking' : 'checking';
  res.json({ status, message: wasRetried
    ? 'Failed task re-registered with global poller. Watch SSE for completion.'
    : 'Task registered with global poller. Watch SSE /api/events for completion.' });
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

// ── GET /api/podcaster-images ────────────────────────────────────────────────
// Lists AI-generated podcaster portrait images from output/podcaster_imgs/
router.get('/api/podcaster-images', async (req, res) => {
  try {
    const dir = path.join('output', 'podcaster_imgs');
    const files = await readdir(dir);
    const images = files
      .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
      .map(f => ({ filename: f, url: `/output/podcaster_imgs/${f}` }))
      .sort((a, b) => b.filename.localeCompare(a.filename));
    res.json({ images });
  } catch {
    res.json({ images: [] });
  }
});

export default router;
