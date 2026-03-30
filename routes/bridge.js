// ── CTA Bridge Tab ──────────────────────────────────────────────────────────
// POST /api/generate-bridge
// Extracts last frame from video, generates bridge video using Runware,
// then concatenates original video + bridge video into final output.

import { Router } from 'express';
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
import { extractLastFrame, concatVideos, mixMusicIntoVideo } from '../lib/ffmpeg.js';
import { imageSubmitAndPollOwn } from '../lib/runware.js';
import { addHistoryEntry, updateHistoryEntry } from '../lib/history.js';
import { globalPoller, sseEmitter } from '../lib/globalPoller.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = Router();
const API_KEY = process.env.RUNWARE_API_KEY;

router.post('/api/generate-bridge', uploadBridge.fields([
  { name: 'video', maxCount: 1 },
  { name: 'ctaImage', maxCount: 1 },
  { name: 'musicFile', maxCount: 1 },
]), async (req, res) => {
  const videoFile = req.files?.video?.[0];
  const ctaFile = req.files?.ctaImage?.[0];
  const musicFile = req.files?.musicFile?.[0];
  const musicFileRef = (req.body.musicFileRef || '').trim(); // server-side music path from uploads
  const musicScope = (req.body.musicScope || 'full').trim(); // 'full' or 'bridge-only'
  const prompt = (req.body.prompt || '').trim().slice(0, 2500);
  const model = req.body.model || 'google:3@2';
  const bridgeDuration = parseInt(req.body.duration || '7');
  const videoPath = (req.body.videoPath || '').trim(); // server-side path for podcast videos

  // Resolve music: uploaded file or server-side ref
  let resolvedMusicPath = musicFile?.path || null;
  if (!resolvedMusicPath && musicFileRef) {
    const cleanRef = musicFileRef.replace(/^[/\\]+/, '');
    const absMusicPath = path.normalize(path.resolve(cleanRef));
    const uploadsDir = path.normalize(path.resolve('uploads'));
    if (absMusicPath.startsWith(uploadsDir)) resolvedMusicPath = absMusicPath;
  }

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

  const ts = Date.now();
  // Build a readable name: <source-video-stem>_bridge_<model-short>[_music]_<ts>
  const srcStem = path.basename(resolvedVideoName, path.extname(resolvedVideoName))
    .replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 40);
  const modelShort = model.includes('fast') ? 'veo31fast' : model.includes('veo') || model.includes('google') ? 'veo31' : model.replace(/[^a-z0-9]/gi, '').slice(0, 12);
  const musicTag = resolvedMusicPath ? '_music' : '';
  const bridgeBase = `${srcStem}_bridge_${modelShort}${musicTag}_${ts}`;

  const frameJpg = path.join('uploads', `frame_${ts}.jpg`);
  const bridgeGenerated = path.join('output', `${bridgeBase}_gen.mp4`);
  // bridge-only: music is mixed into the bridge clip before concat; no separate final file needed
  const bridgeWithMusic = (resolvedMusicPath && musicScope === 'bridge-only')
    ? path.join('output', `${bridgeBase}_bridgemusic.mp4`)
    : null;
  const bridgeConcatted = path.join('output', `${bridgeBase}_concat.mp4`);
  const bridgeFinal = (resolvedMusicPath && musicScope === 'full')
    ? path.join('output', `${bridgeBase}_final.mp4`)
    : bridgeConcatted;

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
    // Pipeline paths — needed to reconstruct handler after server restart
    _pipeline: {
      sourceVideoPath: resolvedVideoPath,
      bridgeGenerated,
      bridgeWithMusic: bridgeWithMusic || null,
      bridgeConcatted,
      bridgeFinal,
      musicPath: resolvedMusicPath || null,
      musicScope,
    },
  });

  console.log(`[Bridge]  taskUUID: ${taskUUID} → added to history as PENDING`);
  res.json({ success: true, taskUUID, status: 'pending', message: 'Task submitted. Use taskUUID to check status.' });

  (async () => {

    let requestPayload;
    try {
      console.log(`[Bridge] Extracting last frame from: ${resolvedVideoPath}`);
      await extractLastFrame(resolvedVideoPath, frameJpg);
      console.log(`[Bridge] Last frame extracted → ${frameJpg}`);

      const firstFrameDataURI = fileToDataURI(frameJpg, 'image/jpeg');
      const ctaDataURI = fileToDataURI(ctaFile.path, getMimeType(ctaFile.path));
      console.log(`[Bridge] First frame: ${(firstFrameDataURI.length / 1024).toFixed(1)} KB | CTA: ${(ctaDataURI.length / 1024).toFixed(1)} KB`);

      const BASE_BRIDGE_PROMPT = 'Smooth transition. The character gently closes their mouth, lips fully shut with zero lip movement, teeth hidden, mouth completely closed and still. No talking, no speaking, no lip sync, no facial animation. Calm gentle slow crossfade transition from the first frame to the last frame. No person talking, no lip movement, no mouth movement, no human speech, no exaggerated expressions, no body movement. The person in frame must remain completely still and frozen like a photograph. Only a very slow subtle camera push-in or gentle zoom toward the final CTA frame. Minimal motion, no dramatic effects.';
      const bridgePositivePrompt = (prompt ? prompt + '. ' : '') + BASE_BRIDGE_PROMPT;
      const bridgeNegativePrompt = 'talking, speaking, lip movement, mouth movement, speech, dialogue, vocals, singing, lip sync, facial animation, exaggerated expressions, open mouth, words, narration, voice over, human sounds, breathing sounds';

      const isKling3 = model.includes('kling-video@3');
      const isKling  = model.startsWith('klingai:');

      if (isKling3) {
        requestPayload = {
          taskUUID,
          model,
          positivePrompt: bridgePositivePrompt,
          negativePrompt: bridgeNegativePrompt,
          duration: bridgeDuration,
          outputFormat: 'mp4',
          numberResults: 1,
          inputs: {
            frameImages: [
              { image: firstFrameDataURI, frame: 'first' },
              { image: ctaDataURI,        frame: 'last'  },
            ],
          },
          providerSettings: { klingai: { sound: false } },
        };
      } else if (isKling) {
        requestPayload = {
          taskUUID,
          model,
          positivePrompt: bridgePositivePrompt,
          negativePrompt: bridgeNegativePrompt,
          duration: bridgeDuration,
          outputFormat: 'mp4',
          numberResults: 1,
          frameImages: [
            { inputImage: firstFrameDataURI },
            { inputImage: ctaDataURI },
          ],
        };
      } else {
        // Google Veo — uses inputs.frameImages with { image, frame } format
        requestPayload = {
          taskUUID,
          model,
          positivePrompt: bridgePositivePrompt,
          negativePrompt: bridgeNegativePrompt,
          duration: bridgeDuration,
          outputFormat: 'mp4',
          numberResults: 1,
          inputs: {
            frameImages: [
              { image: firstFrameDataURI, frame: 'first' },
              { image: ctaDataURI,        frame: 'last'  },
            ],
          },
          providerSettings: { google: { generateAudio: false } },
        };
      }

      console.log(`[Bridge] Submitting task ${taskUUID} via global connection (skipResponse)...`);
      await globalPoller.getConnection().videoInference({ ...requestPayload, includeCost: true, skipResponse: true });
      console.log(`[Bridge] Task submitted OK. Registered with global poller.`);

    } catch (submitErr) {
      const errMsg = submitErr?.message || submitErr?.error || JSON.stringify(submitErr) || String(submitErr);
      console.error(`[Bridge] ❌ Submit/prep failed:`, submitErr);
      updateHistoryEntry(taskUUID, { status: 'failed', error: errMsg, completedAt: new Date().toISOString() });
      sseEmitter.emit('task-complete', { taskUUID, type: 'bridge', status: 'failed', error: errMsg });
      if (!isServerPath && videoFile?.path) await unlink(videoFile.path).catch(() => {});
      await unlink(ctaFile.path).catch(() => {});
      if (musicFile?.path) await unlink(musicFile.path).catch(() => {});
      await unlink(frameJpg).catch(() => {});
      return;
    }

    globalPoller.register(taskUUID, {
      type: 'video',
      label: 'Bridge',
      onComplete: async (result) => {
        try {
          console.log(`[Bridge] Downloading generated bridge → ${bridgeGenerated}`);
          await downloadVideo(result.videoURL, bridgeGenerated);
          console.log(`[Bridge] ✅ Bridge video downloaded`);

          // If bridge-only music: mix into bridge clip before concat
          let bridgeClipForConcat = bridgeGenerated;
          if (resolvedMusicPath && musicScope === 'bridge-only') {
            console.log(`[Bridge] Mixing music into bridge clip only → ${bridgeWithMusic}`);
            await mixMusicIntoVideo(bridgeGenerated, resolvedMusicPath, bridgeWithMusic, 0.25);
            console.log(`[Bridge] ✅ Bridge music mixed`);
            bridgeClipForConcat = bridgeWithMusic;
          }

          console.log(`[Bridge] Concatenating: ${resolvedVideoPath} + ${bridgeClipForConcat} → ${bridgeConcatted}`);
          await concatVideos(resolvedVideoPath, bridgeClipForConcat, bridgeConcatted);
          console.log(`[Bridge] ✅ Concatenation complete`);

          if (resolvedMusicPath && musicScope === 'full') {
            console.log(`[Bridge] Mixing bg music into full video: ${resolvedMusicPath}`);
            await mixMusicIntoVideo(bridgeConcatted, resolvedMusicPath, bridgeFinal, 0.25);
            console.log(`[Bridge] ✅ Music mixed`);
            await unlink(bridgeConcatted).catch(() => {});
          }

          const filename = path.basename(bridgeFinal);
          const resolvedCost = result.cost ?? null;

          const updated = updateHistoryEntry(taskUUID, {
            status: 'completed',
            completedAt: new Date().toISOString(),
            videoUrl: `/output/${filename}`,
            videoURL: result.videoURL,
            filename,
            cost: resolvedCost,
            costSource: resolvedCost !== null ? 'api' : null,
          });
          console.log(`[Bridge] History updated → COMPLETED`);

          sseEmitter.emit('task-complete', {
            taskUUID,
            type: 'bridge',
            status: 'completed',
            videoUrl: `/output/${filename}`,
            entry: updated,
          });
        } finally {
          if (!isServerPath && videoFile?.path) await unlink(videoFile.path).catch(() => {});
          await unlink(ctaFile.path).catch(() => {});
          if (musicFile?.path) await unlink(musicFile.path).catch(() => {});
          await unlink(frameJpg).catch(() => {});
          await unlink(bridgeGenerated).catch(() => {});
          if (bridgeWithMusic) await unlink(bridgeWithMusic).catch(() => {});
        }
      },
      onError: async (err) => {
        const errMsg = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
        console.error(`[Bridge] ❌ ERROR: ${errMsg}`);
        updateHistoryEntry(taskUUID, { status: 'failed', error: errMsg, completedAt: new Date().toISOString() });
        sseEmitter.emit('task-complete', { taskUUID, type: 'bridge', status: 'failed', error: errMsg });
        if (!isServerPath && videoFile?.path) await unlink(videoFile.path).catch(() => {});
        await unlink(ctaFile.path).catch(() => {});
        if (musicFile?.path) await unlink(musicFile.path).catch(() => {});
        await unlink(frameJpg).catch(() => {});
        await unlink(bridgeGenerated).catch(() => {});
      },
    });
  })();
});

