// ── LipSync Tab ─────────────────────────────────────────────────────────────
// POST /api/generate-lipsync
// Supports: pixverse:lipsync@1 and sync:lipsync-2-pro@1
// After generation: extracts last frame + generates CTA image via Nano Bana 2

import { Router } from 'express';
import { Runware } from '@runware/sdk-js';
import { randomUUID } from 'crypto';
import { unlink, mkdir } from 'fs/promises';
import { createWriteStream } from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';

import { upload } from '../lib/multer.js';
import { LIPSYNC_MODELS } from '../lib/models.js';
import { fileToDataURI, getMimeType, downloadVideo } from '../lib/helpers.js';
import { extractLastFrame } from '../lib/ffmpeg.js';
import { submitAndPoll } from '../lib/runware.js';
import { addHistoryEntry, updateHistoryEntry } from '../lib/history.js';

const router = Router();
const API_KEY = process.env.RUNWARE_API_KEY;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

router.post('/api/generate-lipsync', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'audio', maxCount: 1 },
]), async (req, res) => {
  const videoFile = req.files?.video?.[0];
  const audioFile = req.files?.audio?.[0];
  const model = req.body.model || 'pixverse:lipsync@1';
  const modelInfo = LIPSYNC_MODELS[model] || { label: model, provider: 'Unknown' };

  if (!videoFile || !audioFile) {
    return res.status(400).json({ error: 'Both a video and audio file are required.' });
  }

  console.log(`\n[LipSync] ── New Request ──────────────────────`);
  console.log(`[LipSync]  Model : ${model} (${modelInfo.label})`);
  console.log(`[LipSync]  Video : ${videoFile.originalname} (${(videoFile.size / 1024).toFixed(1)} KB)`);
  console.log(`[LipSync]  Audio : ${audioFile.originalname} (${(audioFile.size / 1024).toFixed(1)} KB)`);

  const taskUUID = randomUUID();

  addHistoryEntry({
    taskUUID,
    type: 'lipsync',
    model,
    modelLabel: modelInfo.label,
    provider: modelInfo.provider,
    videoName: videoFile.originalname,
    audioName: audioFile.originalname,
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

  console.log(`[LipSync]  taskUUID: ${taskUUID} → added to history as PENDING`);
  res.json({ success: true, taskUUID, status: 'pending', message: 'Task submitted. Use taskUUID to check status.' });

  const runware = new Runware({ apiKey: API_KEY });
  (async () => {
    try {
      await runware.ensureConnection();
      console.log(`[LipSync] Connected to Runware WebSocket`);

      const videoDataURI = fileToDataURI(videoFile.path, 'video/mp4');
      const audioDataURI = fileToDataURI(audioFile.path, getMimeType(audioFile.path));
      console.log(`[LipSync] Video encoded: ${(videoDataURI.length / 1024).toFixed(1)} KB`);
      console.log(`[LipSync] Audio encoded: ${(audioDataURI.length / 1024).toFixed(1)} KB`);

      const isSync = model.startsWith('sync:');
      const requestPayload = {
        taskUUID,
        model,
        outputFormat: 'mp4',
        ...(isSync
          ? { inputs: { video: videoDataURI, audio: [{ id: 'audio-input', source: audioDataURI }] } }
          : { numberResults: 1, referenceVideos: [videoDataURI], inputAudios: [audioDataURI] }
        ),
      };

      const result = await submitAndPoll(runware, requestPayload, 'LipSync', taskUUID);

      const filename = `lipsync_${Date.now()}.mp4`;
      const outputPath = path.join('output', filename);
      await downloadVideo(result.videoURL, outputPath);
      console.log(`[LipSync] ✅ Download complete: ${outputPath}`);

      const resolvedCost = result.cost ?? null;

      // ── CTA Frame Generation (non-fatal) ────────────────────────────────
      const ctaDir = path.join('output', 'cta_frames', taskUUID);
      await mkdir(ctaDir, { recursive: true });
      const lastFramePath = path.join(ctaDir, 'last_frame.jpg');

      try {
        console.log(`[LipSync] Extracting last frame...`);
        await extractLastFrame(outputPath, lastFramePath);
        console.log(`[LipSync] Last frame saved → ${lastFramePath}`);

        const refImagePath = path.join(__dirname, '..', 'public', 'reference.jpg');
        const lastFrameDataURI = fileToDataURI(lastFramePath, 'image/jpeg');
        const refDataURI = fileToDataURI(refImagePath, 'image/jpeg');
        console.log(`[LipSync] Generating CTA image with Nano Bana 2...`);

        const ctaImages = await runware.imageInference({
          taskUUID: randomUUID(),
          model: 'google:4@3',
          positivePrompt: 'Take the first reference image as the base photo. Overlay the exact logo and CTA button from the second reference image onto the base photo. Preserve the logo design, colors, and text exactly as shown in the second reference — do not alter, recreate, or replace the logo. Place the logo in the top or bottom area of the image. Maintain a professional marketing look.',
          inputs: { referenceImages: [lastFrameDataURI, refDataURI] },
          width: 3072,
          height: 5504,
          numberResults: 1,
          includeCost: true,
          outputType: ['URL'],
        });

        if (ctaImages?.length && ctaImages[0].imageURL) {
          const ctaImagePath = path.join(ctaDir, 'cta_frame.jpg');
          await new Promise((resolve, reject) => {
            const protocol = ctaImages[0].imageURL.startsWith('https') ? https : http;
            protocol.get(ctaImages[0].imageURL, (res2) => {
              const file = createWriteStream(ctaImagePath);
              res2.pipe(file);
              file.on('finish', () => { file.close(); resolve(); });
              file.on('error', reject);
            }).on('error', reject);
          });
          console.log(`[LipSync] ✅ CTA image saved → ${ctaImagePath}`);
          updateHistoryEntry(taskUUID, {
            ctaFramesDir: `/output/cta_frames/${taskUUID}`,
            ctaImageUrl: `/output/cta_frames/${taskUUID}/cta_frame.jpg`,
            lastFrameUrl: `/output/cta_frames/${taskUUID}/last_frame.jpg`,
          });
        } else {
          console.log(`[LipSync] ⚠ CTA image generation returned no result`);
        }
      } catch (ctaErr) {
        console.error(`[LipSync] ⚠ CTA image generation failed (non-fatal):`, ctaErr?.message || ctaErr);
      }
      // ────────────────────────────────────────────────────────────────────

      updateHistoryEntry(taskUUID, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        videoUrl: `/output/${filename}`,
        videoURL: result.videoURL,
        filename,
        cost: resolvedCost,
        costSource: resolvedCost !== null ? 'api' : null,
      });
      console.log(`[LipSync] History updated → COMPLETED`);

    } catch (err) {
      const errMsg = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
      console.error(`[LipSync] ❌ ERROR (full):`, err);
      console.error(`[LipSync] ❌ ERROR: ${errMsg}`);
      updateHistoryEntry(taskUUID, { status: 'failed', error: errMsg, completedAt: new Date().toISOString() });
    } finally {
      runware.disconnect();
      await unlink(videoFile.path).catch(() => {});
      await unlink(audioFile.path).catch(() => {});
    }
  })();
});

export default router;
