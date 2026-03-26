// ── Podcaster Ad Pipeline ────────────────────────────────────────────────────
// POST /api/generate-podcast        — Start podcast pipeline
// POST /api/resume-podcast/:id      — Resume from paused phase (manual mode)
// POST /api/update-podcast-prompt/:id — Edit image/video prompt before generation
// POST /api/regen-podcast-image/:id — Regenerate image (with optionally edited prompt)
// POST /api/regen-podcast-video/:id — Regenerate video (with optionally edited prompt)
// GET  /api/podcast-history         — List all podcast entries
// GET  /api/podcast-history/:id     — Get single podcast detail
// DELETE /api/podcast-history/:id   — Remove podcast entry + files

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { mkdir, rm, copyFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import sharp from 'sharp';

import { planPodcast } from '../lib/gemini.js';
import { fileToDataURI, downloadVideo, downloadImage, generateImageThumb, generateVideoThumb } from '../lib/helpers.js';
import { imageSubmitAndPollOwn } from '../lib/runware.js';
import { GlobalPoller } from '../lib/globalPoller.js';
import {
  loadStoryHistory, addStoryEntry, updateStoryEntry, updateSceneInStory, saveStoryHistory,
} from '../lib/storyHistory.js';

// ── Dedicated poller for podcast video tasks ─────────────────────────────────
// Initialized lazily on first video task so the connection isn't created until needed.
let podcastPoller = null;

async function getPodcastPoller() {
  if (!podcastPoller) {
    podcastPoller = new GlobalPoller('PodcastPoller');
    await podcastPoller.init(API_KEY);
  }
  return podcastPoller;
}

const router = Router();
const API_KEY = process.env.RUNWARE_API_KEY;

// ─── Load game hero catalog + marketing angles once at startup ──────────────
let HEROES_DATA = null;
try {
  const heroesJsonPath = path.resolve('public', 'Blitz_of_Battle_Heroes.json');
  if (existsSync(heroesJsonPath)) {
    HEROES_DATA = JSON.parse(readFileSync(heroesJsonPath, 'utf8'));
    console.log(`[Podcast] Loaded hero catalog: ${HEROES_DATA.heroes?.length ?? 0} heroes`);
  }
} catch (e) {
  console.warn(`[Podcast] Failed to load hero catalog: ${e.message}`);
}

let MARKETING_ANGLES_DATA = null;
try {
  const maPath = path.resolve('public', 'marketing_angles.json');
  if (existsSync(maPath)) {
    MARKETING_ANGLES_DATA = JSON.parse(readFileSync(maPath, 'utf8'));
    console.log(`[Podcast] Loaded ${MARKETING_ANGLES_DATA.marketing_angles?.length ?? 0} marketing angles`);
  }
} catch (e) {
  console.warn(`[Podcast] Failed to load marketing_angles.json: ${e.message}`);
}

// ─── Helper: podcast output dir ─────────────────────────────────────────────
function podcastDir(taskUUID) {
  return path.resolve('output', 'stories', taskUUID);
}

// ─── Helper: resize image for video frame input (1080x1920) ─────────────────
async function resizeForVideo(imagePath) {
  const buffer = readFileSync(imagePath);
  const resized = await sharp(buffer)
    .resize({ width: 1080, height: 1920, fit: 'cover' })
    .jpeg({ quality: 90 })
    .toBuffer();
  return `data:image/jpeg;base64,${resized.toString('base64')}`;
}

// ─── Core pipeline runner ───────────────────────────────────────────────────
async function runPodcastPipeline(taskUUID, startPhase = 'planning') {
  const entry = loadStoryHistory().find(h => h.taskUUID === taskUUID);
  if (!entry) return;

  const dir = podcastDir(taskUUID);
  await mkdir(dir, { recursive: true });

  try {
    console.log(`[Podcast] Pipeline started for ${taskUUID} | phase: ${startPhase}`);

    // ── PHASE: PLANNING ─────────────────────────────────────────────────────
    if (startPhase === 'planning') {
      updateStoryEntry(taskUUID, { status: 'processing', currentPhase: 'planning', error: null });

      try {
        const selectedAngle = entry.marketingAngle
          ? MARKETING_ANGLES_DATA?.marketing_angles?.find(a => a.id === entry.marketingAngle || a.name === entry.marketingAngle)
          : null;

        const result = await planPodcast(
          entry.gender || 'boy',
          selectedAngle,
          HEROES_DATA,
          MARKETING_ANGLES_DATA,
          entry.userScript || '',
          entry.gameContext || '',
          entry.heroNames || [],
          entry.preferredDuration || null,
        );

        const scene = {
          sceneNumber: 1,
          imagePrompt: result.podcasterImagePrompt,
          videoPrompt: result.videoPrompt,
          script: result.script,
          duration: result.suggestedDuration,
          imageStatus: 'pending',
          imageUrl: null,
          imageThumbUrl: null,
          imageError: null,
          imageCost: null,
          videoStatus: 'pending',
          videoUrl: null,
          videoThumbUrl: null,
          videoTaskUUID: null,
          videoError: null,
          videoCost: null,
        };

        const isManual = entry.runMode === 'manual';

        updateStoryEntry(taskUUID, {
          scenes: [scene],
          sceneCount: 1,
          voiceOverCharacteristics: result.voiceOverCharacteristics,
          currentPhase: 'images',
          currentSceneIndex: 0,
          ...(isManual && { status: 'paused', pauseReason: 'manual' }),
        });

        console.log(`[Podcast] ✅ Planning done | duration: ${result.suggestedDuration}s | script: ${result.script.slice(0, 80)}...`);

        if (isManual) {
          console.log(`[Podcast] ⏸ Manual mode — paused after planning. User can review/edit prompts.`);
          return;
        }
      } catch (err) {
        console.error(`[Podcast] ❌ Planning failed:`, err.message);
        updateStoryEntry(taskUUID, {
          status: 'paused', currentPhase: 'planning',
          error: `Planning failed: ${err.message}`,
        });
        return;
      }
      startPhase = 'images';
    }

    // Reload entry
    let current = loadStoryHistory().find(h => h.taskUUID === taskUUID);
    if (!current?.scenes?.length) {
      updateStoryEntry(taskUUID, { status: 'failed', error: 'No scene found after planning' });
      return;
    }

    // ── PHASE: IMAGE ────────────────────────────────────────────────────────
    if (startPhase === 'images') {
      const scene = current.scenes[0];
      if (scene.imageStatus === 'completed') {
        console.log(`[Podcast] Image already completed, skipping.`);
      } else {
        updateStoryEntry(taskUUID, { status: 'processing', currentPhase: 'images', error: null });
        updateSceneInStory(taskUUID, 0, { imageStatus: 'generating', imageError: null });

        try {
          const imgTaskUUID = randomUUID();
          const imgPayload = {
            taskUUID: imgTaskUUID,
            model: 'google:4@3',
            positivePrompt: scene.imagePrompt,
            width: 3072,
            height: 5504,
            numberResults: 1,
            includeCost: true,
            outputType: ['URL'],
          };

          console.log(`[Podcast] Generating podcaster image | taskUUID: ${imgTaskUUID}`);
          const imgResult = await imageSubmitAndPollOwn(API_KEY, imgPayload, 'Podcast-Img');
          if (!imgResult?.imageURL) throw new Error('No imageURL in response');

          const imgFilename = 'scene_1_image.jpg';
          const imgPath = path.join(dir, imgFilename);
          await downloadImage(imgResult.imageURL, imgPath);

          const thumbFilename = 'scene_1_image_thumb.jpg';
          await generateImageThumb(imgPath, path.join(dir, thumbFilename));

          updateSceneInStory(taskUUID, 0, {
            imageStatus: 'completed',
            imageUrl: `/output/stories/${taskUUID}/${imgFilename}`,
            imageThumbUrl: `/output/stories/${taskUUID}/${thumbFilename}`,
            imageCost: imgResult.cost ?? null,
          });

          console.log(`[Podcast] ✅ Image saved | cost: ${imgResult.cost != null ? '$' + imgResult.cost : 'N/A'}`);
        } catch (err) {
          console.error(`[Podcast] ❌ Image failed:`, err.message);
          updateSceneInStory(taskUUID, 0, { imageStatus: 'failed', imageError: err.message });
          updateStoryEntry(taskUUID, {
            status: 'paused', currentPhase: 'images',
            error: `Image failed: ${err.message}`,
          });
          return;
        }
      }

      // Manual mode pause before video
      current = loadStoryHistory().find(h => h.taskUUID === taskUUID);
      if (current?.runMode === 'manual') {
        updateStoryEntry(taskUUID, { status: 'paused', currentPhase: 'videos', pauseReason: 'manual' });
        console.log(`[Podcast] ⏸ Manual mode — paused after image. User can review/regenerate.`);
        return;
      }

      startPhase = 'videos';
    }

    // Reload
    current = loadStoryHistory().find(h => h.taskUUID === taskUUID);

    // ── PHASE: VIDEO ────────────────────────────────────────────────────────
    if (startPhase === 'videos') {
      const scene = current.scenes[0];
      if (scene.videoStatus === 'completed') {
        console.log(`[Podcast] Video already completed, skipping.`);
      } else {
        updateStoryEntry(taskUUID, { status: 'processing', currentPhase: 'videos', error: null });
        updateSceneInStory(taskUUID, 0, { videoStatus: 'generating', videoError: null });

        try {
          const imgPath = path.join(dir, 'scene_1_image.jpg');
          if (!existsSync(imgPath)) throw new Error('Podcaster image not found on disk');

          // Resize to 1080x1920 for Kling
          const firstFrameDataURI = await resizeForVideo(imgPath);

          const videoTaskUUID = randomUUID();
          const videoPayload = {
            taskUUID: videoTaskUUID,
            model: current.videoModel || 'klingai:kling-video@3-standard',
            positivePrompt: scene.videoPrompt,
            duration: scene.duration,
            outputFormat: 'mp4',
            numberResults: 1,
            inputs: {
              frameImages: [{ image: firstFrameDataURI, frame: 'first' }],
            },
            providerSettings: { klingai: { sound: true } },
          };

          updateSceneInStory(taskUUID, 0, { videoTaskUUID });

          console.log(`[Podcast] Generating video | Kling 3.0 Standard | ${scene.duration}s | taskUUID: ${videoTaskUUID}`);

          // Use podcastPoller for batched single-connection polling
          const poller = await getPodcastPoller();
          await poller.getConnection().videoInference({ ...videoPayload, includeCost: true, skipResponse: true });
          console.log(`[Podcast] Video task submitted. Waiting for result via podcastPoller...`);

          // Register and await via Promise
          const vidResult = await new Promise((resolve, reject) => {
            poller.register(videoTaskUUID, {
              type: 'video',
              label: `Podcast-Vid-${videoTaskUUID.slice(0, 8)}`,
              onComplete: async (result) => { resolve(result); },
              onError: async (err) => { reject(err); },
            });
          });
          if (!vidResult?.videoURL) throw new Error('No videoURL in response');

          const vidFilename = 'scene_1_video.mp4';
          const vidPath = path.join(dir, vidFilename);
          await downloadVideo(vidResult.videoURL, vidPath);

          const vidThumbFilename = 'scene_1_video_thumb.jpg';
          await generateVideoThumb(vidPath, path.join(dir, vidThumbFilename));

          updateSceneInStory(taskUUID, 0, {
            videoStatus: 'completed',
            videoUrl: `/output/stories/${taskUUID}/${vidFilename}`,
            videoThumbUrl: `/output/stories/${taskUUID}/${vidThumbFilename}`,
            videoCost: vidResult.cost ?? null,
          });

          console.log(`[Podcast] ✅ Video saved | cost: ${vidResult.cost != null ? '$' + vidResult.cost : 'N/A'}`);
        } catch (err) {
          console.error(`[Podcast] ❌ Video failed:`, err.message);
          updateSceneInStory(taskUUID, 0, { videoStatus: 'failed', videoError: err.message });
          updateStoryEntry(taskUUID, {
            status: 'paused', currentPhase: 'videos',
            error: `Video failed: ${err.message}`,
          });
          return;
        }
      }

      // Done!
      current = loadStoryHistory().find(h => h.taskUUID === taskUUID);
      const finalScene = current.scenes[0];
      const totalCost = (finalScene.imageCost || 0) + (finalScene.videoCost || 0);

      updateStoryEntry(taskUUID, {
        status: 'completed',
        currentPhase: 'done',
        completedAt: new Date().toISOString(),
        finalVideoUrl: finalScene.videoUrl,
        totalCost: totalCost || null,
        error: null,
      });
      console.log(`[Podcast] ✅ Pipeline COMPLETE | Final: ${finalScene.videoUrl} | Total cost: $${totalCost.toFixed(3)}`);
    }

  } catch (err) {
    console.error(`[Podcast] ❌ Pipeline fatal error:`, err.message);
    updateStoryEntry(taskUUID, {
      status: 'failed',
      error: `Pipeline error: ${err.message}`,
      completedAt: new Date().toISOString(),
    });
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════

// ── POST /api/generate-podcast ──────────────────────────────────────────────
router.post('/api/generate-podcast', async (req, res) => {
  const { gender, marketingAngle, heroNames, userScript, customTalkingPoints, runMode, gameContext, preferredDuration, videoModel } = req.body;

  if (!gender || (gender !== 'boy' && gender !== 'girl')) {
    return res.status(400).json({ error: 'Gender is required (boy or girl).' });
  }

  const taskUUID = randomUUID();
  const parsedHeroNames = Array.isArray(heroNames) ? heroNames : [];

  console.log(`\n[Podcast] ── New Podcast Request ──────────────────────`);
  console.log(`[Podcast]  taskUUID    : ${taskUUID}`);
  console.log(`[Podcast]  Gender      : ${gender}`);
  console.log(`[Podcast]  Angle       : ${marketingAngle || 'none'}`);
  console.log(`[Podcast]  Heroes      : ${parsedHeroNames.length > 0 ? parsedHeroNames.join(', ') : 'none'}`);
  console.log(`[Podcast]  UserScript  : ${userScript ? 'yes (' + userScript.split(/\s+/).length + ' words)' : 'no'}`);
  console.log(`[Podcast]  Duration    : ${preferredDuration || 'auto (Claude picks)'}`);
  console.log(`[Podcast]  RunMode     : ${runMode === 'manual' ? 'manual' : 'auto'}`);

  addStoryEntry({
    taskUUID,
    type: 'podcast',
    status: 'pending',
    submittedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    gender,
    marketingAngle: marketingAngle || null,
    heroNames: parsedHeroNames,
    userScript: (userScript || '').trim() || null,
    preferredDuration: preferredDuration ? parseInt(preferredDuration) : null,
    customTalkingPoints: (customTalkingPoints || '').trim() || null,
    gameContext: (gameContext || '').trim() || null,
    videoModel: videoModel === 'klingai:kling-video@3-pro' ? 'klingai:kling-video@3-pro' : 'klingai:kling-video@3-standard',
    videoModelLabel: videoModel === 'klingai:kling-video@3-pro' ? 'Kling 3.0 Pro' : 'Kling 3.0 Standard',
    pipelineMode: 'podcast',
    runMode: runMode === 'manual' ? 'manual' : 'auto',
    voiceOverCharacteristics: null,
    pauseReason: null,
    currentPhase: 'planning',
    currentSceneIndex: 0,
    scenes: [],
    finalVideoUrl: null,
    totalCost: null,
  });

  res.json({ success: true, taskUUID, status: 'pending', message: 'Podcast pipeline started.' });

  // Start pipeline in background
  runPodcastPipeline(taskUUID, 'planning');
});

// ── POST /api/resume-podcast/:taskUUID ──────────────────────────────────────
router.post('/api/resume-podcast/:taskUUID', async (req, res) => {
  const { taskUUID } = req.params;
  const entry = loadStoryHistory().find(h => h.taskUUID === taskUUID);

  if (!entry) return res.status(404).json({ error: 'Podcast not found.' });
  if (entry.type !== 'podcast') return res.status(400).json({ error: 'Not a podcast entry.' });
  if (entry.status === 'processing') return res.status(400).json({ error: 'Pipeline already running.' });

  // Auto-correct phase based on actual scene status to handle corrupted state
  const scene0 = entry.scenes?.[0];
  let phase = entry.currentPhase || 'planning';
  if (!entry.scenes?.length) {
    phase = 'planning';
  } else if (scene0.imageStatus !== 'completed') {
    phase = 'images';
  } else if (scene0.videoStatus !== 'completed') {
    phase = 'videos';
  }

  // Persist the corrected phase
  updateStoryEntry(taskUUID, { currentPhase: phase });

  console.log(`[Podcast] ── Resume Request ──────────────────────`);
  console.log(`[Podcast]  taskUUID: ${taskUUID} | phase: ${phase} (corrected from: ${entry.currentPhase})`);

  updateStoryEntry(taskUUID, { status: 'processing', error: null, pauseReason: null });
  res.json({ success: true, message: `Resuming from ${phase} phase` });

  runPodcastPipeline(taskUUID, phase);
});

// ── POST /api/update-podcast-prompt/:taskUUID ───────────────────────────────
// Edit image/video prompt or script before generation (manual mode)
router.post('/api/update-podcast-prompt/:taskUUID', (req, res) => {
  const { taskUUID } = req.params;
  const entry = loadStoryHistory().find(h => h.taskUUID === taskUUID);

  if (!entry) return res.status(404).json({ error: 'Podcast not found.' });
  if (entry.type !== 'podcast') return res.status(400).json({ error: 'Not a podcast entry.' });
  if (!entry.scenes?.[0]) return res.status(400).json({ error: 'No scene data yet.' });

  const { imagePrompt, videoPrompt, script } = req.body;
  const updates = {};
  if (imagePrompt !== undefined) updates.imagePrompt = imagePrompt;
  if (videoPrompt !== undefined) updates.videoPrompt = videoPrompt;
  if (script !== undefined) updates.script = script;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No updates provided.' });
  }

  updateSceneInStory(taskUUID, 0, updates);
  console.log(`[Podcast] Updated prompts for ${taskUUID}: ${Object.keys(updates).join(', ')}`);
  res.json({ success: true, updated: Object.keys(updates) });
});

// ── POST /api/regen-podcast-image/:taskUUID ─────────────────────────────────
router.post('/api/regen-podcast-image/:taskUUID', async (req, res) => {
  const { taskUUID } = req.params;
  const entry = loadStoryHistory().find(h => h.taskUUID === taskUUID);

  if (!entry) return res.status(404).json({ error: 'Podcast not found.' });
  if (entry.type !== 'podcast') return res.status(400).json({ error: 'Not a podcast entry.' });
  if (entry.status === 'processing') return res.status(400).json({ error: 'Pipeline already running.' });

  // Apply optional prompt override
  const { imagePrompt } = req.body || {};
  if (imagePrompt) updateSceneInStory(taskUUID, 0, { imagePrompt });

  // Reset image + video (video depends on image)
  updateSceneInStory(taskUUID, 0, {
    imageStatus: 'pending', imageError: null, imageUrl: null, imageThumbUrl: null,
    videoStatus: 'pending', videoError: null, videoUrl: null, videoThumbUrl: null, videoTaskUUID: null,
  });

  console.log(`[Podcast] ── Regen Image ──────────────────────`);
  updateStoryEntry(taskUUID, { status: 'processing', currentPhase: 'images', error: null, finalVideoUrl: null });
  res.json({ success: true, message: 'Regenerating podcaster image...' });
  runPodcastPipeline(taskUUID, 'images');
});

// ── POST /api/regen-podcast-video/:taskUUID ─────────────────────────────────
// Creates a NEW podcast entry (clone) so the original is preserved.
// Body: { keepImage?: bool, videoModel?: string, videoPrompt?: string, preferredDuration?: number }
router.post('/api/regen-podcast-video/:taskUUID', async (req, res) => {
  const { taskUUID } = req.params;
  const src = loadStoryHistory().find(h => h.taskUUID === taskUUID);

  if (!src) return res.status(404).json({ error: 'Podcast not found.' });
  if (src.type !== 'podcast') return res.status(400).json({ error: 'Not a podcast entry.' });

  const { keepImage, videoModel, videoPrompt, preferredDuration } = req.body || {};

  const newUUID = randomUUID();
  const srcDir = podcastDir(taskUUID);
  const newDir = podcastDir(newUUID);
  await mkdir(newDir, { recursive: true });

  // Determine new model + label
  const newModel = videoModel || src.videoModel || 'klingai:kling-video@3-standard';
  const newModelLabel = newModel === 'klingai:kling-video@3-pro' ? 'Kling 3.0 Pro' : 'Kling 3.0 Standard';

  // Build new scene from original, reset video fields
  const srcScene = src.scenes?.[0] ? { ...src.scenes[0] } : null;
  let newScene = srcScene ? {
    ...srcScene,
    videoStatus: 'pending', videoError: null, videoUrl: null, videoThumbUrl: null, videoTaskUUID: null, videoCost: null,
  } : null;

  // Override video prompt if provided
  if (videoPrompt && newScene) newScene.videoPrompt = videoPrompt;

  // Override duration if provided
  if (preferredDuration && newScene) newScene.duration = parseInt(preferredDuration);

  // Handle image: copy existing or reset to regenerate
  const srcImgPath = path.join(srcDir, 'scene_1_image.jpg');
  const srcThumbPath = path.join(srcDir, 'scene_1_image_thumb.jpg');
  let startPhase = 'images';

  if (keepImage && srcScene?.imageStatus === 'completed' && existsSync(srcImgPath)) {
    // Copy image files to new directory
    const newImgPath = path.join(newDir, 'scene_1_image.jpg');
    const newThumbPath = path.join(newDir, 'scene_1_image_thumb.jpg');
    await copyFile(srcImgPath, newImgPath);
    if (existsSync(srcThumbPath)) await copyFile(srcThumbPath, newThumbPath).catch(() => {});
    // Update URLs in new scene to point to newUUID
    if (newScene) {
      newScene.imageUrl = `/output/stories/${newUUID}/scene_1_image.jpg`;
      newScene.imageThumbUrl = `/output/stories/${newUUID}/scene_1_image_thumb.jpg`;
      newScene.imageStatus = 'completed';
    }
    startPhase = 'videos';
  } else {
    // Will regenerate image too
    if (newScene) {
      newScene.imageStatus = 'pending';
      newScene.imageUrl = null;
      newScene.imageThumbUrl = null;
      newScene.imageCost = null;
    }
    startPhase = 'images';
  }

  // Derive a short human-readable label suffix for the dropdown
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const modelShort = newModel === 'klingai:kling-video@3-pro' ? 'Pro' : 'Std';
  const regenLabel = keepImage ? `(Keep Image · ${modelShort} · ${timeStr})` : `(New Image · ${modelShort} · ${timeStr})`;

  addStoryEntry({
    ...src,
    taskUUID: newUUID,
    status: 'processing',
    submittedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    videoModel: newModel,
    videoModelLabel: newModelLabel,
    preferredDuration: preferredDuration ? parseInt(preferredDuration) : src.preferredDuration,
    currentPhase: startPhase,
    regenLabel,            // shown in dropdown to differentiate
    parentUUID: taskUUID,  // reference to original
    scenes: newScene ? [newScene] : [],
    finalVideoUrl: null,
    totalCost: null,
  });

  console.log(`[Podcast] ── New Regen Entry ──── ${newUUID} | keepImage: ${!!keepImage} | phase: ${startPhase}`);
  res.json({ success: true, taskUUID: newUUID, message: 'New podcast video generation started.' });
  runPodcastPipeline(newUUID, startPhase);
});

// ── GET /api/podcast-history ────────────────────────────────────────────────
router.get('/api/podcast-history', (req, res) => {
  const all = loadStoryHistory();
  const podcasts = all.filter(e => e.type === 'podcast');
  res.json({ history: podcasts });
});

// ── GET /api/podcast-history/:taskUUID ──────────────────────────────────────
router.get('/api/podcast-history/:taskUUID', (req, res) => {
  const entry = loadStoryHistory().find(h => h.taskUUID === req.params.taskUUID);
  if (!entry) return res.status(404).json({ error: 'Podcast not found.' });
  res.json({ entry });
});

// ── DELETE /api/podcast-history/:taskUUID ────────────────────────────────────
router.delete('/api/podcast-history/:taskUUID', async (req, res) => {
  const { taskUUID } = req.params;
  const history = loadStoryHistory();
  const idx = history.findIndex(h => h.taskUUID === taskUUID);
  if (idx === -1) return res.status(404).json({ error: 'Podcast not found.' });

  history.splice(idx, 1);
  saveStoryHistory(history);

  // Cleanup files
  const dir = podcastDir(taskUUID);
  try { await rm(dir, { recursive: true, force: true }); } catch {}

  res.json({ success: true });
});

export default router;
