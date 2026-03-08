// ── Avatar Tab ──────────────────────────────────────────────────────────────
// POST /api/generate-avatar
// POST /api/models (list avatar models)

import { Router } from 'express';
import { Runware } from '@runware/sdk-js';
import { randomUUID } from 'crypto';
import { unlink } from 'fs/promises';
import path from 'path';

import { upload } from '../lib/multer.js';
import { AVATAR_MODELS } from '../lib/models.js';
import { fileToDataURI, getMimeType, downloadVideo } from '../lib/helpers.js';
import { submitAndPoll } from '../lib/runware.js';
import { addHistoryEntry, updateHistoryEntry } from '../lib/history.js';

const router = Router();
const API_KEY = process.env.RUNWARE_API_KEY;

router.get('/api/models', (req, res) => {
  res.json({ models: AVATAR_MODELS });
});

router.post('/api/generate-avatar', upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'audio', maxCount: 1 },
]), async (req, res) => {
  const imageFile = req.files?.image?.[0];
  const audioFile = req.files?.audio?.[0];
  const prompt = (req.body.prompt || '').trim().slice(0, 2500);
  const model = req.body.model || 'klingai:avatar@2.0-pro';
  const modelInfo = AVATAR_MODELS.find(m => m.id === model) || { label: model, provider: 'Unknown' };

  if (!imageFile || !audioFile) {
    return res.status(400).json({ error: 'Both image and audio files are required.' });
  }

  console.log(`\n[Avatar] ── New Request ──────────────────────`);
  console.log(`[Avatar]  Model  : ${model}`);
  console.log(`[Avatar]  Image  : ${imageFile.originalname} (${(imageFile.size / 1024).toFixed(1)} KB)`);
  console.log(`[Avatar]  Audio  : ${audioFile.originalname} (${(audioFile.size / 1024).toFixed(1)} KB)`);
  console.log(`[Avatar]  Prompt : ${prompt || '(none)'}`);

  const taskUUID = randomUUID();

  addHistoryEntry({
    taskUUID,
    type: 'avatar',
    model,
    modelLabel: modelInfo.label,
    provider: modelInfo.provider,
    prompt: prompt || null,
    imageName: imageFile.originalname,
    audioName: audioFile.originalname,
    audioSize: audioFile.size,
    status: 'pending',
    submittedAt: new Date().toISOString(),
    completedAt: null,
    videoUrl: null,
    videoURL: null,
    filename: null,
    cost: null,
    error: null,
  });

  console.log(`[Avatar]  taskUUID: ${taskUUID} → added to history as PENDING`);
  res.json({ success: true, taskUUID, status: 'pending', message: 'Task submitted. Use taskUUID to check status.' });

  const runware = new Runware({ apiKey: API_KEY });
  (async () => {
    try {
      await runware.ensureConnection();
      console.log(`[Avatar] Connected to Runware WebSocket`);

      const imageDataURI = fileToDataURI(imageFile.path, getMimeType(imageFile.path));
      const audioDataURI = fileToDataURI(audioFile.path, getMimeType(audioFile.path));
      console.log(`[Avatar] Image encoded: ${(imageDataURI.length / 1024).toFixed(1)} KB`);
      console.log(`[Avatar] Audio encoded: ${(audioDataURI.length / 1024).toFixed(1)} KB`);

      const requestPayload = {
        taskUUID,
        model,
        outputFormat: 'mp4',
        numberResults: 1,
        inputs: { image: imageDataURI, audio: audioDataURI },
      };
      if (prompt) requestPayload.positivePrompt = prompt;

      const result = await submitAndPoll(runware, requestPayload, 'Avatar', taskUUID);

      const filename = `avatar_${Date.now()}.mp4`;
      const outputPath = path.join('output', filename);
      await downloadVideo(result.videoURL, outputPath);
      console.log(`[Avatar] ✅ Download complete: ${outputPath}`);

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
      console.log(`[Avatar] History updated → COMPLETED`);

    } catch (err) {
      console.error(`[Avatar] ❌ ERROR: ${err.message}`);
      updateHistoryEntry(taskUUID, { status: 'failed', error: err.message, completedAt: new Date().toISOString() });
    } finally {
      runware.disconnect();
      await unlink(imageFile.path).catch(() => {});
      await unlink(audioFile.path).catch(() => {});
    }
  })();
});

export default router;
