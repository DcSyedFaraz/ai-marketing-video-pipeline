// ── Text-to-Video Tab (Google Veo) ──────────────────────────────────────────
// POST /api/generate-veo

import { Router } from 'express';
import { randomUUID } from 'crypto';
import path from 'path';

import { downloadVideo } from '../lib/helpers.js';
import { addHistoryEntry, updateHistoryEntry } from '../lib/history.js';
import { globalPoller, sseEmitter } from '../lib/globalPoller.js';

const router = Router();

router.post('/api/generate-veo', async (req, res) => {
  const { prompt, duration = 7, width = 1280, height = 720, model = 'google:3@2' } = req.body;

  if (!prompt?.trim()) return res.status(400).json({ error: 'A prompt is required.' });

  console.log(`\n[Veo] ── New Request ────────────────────────`);
  console.log(`[Veo]  Prompt   : ${prompt}`);
  console.log(`[Veo]  Model    : ${model}`);
  console.log(`[Veo]  Duration : ${duration}s  Size: ${width}x${height}`);

  const taskUUID = randomUUID();

  addHistoryEntry({
    taskUUID,
    type: 'veo',
    model,
    modelLabel: model === 'google:3@3' ? 'Google Veo 3.1 Fast' : 'Google Veo 3.1',
    provider: 'Google',
    prompt,
    status: 'pending',
    submittedAt: new Date().toISOString(),
    completedAt: null,
    videoUrl: null,
    videoURL: null,
    filename: null,
    cost: null,
    error: null,
    duration: parseInt(duration),
    width: parseInt(width),
    height: parseInt(height),
  });

  console.log(`[Veo]  taskUUID: ${taskUUID} → added to history as PENDING`);
  res.json({ success: true, taskUUID, status: 'pending', message: 'Task submitted. Use taskUUID to check status.' });

  // Submit via shared global connection
  const requestPayload = {
    taskUUID,
    model,
    positivePrompt: prompt.trim(),
    duration: parseInt(duration),
    width: parseInt(width),
    height: parseInt(height),
    outputFormat: 'mp4',
    numberResults: 1,
    includeCost: true,
  };

  try {
    console.log(`[Veo] Submitting task ${taskUUID} via global connection (skipResponse)...`);
    await globalPoller.getConnection().videoInference({ ...requestPayload, skipResponse: true });
    console.log(`[Veo] Task submitted OK. Registered with global poller.`);
  } catch (submitErr) {
    const errMsg = submitErr?.message || String(submitErr);
    console.error(`[Veo] ❌ Submit failed: ${errMsg}`);
    updateHistoryEntry(taskUUID, { status: 'failed', error: errMsg, completedAt: new Date().toISOString() });
    sseEmitter.emit('task-complete', { taskUUID, type: 'veo', status: 'failed', error: errMsg });
    return;
  }

  globalPoller.register(taskUUID, {
    type: 'video',
    label: 'Veo',
    onComplete: async (result) => {
      const filename = `veo_${Date.now()}.mp4`;
      const outputPath = path.join('output', filename);
      await downloadVideo(result.videoURL, outputPath);
      console.log(`[Veo] ✅ Download complete: ${outputPath}`);

      const updated = updateHistoryEntry(taskUUID, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        videoUrl: `/output/${filename}`,
        videoURL: result.videoURL,
        filename,
        cost: result.cost ?? null,
        costSource: result.cost != null ? 'api' : null,
      });
      console.log(`[Veo] History updated → COMPLETED`);

      sseEmitter.emit('task-complete', {
        taskUUID,
        type: 'veo',
        status: 'completed',
        videoUrl: `/output/${filename}`,
        entry: updated,
      });
    },
    onError: async (err) => {
      const errMsg = err?.message || String(err);
      console.error(`[Veo] ❌ ERROR: ${errMsg}`);
      updateHistoryEntry(taskUUID, { status: 'failed', error: errMsg, completedAt: new Date().toISOString() });
      sseEmitter.emit('task-complete', { taskUUID, type: 'veo', status: 'failed', error: errMsg });
    },
  });
});

export default router;
