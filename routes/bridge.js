// ── CTA Bridge Tab ──────────────────────────────────────────────────────────
// POST /api/generate-bridge
// Extracts last frame from video, generates bridge video using Runware,
// then concatenates original video + bridge video into final output.

import { Router } from 'express';
import { Runware } from '@runware/sdk-js';
import { randomUUID } from 'crypto';
import { unlink, mkdir, access } from 'fs/promises';
import { readFileSync, createWriteStream } from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';

import { uploadBridge } from '../lib/multer.js';
import { AVATAR_MODELS } from '../lib/models.js';
import { fileToDataURI, getMimeType, downloadVideo } from '../lib/helpers.js';
import { extractLastFrame, concatVideos } from '../lib/ffmpeg.js';
import { imageSubmitAndPollOwn, submitAndPoll } from '../lib/runware.js';
import { addHistoryEntry, updateHistoryEntry } from '../lib/history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = Router();
const API_KEY = process.env.RUNWARE_API_KEY;

router.post('/api/generate-bridge', uploadBridge.fields([
  { name: 'video', maxCount: 1 },
  { name: 'ctaImage', maxCount: 1 },
]), async (req, res) => {
  const videoFile = req.files?.video?.[0];
  const ctaFile = req.files?.ctaImage?.[0];
  const prompt = (req.body.prompt || '').trim().slice(0, 2500);
  const model = req.body.model || 'google:3@2';
  const bridgeDuration = parseInt(req.body.duration || '7');
  const videoPath = (req.body.videoPath || '').trim(); // server-side path for podcast videos

  const modelInfo = AVATAR_MODELS.find(m => m.id === model);
  const modelLabel = modelInfo?.label || (model.includes('veo') ? (model.includes('fast') ? 'Google Veo 3.1 Fast' : 'Google Veo 3.1') : model);
  const provider = modelInfo?.provider || (model.includes('google') ? 'Google' : 'Unknown');

  // Resolve video source: uploaded file OR server-side path
  let resolvedVideoPath = videoFile?.path || null;
  let resolvedVideoName = videoFile?.originalname || path.basename(videoPath) || 'video.mp4';
  let resolvedVideoSize = videoFile?.size || null;
  const isServerPath = !videoFile && !!videoPath;

  if (isServerPath) {
    // Validate the path is within the output directory (security check)
    const absPath = path.resolve(videoPath);
    const outputDir = path.resolve('output');
    if (!absPath.startsWith(outputDir)) {
      return res.status(400).json({ error: 'Invalid videoPath: must be within the output directory.' });
    }
    try { await access(absPath); } catch {
      return res.status(400).json({ error: 'videoPath file not found on server.' });
    }
    resolvedVideoPath = absPath;
  }

  if (!resolvedVideoPath || !ctaFile) {
    return res.status(400).json({ error: 'Both a video source (file or videoPath) and CTA image are required.' });
  }

  console.log(`\n[Bridge] ── New Request ──────────────────────`);
  console.log(`[Bridge]  Model    : ${model}`);
  console.log(`[Bridge]  Video    : ${resolvedVideoName}${resolvedVideoSize ? ` (${(resolvedVideoSize / 1024 / 1024).toFixed(1)} MB)` : ' (server path)'}`);
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
    videoName: resolvedVideoName,
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

      // Step 1: Extract last frame from video
      console.log(`[Bridge] Extracting last frame from: ${resolvedVideoPath}`);
      await extractLastFrame(resolvedVideoPath, frameJpg);
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
      console.log(`[Bridge] Concatenating: ${resolvedVideoPath} + ${bridgeGenerated} → ${bridgeFinal}`);
      await concatVideos(resolvedVideoPath, bridgeGenerated, bridgeFinal);
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
      // Only delete if it was an uploaded temp file (not a server-side path)
      if (!isServerPath && videoFile?.path) await unlink(videoFile.path).catch(() => {});
      await unlink(ctaFile.path).catch(() => {});
    }
  })();
});