// ── POST /api/generate-bridge-auto ──────────────────────────────────────────
// Full auto pipeline: upload video only → extract last frame → generate CTA
// image → generate bridge video → concat original + bridge into final MP4
router.post('/api/generate-bridge-auto', uploadBridge.fields([
  { name: 'video', maxCount: 1 },
  { name: 'musicFile', maxCount: 1 },
]), async (req, res) => {
  const videoFile = req.files?.video?.[0];
  const musicFile = req.files?.musicFile?.[0];
  const musicFileRef = (req.body.musicFileRef || '').trim();
  const prompt = (req.body.prompt || '').trim().slice(0, 2500);
  const model = req.body.model || 'google:3@2';
  const bridgeDuration = parseInt(req.body.duration || '7');
  const videoPath = (req.body.videoPath || '').trim();

  // Resolve music
  let resolvedMusicPath = musicFile?.path || null;
  if (!resolvedMusicPath && musicFileRef) {
    const cleanRef = musicFileRef.replace(/^[/\\]+/, '');
    const absMusicPath = path.normalize(path.resolve(cleanRef));
    const uploadsDir = path.normalize(path.resolve('uploads'));
    if (absMusicPath.startsWith(uploadsDir)) resolvedMusicPath = absMusicPath;
  }

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
    const ts2 = Date.now();
    const srcStem2 = path.basename(resolvedVideoName, path.extname(resolvedVideoName))
      .replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 40);
    const modelShort2 = model.includes('fast') ? 'veo31fast' : model.includes('veo') || model.includes('google') ? 'veo31' : model.replace(/[^a-z0-9]/gi, '').slice(0, 12);
    const musicTag2 = resolvedMusicPath ? '_music' : '';
    const bridgeBase2 = `${srcStem2}_bridge_${modelShort2}${musicTag2}_${ts2}`;

    const frameJpg = path.join('uploads', `frame_${ts2}.jpg`);
    const ctaDir = path.join('output', 'cta_frames', taskUUID);
    const bridgeGenerated = path.join('output', `${bridgeBase2}_gen.mp4`);
    const bridgeConcatted = path.join('output', `${bridgeBase2}_concat.mp4`);
    const bridgeFinal = resolvedMusicPath
      ? path.join('output', `${bridgeBase2}_final.mp4`)
      : bridgeConcatted;

    let ctaImageCost = null;
    let bridgeTaskUUID;
    let lastFrameDataURI;

    try {
      await mkdir(ctaDir, { recursive: true });

      // Step 1: Extract last frame
      console.log(`[Bridge-Auto] Extracting last frame from: ${resolvedVideoPath}`);
      await extractLastFrame(resolvedVideoPath, frameJpg);
      console.log(`[Bridge-Auto] Last frame extracted → ${frameJpg}`);

      // Step 2: Generate CTA image using Nano Bana 2 + reference.jpg
      const refImagePath = path.join(__dirname, '..', 'public', 'reference.jpg');
      lastFrameDataURI = fileToDataURI(frameJpg, 'image/jpeg');
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
      ctaImageCost = ctaResult.cost ?? null;

      // Step 3: Build bridge video payload and submit via global connection
      const ctaDataURI = fileToDataURI(ctaImagePath, 'image/jpeg');
      bridgeTaskUUID = randomUUID();

      const autoPositivePrompt = (prompt ? prompt + '. ' : '') + 'Calm gentle slow crossfade transition from the first frame to the last frame. No person talking, no lip movement, no mouth movement, no human speech, no facial animation, no exaggerated expressions, no body movement. The person in frame must remain completely still and frozen like a photograph. Only a very slow subtle camera push-in or gentle zoom toward the final CTA frame. Minimal motion, no dramatic effects.';
      const autoNegativePrompt = 'talking, speaking, lip movement, mouth movement, speech, dialogue, vocals, singing, lip sync, facial animation, exaggerated expressions, open mouth, words, narration, voice over, human sounds, breathing sounds';

      const isKling3Auto = model.includes('kling-video@3');
      const isKlingAuto  = model.startsWith('klingai:');

      let requestPayload;
      if (isKling3Auto) {
        requestPayload = {
          taskUUID: bridgeTaskUUID,
          model,
          positivePrompt: autoPositivePrompt,
          negativePrompt: autoNegativePrompt,
          duration: bridgeDuration,
          outputFormat: 'mp4',
          numberResults: 1,
          inputs: {
            frameImages: [
              { image: lastFrameDataURI, frame: 'first' },
              { image: ctaDataURI,       frame: 'last'  },
            ],
          },
          providerSettings: { klingai: { sound: false } },
        };
      } else if (isKlingAuto) {
        requestPayload = {
          taskUUID: bridgeTaskUUID,
          model,
          positivePrompt: autoPositivePrompt,
          negativePrompt: autoNegativePrompt,
          duration: bridgeDuration,
          outputFormat: 'mp4',
          numberResults: 1,
          frameImages: [
            { inputImage: lastFrameDataURI },
            { inputImage: ctaDataURI },
          ],
        };
      } else {
        requestPayload = {
          taskUUID: bridgeTaskUUID,
          model,
          positivePrompt: autoPositivePrompt,
          negativePrompt: autoNegativePrompt,
          duration: bridgeDuration,
          outputFormat: 'mp4',
          numberResults: 1,
          frameImages: [
            { inputImage: lastFrameDataURI },
            { inputImage: ctaDataURI },
          ],
          providerSettings: { google: { generateAudio: false } },
        };
      }

      console.log(`[Bridge-Auto] Submitting bridge video task ${bridgeTaskUUID} via global connection (skipResponse)...`);
      await globalPoller.getConnection().videoInference({ ...requestPayload, includeCost: true, skipResponse: true });
      console.log(`[Bridge-Auto] Task submitted OK. Registered with global poller.`);

    } catch (setupErr) {
      const errMsg = setupErr?.message || String(setupErr);
      console.error(`[Bridge-Auto] ❌ Setup failed: ${errMsg}`);
      updateHistoryEntry(taskUUID, { status: 'failed', error: errMsg, completedAt: new Date().toISOString() });
      sseEmitter.emit('task-complete', { taskUUID, type: 'bridge', status: 'failed', error: errMsg });
      if (!isServerPath && videoFile?.path) await unlink(videoFile.path).catch(() => {});
      if (musicFile?.path) await unlink(musicFile.path).catch(() => {});
      await unlink(frameJpg).catch(() => {});
      return;
    }

    // Register bridge video task (uses bridgeTaskUUID for polling, but history is under taskUUID)
    const capturedCtaCost = ctaImageCost;
    globalPoller.register(bridgeTaskUUID, {
      type: 'video',
      label: 'Bridge-Auto-Vid',
      onComplete: async (result) => {
        try {
          console.log(`[Bridge-Auto] Downloading bridge video → ${bridgeGenerated}`);
          await downloadVideo(result.videoURL, bridgeGenerated);

          console.log(`[Bridge-Auto] Concatenating: original + bridge → ${bridgeConcatted}`);
          await concatVideos(resolvedVideoPath, bridgeGenerated, bridgeConcatted);
          console.log(`[Bridge-Auto] ✅ Concatenation complete`);

          if (resolvedMusicPath) {
            console.log(`[Bridge-Auto] Mixing bg music (vol 0.15): ${resolvedMusicPath}`);
            await mixMusicIntoVideo(bridgeConcatted, resolvedMusicPath, bridgeFinal, 0.25);
            console.log(`[Bridge-Auto] ✅ Music mixed`);
            await unlink(bridgeConcatted).catch(() => {});
          }

          const filename = path.basename(bridgeFinal);
          const totalCost = (capturedCtaCost ?? 0) + (result.cost ?? 0);

          const updated = updateHistoryEntry(taskUUID, {
            status: 'completed',
            completedAt: new Date().toISOString(),
            videoUrl: `/output/${filename}`,
            videoURL: result.videoURL,
            ctaImageUrl: `/output/cta_frames/${taskUUID}/cta_frame.jpg`,
            filename,
            cost: totalCost || null,
            costSource: 'api',
          });
          console.log(`[Bridge-Auto] ✅ Pipeline complete | total cost: $${totalCost.toFixed(3)}`);

          sseEmitter.emit('task-complete', {
            taskUUID,
            type: 'bridge',
            status: 'completed',
            videoUrl: `/output/${filename}`,
            entry: updated,
          });
        } finally {
          if (!isServerPath && videoFile?.path) await unlink(videoFile.path).catch(() => {});
          if (musicFile?.path) await unlink(musicFile.path).catch(() => {});
          await unlink(frameJpg).catch(() => {});
          await unlink(bridgeGenerated).catch(() => {});
        }
      },
      onError: async (err) => {
        const errMsg = err?.message || String(err);
        console.error(`[Bridge-Auto] ❌ ERROR: ${errMsg}`);
        updateHistoryEntry(taskUUID, { status: 'failed', error: errMsg, completedAt: new Date().toISOString() });
        sseEmitter.emit('task-complete', { taskUUID, type: 'bridge', status: 'failed', error: errMsg });
        if (!isServerPath && videoFile?.path) await unlink(videoFile.path).catch(() => {});
        if (musicFile?.path) await unlink(musicFile.path).catch(() => {});
        await unlink(frameJpg).catch(() => {});
        await unlink(bridgeGenerated).catch(() => {});
      },
    });
  })();
});

