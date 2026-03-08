// ── CTA Bridge Tab ──────────────────────────────────────────────────────────
// POST /api/generate-bridge
// Extracts last frame from video, generates bridge video using Runware,
// then concatenates original video + bridge video into final output.

import { Router } from 'express';
import { Runware } from '@runware/sdk-js';
import { randomUUID } from 'crypto';
import { unlink } from 'fs/promises';
import path from 'path';

import { uploadBridge } from '../lib/multer.js';
import { AVATAR_MODELS } from '../lib/models.js';
import { fileToDataURI, getMimeType, downloadVideo } from '../lib/helpers.js';
import { extractLastFrame, concatVideos } from '../lib/ffmpeg.js';
import { submitAndPoll } from '../lib/runware.js';
import { addHistoryEntry, updateHistoryEntry } from '../lib/history.js';

const router = Router();
const API_KEY = process.env.RUNWARE_API_KEY;

router.post('/api/generate-bridge', uploadBridge.fields([
  { name: 'video', maxCount: 1 },
  { name: 'ctaImage', maxCount: 1 },
]), async (req, res) => {
  const videoFile = req.files?.video?.[0];
  const ctaFile = req.files?.ctaImage?.[0];
  const prompt = (req.body.prompt || '').trim().slice(0, 2500);
  const model = req.body.model || 'google/veo-3.1';
  const bridgeDuration = parseInt(req.body.duration || '7');

  const modelInfo = AVATAR_MODELS.find(m => m.id === model);
  const modelLabel = modelInfo?.label || (model.includes('veo') ? (model.includes('fast') ? 'Google Veo 3.1 Fast' : 'Google Veo 3.1') : model);
  const provider = modelInfo?.provider || (model.includes('google') ? 'Google' : 'Unknown');

  if (!videoFile || !ctaFile) {
    return res.status(400).json({ error: 'Both a video file and CTA image are required.' });
  }

  console.log(`\n[Bridge] ── New Request ──────────────────────`);
  console.log(`[Bridge]  Model    : ${model}`);
  console.log(`[Bridge]  Video    : ${videoFile.originalname} (${(videoFile.size / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`[Bridge]  CTA Image: ${ctaFile.originalname} (${(ctaFile.size / 1024).toFixed(1)} KB)`);
  console.log(`[Bridge]  Prompt   : ${prompt || '(none)'}`);
  console.log(`[Bridge]  Duration : ${bridgeDuration}s`);

  const taskUUID = randomUUID();

  addHistoryEntry({
    taskUUID,
    type: 'bridge',
    model,
    modelLabel,
    provider,
    prompt: prompt || null,
    videoName: videoFile.originalname,
    ctaImageName: ctaFile.originalname,
    status: 'pending',
    submittedAt: new Date().toISOString(),
    completedAt: null,
    videoUrl: null,
    videoURL: null,
    filename: null,
    cost: null,
    costSource: null,
    error: null,
  });

  console.log(`[Bridge]  taskUUID: ${taskUUID} → added to history as PENDING`);
  res.json({ success: true, taskUUID, status: 'pending', message: 'Task submitted. Use taskUUID to check status.' });

  const runware = new Runware({ apiKey: API_KEY });
  (async () => {
    const frameJpg = path.join('uploads', `frame_${Date.now()}.jpg`);
    const bridgeGenerated = path.join('output', `bridge_gen_${Date.now()}.mp4`);
    const bridgeFinal = path.join('output', `bridge_final_${Date.now()}.mp4`);

    try {
      await runware.ensureConnection();
      console.log(`[Bridge] Connected to Runware WebSocket`);

      // Step 1: Extract last frame from uploaded video
      console.log(`[Bridge] Extracting last frame from: ${videoFile.path}`);
      await extractLastFrame(videoFile.path, frameJpg);
      console.log(`[Bridge] Last frame extracted → ${frameJpg}`);

      // Step 2: Encode both images to data URIs
      const firstFrameDataURI = fileToDataURI(frameJpg, 'image/jpeg');
      const ctaDataURI = fileToDataURI(ctaFile.path, getMimeType(ctaFile.path));
      console.log(`[Bridge] First frame: ${(firstFrameDataURI.length / 1024).toFixed(1)} KB | CTA: ${(ctaDataURI.length / 1024).toFixed(1)} KB`);

      // Step 3: Submit bridge generation
      const requestPayload = {
        taskUUID,
        model,
        positivePrompt: (prompt ? prompt + '. ' : '') + 'Smooth cinematic transition from first frame to last frame. No person talking, no lip movement, no human speech, no facial animation. Only visual transition, zoom, pan, or motion graphics moving toward the final CTA frame.',
        duration: bridgeDuration,
        outputFormat: 'mp4',
        numberResults: 1,
        frameImages: [
          { inputImage: firstFrameDataURI },
          { inputImage: ctaDataURI },
        ],
      };

      console.log(`[Bridge] Submitting bridge generation request...`);
      const result = await submitAndPoll(runware, requestPayload, 'Bridge', taskUUID);

      // Step 4: Download generated bridge video
      console.log(`[Bridge] Downloading generated bridge → ${bridgeGenerated}`);
      await downloadVideo(result.videoURL, bridgeGenerated);
      console.log(`[Bridge] ✅ Bridge video downloaded`);

      // Step 5: Concatenate original + bridge
      console.log(`[Bridge] Concatenating: ${videoFile.path} + ${bridgeGenerated} → ${bridgeFinal}`);
      await concatVideos(videoFile.path, bridgeGenerated, bridgeFinal);
      console.log(`[Bridge] ✅ Concatenation complete`);

      const filename = path.basename(bridgeFinal);
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
      console.log(`[Bridge] History updated → COMPLETED`);

    } catch (err) {
      const errMsg = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
      console.error(`[Bridge] ❌ ERROR (full):`, err);
      console.error(`[Bridge] ❌ ERROR: ${errMsg}`);
      updateHistoryEntry(taskUUID, { status: 'failed', error: errMsg, completedAt: new Date().toISOString() });
    } finally {
      runware.disconnect();
      await unlink(videoFile.path).catch(() => {});
      await unlink(ctaFile.path).catch(() => {});
    }
  })();
});

export default router;