// ── POST /api/generate-bridge-auto ──────────────────────────────────────────
// Full auto pipeline: upload video only → extract last frame → generate CTA
// image → generate bridge video → concat original + bridge into final MP4
router.post('/api/generate-bridge-auto', uploadBridge.fields([
  { name: 'video', maxCount: 1 },
]), async (req, res) => {
  const videoFile = req.files?.video?.[0];
  const prompt = (req.body.prompt || '').trim().slice(0, 2500);
  const model = req.body.model || 'google:3@2';
  const bridgeDuration = parseInt(req.body.duration || '7');
  const videoPath = (req.body.videoPath || '').trim();

  // Resolve video source
  let resolvedVideoPath = videoFile?.path || null;
  let resolvedVideoName = videoFile?.originalname || path.basename(videoPath) || 'video.mp4';
  const isServerPath = !videoFile && !!videoPath;

  if (isServerPath) {
    const absPath = path.resolve(videoPath);
    const outputDir = path.resolve('output');
    if (!absPath.startsWith(outputDir)) {
      return res.status(400).json({ error: 'Invalid videoPath: must be within the output directory.' });
    }
    try { await access(absPath); } catch {
      return res.status(400).json({ error: 'videoPath file not found on server.' });
    }
    resolvedVideoPath = absPath;
  }

  if (!resolvedVideoPath) {
    return res.status(400).json({ error: 'A video file or videoPath is required.' });
  }

  const modelInfo = AVATAR_MODELS.find(m => m.id === model);
  const modelLabel = modelInfo?.label || model;
  const provider = modelInfo?.provider || 'Unknown';

  console.log(`\n[Bridge-Auto] ── New Request ──────────────────────`);
  console.log(`[Bridge-Auto]  Model    : ${model}`);
  console.log(`[Bridge-Auto]  Video    : ${resolvedVideoName}${videoFile ? ` (${(videoFile.size / 1024 / 1024).toFixed(1)} MB)` : ' (server path)'}`);
  console.log(`[Bridge-Auto]  Duration : ${bridgeDuration}s`);

  const taskUUID = randomUUID();

  addHistoryEntry({
    taskUUID,
    type: 'bridge',
    model,
    modelLabel,
    provider,
    prompt: prompt || null,
    videoName: resolvedVideoName,
    ctaImageName: '(auto-generated)',
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

  res.json({ success: true, taskUUID, status: 'pending', message: 'Auto bridge pipeline started.' });

  (async () => {
    const frameJpg = path.join('uploads', `frame_${Date.now()}.jpg`);
    const ctaDir = path.join('output', 'cta_frames', taskUUID);
    const bridgeGenerated = path.join('output', `bridge_gen_${Date.now()}.mp4`);
    const bridgeFinal = path.join('output', `bridge_final_${Date.now()}.mp4`);

    try {
      await mkdir(ctaDir, { recursive: true });

      // Step 1: Extract last frame
      console.log(`[Bridge-Auto] Extracting last frame from: ${resolvedVideoPath}`);
      await extractLastFrame(resolvedVideoPath, frameJpg);
      console.log(`[Bridge-Auto] Last frame extracted → ${frameJpg}`);

      // Step 2: Generate CTA image using Nano Bana 2 + reference.jpg
      const refImagePath = path.join(__dirname, '..', 'public', 'reference.jpg');
      const lastFrameDataURI = fileToDataURI(frameJpg, 'image/jpeg');
      const refDataURI = fileToDataURI(refImagePath, 'image/jpeg');

      console.log(`[Bridge-Auto] Generating CTA image with Nano Bana 2...`);
      const ctaImgTaskUUID = randomUUID();
      const ctaResult = await imageSubmitAndPollOwn(API_KEY, {
        taskUUID: ctaImgTaskUUID,
        model: 'google:4@3',
        positivePrompt: 'Take the first reference image as the base photo. Overlay the exact logo and CTA button from the second reference image onto the base photo. Preserve the logo design, colors, and text exactly as shown in the second reference — do not alter, recreate, or replace the logo. Place the logo in the top or bottom area of the image. Maintain a professional marketing look.',
        inputs: { referenceImages: [lastFrameDataURI, refDataURI] },
        width: 3072,
        height: 5504,
        numberResults: 1,
        includeCost: true,
        outputType: ['URL'],
      }, 'Bridge-Auto-CTA');

      if (!ctaResult?.imageURL) throw new Error('CTA image generation returned no URL');

      // Save CTA image
      const ctaImagePath = path.join(ctaDir, 'cta_frame.jpg');
      await new Promise((resolve, reject) => {
        const protocol = ctaResult.imageURL.startsWith('https') ? https : http;
        protocol.get(ctaResult.imageURL, (res2) => {
          const file = createWriteStream(ctaImagePath);
          res2.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
          file.on('error', reject);
        }).on('error', reject);
      });
      console.log(`[Bridge-Auto] ✅ CTA image saved → ${ctaImagePath} | cost: ${ctaResult.cost != null ? '$' + ctaResult.cost : 'N/A'}`);

      // Step 3: Generate bridge video (last frame → CTA image)
      const ctaDataURI = fileToDataURI(ctaImagePath, 'image/jpeg');
      const bridgeTaskUUID = randomUUID();

      const runware = new Runware({ apiKey: API_KEY });
      await runware.ensureConnection();

      const requestPayload = {
        taskUUID: bridgeTaskUUID,
        model,
        positivePrompt: (prompt ? prompt + '. ' : '') + 'Smooth cinematic transition from first frame to last frame. No person talking, no lip movement, no human speech, no facial animation. Only visual transition, zoom, pan, or motion graphics moving toward the final CTA frame.',
        duration: bridgeDuration,
        outputFormat: 'mp4',
        numberResults: 1,
        frameImages: [
          { inputImage: lastFrameDataURI },
          { inputImage: ctaDataURI },
        ],
      };

      console.log(`[Bridge-Auto] Submitting bridge video generation...`);
      const vidResult = await submitAndPoll(runware, requestPayload, 'Bridge-Auto-Vid', bridgeTaskUUID);
      runware.disconnect();

      // Step 4: Download bridge video
      console.log(`[Bridge-Auto] Downloading bridge video → ${bridgeGenerated}`);
      await downloadVideo(vidResult.videoURL, bridgeGenerated);

      // Step 5: Concat original video + bridge video
      console.log(`[Bridge-Auto] Concatenating: original + bridge → ${bridgeFinal}`);
      await concatVideos(resolvedVideoPath, bridgeGenerated, bridgeFinal);
      console.log(`[Bridge-Auto] ✅ Concatenation complete`);

      const filename = path.basename(bridgeFinal);
      const totalCost = (ctaResult.cost ?? 0) + (vidResult.cost ?? 0);

      updateHistoryEntry(taskUUID, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        videoUrl: `/output/${filename}`,
        videoURL: vidResult.videoURL,
        ctaImageUrl: `/output/cta_frames/${taskUUID}/cta_frame.jpg`,
        filename,
        cost: totalCost || null,
        costSource: 'api',
      });
      console.log(`[Bridge-Auto] ✅ Pipeline complete | total cost: $${totalCost.toFixed(3)}`);

    } catch (err) {
      const errMsg = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
      console.error(`[Bridge-Auto] ❌ ERROR: ${errMsg}`);
      updateHistoryEntry(taskUUID, { status: 'failed', error: errMsg, completedAt: new Date().toISOString() });
    } finally {
      if (!isServerPath && videoFile?.path) await unlink(videoFile.path).catch(() => {});
      await unlink(frameJpg).catch(() => {});
      await unlink(bridgeGenerated).catch(() => {});
    }
  })();
});

export default router;
