// ── Text-to-Video Tab (Google Veo) ──────────────────────────────────────────
// POST /api/generate-veo

import { Router } from 'express';
import { Runware } from '@runware/sdk-js';
import { randomUUID } from 'crypto';
import path from 'path';

import { submitAndPoll } from '../lib/runware.js';
import { downloadVideo } from '../lib/helpers.js';
import { addHistoryEntry, updateHistoryEntry } from '../lib/history.js';

const router = Router();
const API_KEY = process.env.RUNWARE_API_KEY;

router.post('/api/generate-veo', async (req, res) => {
  const { prompt, duration = 7, width = 1280, height = 720, model = 'google/veo-3.1' } = req.body;

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

  const runware = new Runware({ apiKey: API_KEY });
  (async () => {
    try {
      await runware.ensureConnection();
      console.log(`[Veo] Connected to Runware WebSocket`);

      const requestPayload = {
        taskUUID,
        model,
        positivePrompt: prompt.trim(),
        duration: parseInt(duration),
        width: parseInt(width),
        height: parseInt(height),
        outputFormat: 'mp4',
        numberResults: 1,
      };

      const result = await submitAndPoll(runware, requestPayload, 'Veo', taskUUID);

      const filename = `veo_${Date.now()}.mp4`;
      const outputPath = path.join('output', filename);
      await downloadVideo(result.videoURL, outputPath);
      console.log(`[Veo] ✅ Download complete: ${outputPath}`);

      const resolvedCost = result.cost ?? null;
      updateHistoryEntry(taskUUID, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        videoUrl: `/output/${filename}`,
        videoURL: result.videoURL,
        filename,
        cost: resolvedCost,
        costSource: resolvedCost !== null ? 'api' : null,
      });
      console.log(`[Veo] History updated → COMPLETED`);

    } catch (err) {
      console.error(`[Veo] ❌ ERROR: ${err.message}`);
      updateHistoryEntry(taskUUID, { status: 'failed', error: err.message, completedAt: new Date().toISOString() });
    } finally {
      runware.disconnect();
    }
  })();
});

export default router;