// ── POST /api/add-music-to-video ─────────────────────────────────────────────
// Mixes background music into an already-generated video (from history).
// Body (multipart): videoPath (server-side output/ path), musicFile or musicFileRef, volume (0-1)
router.post('/api/add-music-to-video', uploadBridge.fields([
  { name: 'musicFile', maxCount: 1 },
]), async (req, res) => {
  const musicFile = req.files?.musicFile?.[0];
  const musicFileRef = (req.body.musicFileRef || '').trim();
  const videoPath = (req.body.videoPath || '').trim();
  const volume = Math.min(1, Math.max(0.05, parseFloat(req.body.volume || '0.25')));

  // Resolve video
  if (!videoPath) return res.status(400).json({ error: 'videoPath is required.' });
  const absVideoPath = path.normalize(path.resolve(videoPath));
  const outputDir = path.normalize(path.resolve('output'));
  if (!absVideoPath.startsWith(outputDir)) {
    return res.status(400).json({ error: 'videoPath must be within the output directory.' });
  }
  try { await access(absVideoPath); } catch {
    return res.status(400).json({ error: 'Video file not found on server.' });
  }

  // Resolve music
  let resolvedMusicPath = musicFile?.path || null;
  if (!resolvedMusicPath && musicFileRef) {
    const cleanRef = musicFileRef.replace(/^[/\\]+/, ''); // strip leading slashes
    const absMusicPath = path.normalize(path.resolve(cleanRef));
    const uploadsDir = path.normalize(path.resolve('uploads'));
    if (absMusicPath.startsWith(uploadsDir)) resolvedMusicPath = absMusicPath;
  }
  if (!resolvedMusicPath) return res.status(400).json({ error: 'Music file is required.' });

  const ts = Date.now();
  const outputFilename = `with_music_${ts}.mp4`;
  const outputPath = path.join('output', outputFilename);

  console.log(`\n[AddMusic] Video: ${path.basename(absVideoPath)} | vol: ${volume}`);

  try {
    await mixMusicIntoVideo(absVideoPath, resolvedMusicPath, outputPath, volume);
    console.log(`[AddMusic] ✅ Done → ${outputFilename}`);
    res.json({ success: true, videoUrl: `/output/${outputFilename}`, filename: outputFilename });
  } catch (err) {
    console.error(`[AddMusic] ❌ ${err.message}`);
    res.status(500).json({ error: err.message });
  } finally {
    if (musicFile?.path) await unlink(musicFile.path).catch(() => {});
  }
});

export default router;
