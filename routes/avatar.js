// ── Avatar Tab ──────────────────────────────────────────────────────────────
// POST /api/generate-avatar
// POST /api/models (list avatar models)

import { Router } from 'express';
import { Runware } from '@runware/sdk-js';
import { randomUUID } from 'crypto';
import { unlink } from 'fs/promises';
import { existsSync } from 'fs';
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
  const rawPrompt = (req.body.prompt || '').trim().slice(0, 2500);
  // If no prompt given, use a quality-boosting default for realistic facial & hand motion
  const prompt = rawPrompt || 'Natural realistic performance with expressive facial movements, subtle hand gestures, natural eye contact, smooth head motion, lifelike lip sync matching audio emotion and pacing';
  const model = req.body.model || 'klingai:avatar@2.0-pro';
  const heygenAvatarId = (req.body.heygenAvatarId || '').trim(); // built-in avatar ID for HeyGen
  const heygenResolution = (req.body.resolution || '1080x1920').trim(); // e.g. "1080x1920"
  const imageServerPath = (req.body.imageServerPath || '').trim(); // e.g. "/output/stories/uuid/scene_1_image.jpg"
  const audioServerPath = (req.body.audioServerPath || '').trim(); // e.g. "/uploads/el_xxx.mp3" (ElevenLabs generated)
  const modelInfo = AVATAR_MODELS.find(m => m.id === model) || { label: model, provider: 'Unknown' };
  const isHeyGen = !!modelInfo.isHeyGen;

  // Resolve server-side image if provided (e.g. podcast image)
  let resolvedImagePath = imageFile?.path || null;
  if (!resolvedImagePath && imageServerPath) {
    const cleanPath = imageServerPath.replace(/^[/\\]+/, '');
    const absPath = path.normalize(path.resolve(cleanPath));
    const outputDir = path.normalize(path.resolve('output'));
    if (absPath.startsWith(outputDir) && existsSync(absPath)) {
      resolvedImagePath = absPath;
    }
  }

  // Resolve server-side audio if provided (e.g. ElevenLabs generated audio)
  let resolvedAudioPath = audioFile?.path || null;
  if (!resolvedAudioPath && audioServerPath) {
    const cleanPath = audioServerPath.replace(/^[/\\]+/, '');
    const absPath = path.normalize(path.resolve(cleanPath));
    const uploadsDir = path.normalize(path.resolve('uploads'));
    if (absPath.startsWith(uploadsDir) && existsSync(absPath)) {
      resolvedAudioPath = absPath;
    }
  }

  // HeyGen: needs either a built-in avatar ID OR a custom image (mutually exclusive)
  if (isHeyGen) {
    const hasBuiltin = !!heygenAvatarId;
    const hasCustom = !!imageFile || !!resolvedImagePath;
    if (!hasBuiltin && !hasCustom) {
      return res.status(400).json({ error: 'HeyGen requires either a built-in avatar selection or a custom portrait image.' });
    }
    if (!resolvedAudioPath) {
      return res.status(400).json({ error: 'Audio file is required.' });
    }
  } else {
    if ((!imageFile && !resolvedImagePath) || !resolvedAudioPath) {
      return res.status(400).json({ error: 'Both image and audio files are required.' });
    }
  }

  const imageName = imageFile?.originalname || (imageServerPath ? `[server: ${path.basename(resolvedImagePath || imageServerPath)}]` : null);
  const audioName = audioFile?.originalname || (audioServerPath ? `[generated: ${path.basename(resolvedAudioPath || audioServerPath)}]` : null);

  console.log(`\n[Avatar] ── New Request ──────────────────────`);
  console.log(`[Avatar]  Model  : ${model}`);
  if (isHeyGen) {
    console.log(`[Avatar]  HeyGen : ${heygenAvatarId ? `built-in avatar: ${heygenAvatarId}` : `custom image: ${imageName}`}`);
  } else {
    console.log(`[Avatar]  Image  : ${imageName} ${imageFile ? `(${(imageFile.size / 1024).toFixed(1)} KB)` : ''}`);
  }
  console.log(`[Avatar]  Audio  : ${audioName} ${audioFile ? `(${(audioFile.size / 1024).toFixed(1)} KB)` : ''}`);
  console.log(`[Avatar]  Prompt : ${prompt || '(none)'}`);

  const taskUUID = randomUUID();

  addHistoryEntry({
    taskUUID,
    type: 'avatar',
    model,
    modelLabel: modelInfo.label,
    provider: modelInfo.provider,
    prompt: prompt || null,
    imageName: isHeyGen && heygenAvatarId ? `[built-in: ${heygenAvatarId}]` : (imageName || null),
    audioName: audioName,
    audioSize: audioFile?.size || null,
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

      const audioDataURI = fileToDataURI(resolvedAudioPath, getMimeType(resolvedAudioPath));

      let requestPayload;
      const isKling = model.startsWith('klingai:');
      const isOmniHuman = model.startsWith('bytedance:');

      if (isHeyGen) {
        // HeyGen: use built-in avatar ID OR custom image — never both
        const inputs = { audio: audioDataURI };
        if (heygenAvatarId) {
          inputs.avatar = heygenAvatarId;
          console.log(`[Avatar] HeyGen built-in avatar: ${heygenAvatarId}`);
        } else {
          const imgPath = resolvedImagePath || imageFile.path;
          inputs.image = fileToDataURI(imgPath, getMimeType(imgPath));
          console.log(`[Avatar] HeyGen custom image encoded: ${(inputs.image.length / 1024).toFixed(1)} KB`);
        }
        // Parse resolution string "WxH" → width/height
        const [resW, resH] = heygenResolution.split('x').map(Number);
        requestPayload = {
          taskUUID,
          model,
          numberResults: 1,
          includeCost: true,
          width: resW || 1080,
          height: resH || 1920,
          inputs,
        };
        if (prompt) requestPayload.positivePrompt = prompt;
        console.log(`[Avatar] HeyGen resolution: ${resW}×${resH}`);

      } else if (isOmniHuman) {
        // OmniHuman 1 / 1.5: supports width/height for resolution control
        const imgPath = resolvedImagePath || imageFile.path;
        const imageDataURI = fileToDataURI(imgPath, getMimeType(imgPath));
        console.log(`[Avatar] OmniHuman image encoded: ${(imageDataURI.length / 1024).toFixed(1)} KB`);
        requestPayload = {
          taskUUID,
          model,
          outputFormat: 'mp4',
          numberResults: 1,
          includeCost: true,
          width: 1080,
          height: 1920,
          inputs: { image: imageDataURI, audio: audioDataURI },
        };
        if (prompt) requestPayload.positivePrompt = prompt;

      } else {
        // KlingAI Avatar 2.0 Standard / Pro
        const imgPath = resolvedImagePath || imageFile.path;
        const imageDataURI = fileToDataURI(imgPath, getMimeType(imgPath));
        console.log(`[Avatar] KlingAI image encoded: ${(imageDataURI.length / 1024).toFixed(1)} KB`);
        requestPayload = {
          taskUUID,
          model,
          outputFormat: 'mp4',
          numberResults: 1,
          includeCost: true,
          inputs: { image: imageDataURI, audio: audioDataURI },
        };
        if (prompt) requestPayload.positivePrompt = prompt;
      }

      console.log(`[Avatar] Audio encoded: ${(audioDataURI.length / 1024).toFixed(1)} KB`);
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
      if (imageFile?.path) await unlink(imageFile.path).catch(() => {});
      // Only delete audio if it was a direct upload (not a server-side path we generated)
      if (audioFile?.path) await unlink(audioFile.path).catch(() => {});
    }
  })();
});

export default router;
