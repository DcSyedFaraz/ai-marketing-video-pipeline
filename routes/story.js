// ── Story to Video Pipeline ──────────────────────────────────────────────────
// POST /api/generate-story    — Start full pipeline
// POST /api/resume-story/:id  — Resume paused pipeline
// POST /api/retry-scene/:id/:idx — Retry single scene + auto-resume
// GET  /api/story-history     — List all story entries
// GET  /api/story-history/:id — Get single story detail
// DELETE /api/story-history/:id — Remove story entry + files
// GET  /api/story-models      — Return STORY_VIDEO_MODELS

import { Router } from 'express';
import { Runware } from '@runware/sdk-js';
import { randomUUID } from 'crypto';
import { mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

import { STORY_VIDEO_MODELS } from '../lib/models.js';
import { planScenes } from '../lib/gemini.js';
import { fileToDataURI, downloadVideo, downloadImage, getMimeType } from '../lib/helpers.js';
import { concatMultipleVideos } from '../lib/ffmpeg.js';
import { submitAndPoll, imageSubmitAndPollOwn } from '../lib/runware.js';
import { upload } from '../lib/multer.js';
import {
  loadStoryHistory, addStoryEntry, updateStoryEntry, updateSceneInStory,
} from '../lib/storyHistory.js';

const router = Router();
const API_KEY = process.env.RUNWARE_API_KEY;

// ─── Helper: create blank scene progress from Gemini output ──────────────────
function initSceneProgress(geminiScenes) {
  return geminiScenes.map((s, i) => {
    const scene = {
      sceneNumber: s.sceneNumber,
      imagePrompt: s.imagePrompt,
      videoPrompt: s.videoPrompt,
      duration: s.duration,
      useHeroRef: s.useHeroRef || false,
      useBgRef: s.useBgRef || false,
      imageStatus: 'pending',
      imageUrl: null,
      imageError: null,
      videoStatus: 'pending',
      videoUrl: null,
      videoTaskUUID: null,
      videoError: null,
      videoCost: null,
      imageCost: null,
    };
    // Last scene has a separate CTA image
    if (i === geminiScenes.length - 1 && s.ctaImagePrompt) {
      scene.ctaImagePrompt = s.ctaImagePrompt;
      scene.ctaImageStatus = 'pending';
      scene.ctaImageUrl = null;
      scene.ctaImageError = null;
      scene.ctaImageCost = null;
    }
    return scene;
  });
}

// ─── Helper: get story dir ───────────────────────────────────────────────────
function storyDir(taskUUID) {
  return path.join('output', 'stories', taskUUID);
}

// ─── Core pipeline runner (works for both initial and resume) ────────────────
async function runPipeline(taskUUID, startPhase, startSceneIdx) {
  const entry = loadStoryHistory().find(h => h.taskUUID === taskUUID);
  if (!entry) return;

  const dir = storyDir(taskUUID);
  await mkdir(dir, { recursive: true });

  const runware = new Runware({ apiKey: API_KEY });

  try {
    await runware.ensureConnection();
    console.log(`[Story] Pipeline started for ${taskUUID} | phase: ${startPhase} | scene: ${startSceneIdx}`);

    // ── PHASE: PLANNING ──────────────────────────────────────────────────────
    if (startPhase === 'planning') {
      updateStoryEntry(taskUUID, { status: 'processing', currentPhase: 'planning', error: null });

      try {
        // Look up selected model's exact allowed durations for Gemini
        const modelInfo = STORY_VIDEO_MODELS.find(m => m.id === entry.videoModel);
        const allowedDurations = modelInfo?.allowedDurations || [5, 8];

        const geminiResult = await planScenes(
          entry.storyText, entry.sceneCount, entry.gameContext, entry.voiceDesc, entry.heroDesc,
          { heroImagePath: entry.heroImagePath || null, backgroundImagePath: entry.bgImagePath || null },
          allowedDurations,
        );
        const scenes = initSceneProgress(geminiResult.scenes);
        const voiceOver = geminiResult.voiceOverCharacteristics || entry.voiceDesc || '';
        updateStoryEntry(taskUUID, {
          scenes,
          voiceOverCharacteristics: voiceOver,
          currentPhase: 'images',
          currentSceneIndex: 0,
        });
        console.log(`[Story] ✅ Gemini planned ${scenes.length} scenes | Voice: ${voiceOver}`);
      } catch (err) {
        console.error(`[Story] ❌ Gemini planning failed:`, err.message);
        updateStoryEntry(taskUUID, {
          status: 'paused', currentPhase: 'planning',
          error: `Gemini planning failed: ${err.message}`,
        });
        return;
      }
      startPhase = 'images';
      startSceneIdx = 0;
    }

    // Reload entry to get latest scenes
    let current = loadStoryHistory().find(h => h.taskUUID === taskUUID);
    if (!current?.scenes?.length) {
      updateStoryEntry(taskUUID, { status: 'failed', error: 'No scenes found after planning' });
      return;
    }

    // ── PHASE: IMAGES ────────────────────────────────────────────────────────
    if (startPhase === 'images') {
      updateStoryEntry(taskUUID, { status: 'processing', currentPhase: 'images', error: null });

      // Collect pending scene indices (skip already-completed ones)
      // Also include last scene if its CTA image is pending
      const pendingIndices = current.scenes
        .map((s, i) => i)
        .filter(i => {
          if (i < startSceneIdx) return false;
          const s = current.scenes[i];
          if (s.imageStatus !== 'completed') return true;
          // Last scene: also pending if CTA image isn't completed
          if (i === current.scenes.length - 1 && s.ctaImagePrompt && s.ctaImageStatus !== 'completed') return true;
          return false;
        });

      if (pendingIndices.length === 0) {
        console.log(`[Story] All images already completed, skipping image phase.`);
      } else {
        // Pre-load hero/bg reference data URIs once (reused across scenes)
        let heroDataURI = null;
        let bgDataURI = null;
        if (entry.heroImagePath && existsSync(entry.heroImagePath)) {
          heroDataURI = fileToDataURI(entry.heroImagePath, getMimeType(entry.heroImagePath));
        }
        if (entry.bgImagePath && existsSync(entry.bgImagePath)) {
          bgDataURI = fileToDataURI(entry.bgImagePath, getMimeType(entry.bgImagePath));
        }
        const ctaRefPath = path.join('public', 'reference.jpg');
        const ctaDataURI = existsSync(ctaRefPath) ? fileToDataURI(ctaRefPath, 'image/jpeg') : null;

        // Build payload map: index → { payload, taskUUID }
        // Last scene gets TWO image tasks: transition frame + CTA frame
        const imgTasks = {};
        const ctaImgTask = {}; // separate CTA task for last scene
        for (const i of pendingIndices) {
          const scene = current.scenes[i];
          const imgTaskUUID = randomUUID();
          const isLastScene = (i === current.scenes.length - 1);

          const referenceImages = [];
          if (scene.useHeroRef && heroDataURI) {
            referenceImages.push(heroDataURI);
            console.log(`[Story] Scene ${scene.sceneNumber}: will attach hero ref`);
          }
          if (scene.useBgRef && bgDataURI) {
            referenceImages.push(bgDataURI);
            console.log(`[Story] Scene ${scene.sceneNumber}: will attach bg ref`);
          }

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
          if (referenceImages.length > 0) {
            imgPayload.inputs = { referenceImages };
          }

          imgTasks[i] = { payload: imgPayload, taskUUID: imgTaskUUID };

          // Last scene: also generate CTA image (separate task)
          if (isLastScene && scene.ctaImagePrompt && scene.ctaImageStatus !== 'completed') {
            const ctaTaskUUID = randomUUID();
            const ctaRefs = [];
            if (scene.useHeroRef && heroDataURI) ctaRefs.push(heroDataURI);
            if (scene.useBgRef && bgDataURI) ctaRefs.push(bgDataURI);
            if (ctaDataURI) {
              ctaRefs.push(ctaDataURI);
              console.log(`[Story] Scene ${scene.sceneNumber} (CTA): will attach reference.jpg`);
            }

            const ctaPayload = {
              taskUUID: ctaTaskUUID,
              model: 'google:4@3',
              positivePrompt: scene.ctaImagePrompt,
              width: 3072,
              height: 5504,
              numberResults: 1,
              includeCost: true,
              outputType: ['URL'],
            };
            if (ctaRefs.length > 0) {
              ctaPayload.inputs = { referenceImages: ctaRefs };
            }

            ctaImgTask[i] = { payload: ctaPayload, taskUUID: ctaTaskUUID };
            console.log(`[Story] Scene ${scene.sceneNumber}: will also generate CTA frame image`);
          }
        }

        // ── Launch ALL scenes in parallel — each on its OWN dedicated connection ──
        // This avoids WebSocket contention when sending large base64 payloads back-to-back.
        // CTA image tasks are launched alongside regular scene images.
        const ctaIndices = Object.keys(ctaImgTask).map(Number);
        const totalImgTasks = pendingIndices.length + ctaIndices.length;
        console.log(`[Story] ── Launching ${totalImgTasks} image task(s) in parallel (${pendingIndices.length} scene + ${ctaIndices.length} CTA) ──`);

        // Mark all pending as 'generating' upfront
        for (const i of pendingIndices) {
          updateSceneInStory(taskUUID, i, { imageStatus: 'generating', imageError: null });
        }
        for (const i of ctaIndices) {
          updateSceneInStory(taskUUID, i, { ctaImageStatus: 'generating', ctaImageError: null });
        }

        // Build all parallel tasks: regular images + CTA images
        const allImageJobs = [];

        // Regular scene images
        for (const i of pendingIndices) {
          allImageJobs.push({ i, type: 'scene', task: imgTasks[i] });
        }
        // CTA image for last scene
        for (const i of ctaIndices) {
          allImageJobs.push({ i, type: 'cta', task: ctaImgTask[i] });
        }

        const parallelResults = await Promise.allSettled(
          allImageJobs.map(async (job) => {
            const scene = current.scenes[job.i];
            const suffix = job.type === 'cta' ? '-CTA' : '';
            const label = `Story-Scene${scene.sceneNumber}${suffix}-Img`;
            console.log(`[Story] Scene ${scene.sceneNumber}${suffix}: starting own-connection submit+poll | taskUUID: ${job.task.taskUUID}`);
            const img = await imageSubmitAndPollOwn(API_KEY, job.task.payload, label);
            console.log(`[Story] Scene ${scene.sceneNumber}${suffix}: poll fulfilled | raw keys: ${Object.keys(img || {}).join(', ')}`);
            return { i: job.i, type: job.type, img };
          })
        );

        const fulfilled = parallelResults.filter(r => r.status === 'fulfilled').length;
        const rejected  = parallelResults.filter(r => r.status === 'rejected').length;
        console.log(`[Story] ── All image tasks done | fulfilled: ${fulfilled} | rejected: ${rejected} ──`);

        // ── Process results — download images, update state ──
        let anyFailed = false;
        let firstFailIdx = null;
        let firstFailMsg = null;

        for (let pi = 0; pi < parallelResults.length; pi++) {
          const result = parallelResults[pi];
          const job = allImageJobs[pi];
          const i = job.i;
          const scene = current.scenes[i];
          const isCTA = job.type === 'cta';
          const suffix = isCTA ? ' CTA' : '';

          if (result.status === 'fulfilled') {
            const { img } = result.value;
            try {
              const imgURL = img?.imageURL || img?.url || img?.outputURL;
              if (!imgURL) throw new Error(`No image URL in response. Raw: ${JSON.stringify(img)?.slice(0, 300)}`);

              const imgFilename = isCTA
                ? `scene_${scene.sceneNumber}_cta_image.jpg`
                : `scene_${scene.sceneNumber}_image.jpg`;
              const imgPath = path.join(dir, imgFilename);
              console.log(`[Story] Downloading Scene ${scene.sceneNumber}${suffix} image from: ${imgURL.slice(0, 80)}...`);
              await downloadImage(imgURL, imgPath);

              const cost = img?.cost ?? img?.taskCost ?? null;
              if (isCTA) {
                updateSceneInStory(taskUUID, i, {
                  ctaImageStatus: 'completed',
                  ctaImageUrl: `/output/stories/${taskUUID}/${imgFilename}`,
                  ctaImageCost: cost,
                });
              } else {
                updateSceneInStory(taskUUID, i, {
                  imageStatus: 'completed',
                  imageUrl: `/output/stories/${taskUUID}/${imgFilename}`,
                  imageCost: cost,
                });
              }
              console.log(`[Story] ✅ Scene ${scene.sceneNumber}${suffix} image saved | cost: ${cost !== null ? '$' + cost : 'N/A'}`);
            } catch (dlErr) {
              const errMsg = dlErr?.message || String(dlErr);
              console.error(`[Story] ❌ Scene ${scene.sceneNumber}${suffix} image download failed: ${errMsg}`);
              if (isCTA) {
                updateSceneInStory(taskUUID, i, { ctaImageStatus: 'failed', ctaImageError: errMsg });
              } else {
                updateSceneInStory(taskUUID, i, { imageStatus: 'failed', imageError: errMsg });
              }
              if (!anyFailed) { anyFailed = true; firstFailIdx = i; firstFailMsg = `Scene ${scene.sceneNumber}${suffix} image download failed: ${errMsg}`; }
            }
          } else {
            const errMsg = result.reason?.message || String(result.reason) || 'Unknown error';
            console.error(`[Story] ❌ Scene ${scene.sceneNumber}${suffix} image failed: ${errMsg}`);
            console.error(`[Story]    Full reason:`, result.reason);
            if (isCTA) {
              updateSceneInStory(taskUUID, i, { ctaImageStatus: 'failed', ctaImageError: errMsg });
            } else {
              updateSceneInStory(taskUUID, i, { imageStatus: 'failed', imageError: errMsg });
            }
            if (!anyFailed) { anyFailed = true; firstFailIdx = i; firstFailMsg = `Scene ${scene.sceneNumber}${suffix} image failed: ${errMsg}`; }
          }
        }

        console.log(`[Story] ── Image phase complete | anyFailed: ${anyFailed} ──────────────────`);

        if (anyFailed) {
          updateStoryEntry(taskUUID, {
            status: 'paused', currentPhase: 'images', currentSceneIndex: firstFailIdx,
            error: firstFailMsg,
          });
          return;
        }
      }

      startPhase = 'videos';
      startSceneIdx = 0;
    }

    // Reload
    current = loadStoryHistory().find(h => h.taskUUID === taskUUID);

    // ── PHASE: VIDEOS (PARALLEL — all scenes at once) ─────────────────────────
    if (startPhase === 'videos') {
      updateStoryEntry(taskUUID, { status: 'processing', currentPhase: 'videos', error: null });

      // Collect pending video scene indices
      const pendingVidIndices = current.scenes
        .map((s, i) => i)
        .filter(i => i >= startSceneIdx && current.scenes[i].videoStatus !== 'completed');

      if (pendingVidIndices.length === 0) {
        console.log(`[Story] All videos already completed, skipping video phase.`);
      } else {
        // Build payloads for all pending scenes
        // Frame logic:
        //   Normal scene:      first frame = this scene's image,  last frame = next scene's image
        //   2nd-to-last scene: first frame = this scene's image,  last frame = LAST scene's transition image (imagePrompt)
        //   Last scene:        first frame = this scene's image (transition), last frame = CTA image (ctaImagePrompt)
        const vidTasks = {};
        const lastIdx = current.scenes.length - 1;

        for (const i of pendingVidIndices) {
          const scene = current.scenes[i];
          const isLastScene = (i === lastIdx);

          // Build first frame data URI from this scene's image
          const imgPath = path.join(dir, `scene_${scene.sceneNumber}_image.jpg`);
          if (!existsSync(imgPath)) {
            console.error(`[Story] ❌ Scene ${scene.sceneNumber} image not found on disk — skipping video`);
            updateSceneInStory(taskUUID, i, { videoStatus: 'failed', videoError: 'Image file not found on disk' });
            continue;
          }
          const imgDataURI = fileToDataURI(imgPath, 'image/jpeg');

          // Build last frame data URI
          let lastFrameDataURI = null;
          if (isLastScene) {
            // Last scene: end frame = CTA image
            const ctaImgPath = path.join(dir, `scene_${scene.sceneNumber}_cta_image.jpg`);
            if (existsSync(ctaImgPath)) {
              lastFrameDataURI = fileToDataURI(ctaImgPath, 'image/jpeg');
              console.log(`[Story] Scene ${scene.sceneNumber} (last): CTA image as end frame`);
            }
          } else if (i === lastIdx - 1) {
            // 2nd-to-last scene: end frame = last scene's TRANSITION image (not CTA)
            const lastSceneImgPath = path.join(dir, `scene_${current.scenes[lastIdx].sceneNumber}_image.jpg`);
            if (existsSync(lastSceneImgPath)) {
              lastFrameDataURI = fileToDataURI(lastSceneImgPath, 'image/jpeg');
              console.log(`[Story] Scene ${scene.sceneNumber} (2nd-to-last): last scene transition image as end frame`);
            }
          } else {
            // Normal scene: end frame = next scene's image
            const nextImgPath = path.join(dir, `scene_${current.scenes[i + 1].sceneNumber}_image.jpg`);
            if (existsSync(nextImgPath)) {
              lastFrameDataURI = fileToDataURI(nextImgPath, 'image/jpeg');
            }
          }

          const videoTaskUUID = randomUUID();
          const isKling = current.videoModel.startsWith('klingai:');

          let requestPayload;

          if (isKling) {
            const klingFrames = [{ image: imgDataURI }];
            if (lastFrameDataURI) klingFrames.push({ image: lastFrameDataURI });

            requestPayload = {
              taskUUID: videoTaskUUID,
              model: current.videoModel,
              positivePrompt: scene.videoPrompt,
              duration: scene.duration,
              outputFormat: 'mp4',
              numberResults: 1,
              inputs: {
                frameImages: klingFrames,
              },
              providerSettings: {
                klingai: { sound: true },
              },
            };
          } else {
            const googleFrames = [{ inputImage: imgDataURI }];
            if (lastFrameDataURI) googleFrames.push({ inputImage: lastFrameDataURI });

            requestPayload = {
              taskUUID: videoTaskUUID,
              model: current.videoModel,
              positivePrompt: scene.videoPrompt,
              duration: scene.duration,
              outputFormat: 'mp4',
              width: 1080,
              height: 1920,
              fps: 24,
              numberResults: 1,
              outputQuality: 85,
              frameImages: googleFrames,
              providerSettings: {
                google: { generateAudio: true, enhancePrompt: true },
              },
            };
          }

          vidTasks[i] = { payload: requestPayload, taskUUID: videoTaskUUID };
        }

        // ── Launch ALL video scenes in parallel ──
        const validIndices = pendingVidIndices.filter(i => vidTasks[i]);
        console.log(`[Story] ── Launching ${validIndices.length} video task(s) in parallel ──`);

        // Mark all as 'generating' upfront
        for (const i of validIndices) {
          updateSceneInStory(taskUUID, i, { videoStatus: 'generating', videoError: null, videoTaskUUID: vidTasks[i].taskUUID });
        }

        const parallelVidResults = await Promise.allSettled(
          validIndices.map(async (i) => {
            const scene = current.scenes[i];
            const label = `Story-Scene${scene.sceneNumber}-Vid`;
            const isKling = current.videoModel.startsWith('klingai:');
            console.log(`[Story] Scene ${scene.sceneNumber} video submit | ${isKling ? 'KlingAI' : 'Google'} | taskUUID: ${vidTasks[i].taskUUID}`);
            const result = await submitAndPoll(runware, vidTasks[i].payload, label, vidTasks[i].taskUUID);
            return { i, result };
          })
        );

        const vidFulfilled = parallelVidResults.filter(r => r.status === 'fulfilled').length;
        const vidRejected = parallelVidResults.filter(r => r.status === 'rejected').length;
        console.log(`[Story] ── All video tasks done | fulfilled: ${vidFulfilled} | rejected: ${vidRejected} ──`);

        // ── Process results — download videos, update state ──
        let anyVidFailed = false;
        let firstVidFailIdx = null;
        let firstVidFailMsg = null;

        for (let pi = 0; pi < parallelVidResults.length; pi++) {
          const result = parallelVidResults[pi];
          const i = validIndices[pi];
          const scene = current.scenes[i];

          if (result.status === 'fulfilled') {
            const { result: vidResult } = result.value;
            try {
              if (!vidResult.videoURL) throw new Error(`No videoURL in response. Raw: ${JSON.stringify(vidResult)?.slice(0, 300)}`);

              const videoFilename = `scene_${scene.sceneNumber}_video.mp4`;
              const videoPath = path.join(dir, videoFilename);
              console.log(`[Story] Downloading Scene ${scene.sceneNumber} video from: ${vidResult.videoURL.slice(0, 80)}...`);
              await downloadVideo(vidResult.videoURL, videoPath);

              const cost = vidResult.cost ?? null;
              updateSceneInStory(taskUUID, i, {
                videoStatus: 'completed',
                videoUrl: `/output/stories/${taskUUID}/${videoFilename}`,
                videoCost: cost,
              });
              console.log(`[Story] ✅ Scene ${scene.sceneNumber} video saved | cost: ${cost !== null ? '$' + cost : 'N/A'}`);
            } catch (dlErr) {
              const errMsg = dlErr?.message || String(dlErr);
              console.error(`[Story] ❌ Scene ${scene.sceneNumber} video download failed: ${errMsg}`);
              updateSceneInStory(taskUUID, i, { videoStatus: 'failed', videoError: errMsg });
              if (!anyVidFailed) { anyVidFailed = true; firstVidFailIdx = i; firstVidFailMsg = `Scene ${scene.sceneNumber} video download failed: ${errMsg}`; }
            }
          } else {
            const errMsg = result.reason?.message || String(result.reason) || 'Unknown error';
            console.error(`[Story] ❌ Scene ${scene.sceneNumber} video failed: ${errMsg}`);
            console.error(`[Story]    Full reason:`, result.reason);
            updateSceneInStory(taskUUID, i, { videoStatus: 'failed', videoError: errMsg });
            if (!anyVidFailed) { anyVidFailed = true; firstVidFailIdx = i; firstVidFailMsg = `Scene ${scene.sceneNumber} video failed: ${errMsg}`; }
          }
        }

        console.log(`[Story] ── Video phase complete | anyFailed: ${anyVidFailed} ──────────────────`);

        if (anyVidFailed) {
          updateStoryEntry(taskUUID, {
            status: 'paused', currentPhase: 'videos', currentSceneIndex: firstVidFailIdx,
            error: firstVidFailMsg,
          });
          return;
        }
      }

      startPhase = 'concat';
    }

    // Reload
    current = loadStoryHistory().find(h => h.taskUUID === taskUUID);

    // ── PHASE: CONCAT ────────────────────────────────────────────────────────
    if (startPhase === 'concat') {
      updateStoryEntry(taskUUID, { status: 'processing', currentPhase: 'concat', error: null });
      console.log(`[Story] Concatenating ${current.scenes.length} scene videos...`);

      try {
        const videoPaths = current.scenes.map(
          s => path.join(dir, `scene_${s.sceneNumber}_video.mp4`)
        );

        // Verify all videos exist
        for (const vp of videoPaths) {
          if (!existsSync(vp)) throw new Error(`Missing video: ${vp}`);
        }

        const finalPath = path.join(dir, 'final.mp4');
        await concatMultipleVideos(videoPaths, finalPath, { width: 3072, height: 5504 });

        // Calculate total cost (including CTA image cost for last scene)
        let totalCost = 0;
        for (const s of current.scenes) {
          if (s.imageCost) totalCost += s.imageCost;
          if (s.ctaImageCost) totalCost += s.ctaImageCost;
          if (s.videoCost) totalCost += s.videoCost;
        }

        updateStoryEntry(taskUUID, {
          status: 'completed',
          currentPhase: 'done',
          completedAt: new Date().toISOString(),
          finalVideoUrl: `/output/stories/${taskUUID}/final.mp4`,
          totalCost: totalCost || null,
          error: null,
        });
        console.log(`[Story] ✅ Pipeline COMPLETE | Final: ${finalPath} | Total cost: $${totalCost.toFixed(3)}`);
      } catch (err) {
        console.error(`[Story] ❌ Concatenation failed:`, err.message);
        updateStoryEntry(taskUUID, {
          status: 'paused', currentPhase: 'concat',
          error: `Concatenation failed: ${err.message}`,
        });
      }
    }

  } catch (err) {
    console.error(`[Story] ❌ Pipeline fatal error:`, err.message);
    updateStoryEntry(taskUUID, {
      status: 'failed',
      error: `Pipeline error: ${err.message}`,
      completedAt: new Date().toISOString(),
    });
  } finally {
    try { runware.disconnect(); } catch {}
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════

// ── GET /api/story-models ────────────────────────────────────────────────────
router.get('/api/story-models', (req, res) => {
  res.json({ models: STORY_VIDEO_MODELS });
});

// ── POST /api/generate-story ─────────────────────────────────────────────────
// Multipart: heroImage (optional), bgImage (optional) + form fields
const storyUpload = upload.fields([
  { name: 'heroImage', maxCount: 1 },
  { name: 'bgImage', maxCount: 1 },
]);

router.post('/api/generate-story', storyUpload, async (req, res) => {
  const { storyText, sceneCount, gameContext, voiceDesc, heroDesc, videoModel } = req.body;

  if (!storyText || !storyText.trim()) {
    return res.status(400).json({ error: 'Story text is required.' });
  }

  const count = parseInt(sceneCount) || 5;
  const model = videoModel || 'google:3@3';
  const modelInfo = STORY_VIDEO_MODELS.find(m => m.id === model);
  const taskUUID = randomUUID();

  // Hero and background image paths (from multer uploads)
  const heroImagePath = req.files?.heroImage?.[0]?.path || null;
  const bgImagePath = req.files?.bgImage?.[0]?.path || null;

  console.log(`\n[Story] ── New Story Request ──────────────────────`);
  console.log(`[Story]  taskUUID : ${taskUUID}`);
  console.log(`[Story]  Scenes   : ${count}`);
  console.log(`[Story]  Model    : ${model}`);
  console.log(`[Story]  HeroImg  : ${heroImagePath || 'none'}`);
  console.log(`[Story]  BgImg    : ${bgImagePath || 'none'}`);
  console.log(`[Story]  Story    : ${storyText.slice(0, 80)}...`);

  addStoryEntry({
    taskUUID,
    type: 'story',
    status: 'pending',
    submittedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    storyText: storyText.trim(),
    sceneCount: count,
    gameContext: (gameContext || '').trim(),
    voiceDesc: (voiceDesc || '').trim(),
    heroDesc: (heroDesc || '').trim(),
    videoModel: model,
    videoModelLabel: modelInfo?.label || model,
    voiceOverCharacteristics: null, // Gemini will populate this during planning
    heroImagePath,    // saved for resume — Gemini + Nano Bana 2 reference
    bgImagePath,      // saved for resume — Gemini + Nano Bana 2 reference
    currentPhase: 'planning',
    currentSceneIndex: null,
    scenes: [],
    finalVideoUrl: null,
    totalCost: null,
  });

  res.json({ success: true, taskUUID, status: 'pending', message: 'Story pipeline started. Check progress via story history.' });

  // Start pipeline in background
  runPipeline(taskUUID, 'planning', 0);
});

// ── POST /api/resume-story/:taskUUID ─────────────────────────────────────────
router.post('/api/resume-story/:taskUUID', async (req, res) => {
  const { taskUUID } = req.params;
  const entry = loadStoryHistory().find(h => h.taskUUID === taskUUID);

  if (!entry) return res.status(404).json({ error: 'Story not found.' });
  if (entry.status === 'processing') return res.status(400).json({ error: 'Pipeline already running.' });

  // Apply optional overrides
  const { sceneIndex, imagePrompt, videoPrompt } = req.body || {};
  if (sceneIndex !== undefined && (imagePrompt || videoPrompt)) {
    const idx = parseInt(sceneIndex);
    if (entry.scenes && entry.scenes[idx]) {
      const updates = {};
      if (imagePrompt) updates.imagePrompt = imagePrompt;
      if (videoPrompt) updates.videoPrompt = videoPrompt;
      updateSceneInStory(taskUUID, idx, updates);
    }
  }

  const phase = entry.currentPhase || 'planning';
  const sceneIdx = entry.currentSceneIndex || 0;

  console.log(`[Story] ── Resume Request ──────────────────────`);
  console.log(`[Story]  taskUUID: ${taskUUID} | phase: ${phase} | scene: ${sceneIdx}`);

  updateStoryEntry(taskUUID, { status: 'processing', error: null });
  res.json({ success: true, message: `Resuming from ${phase} phase, scene ${sceneIdx}` });

  // Resume pipeline
  runPipeline(taskUUID, phase, sceneIdx);
});

// ── POST /api/retry-scene/:taskUUID/:sceneIndex ──────────────────────────────
router.post('/api/retry-scene/:taskUUID/:sceneIndex', async (req, res) => {
  const { taskUUID, sceneIndex } = req.params;
  const idx = parseInt(sceneIndex);
  const entry = loadStoryHistory().find(h => h.taskUUID === taskUUID);

  if (!entry) return res.status(404).json({ error: 'Story not found.' });
  if (!entry.scenes || !entry.scenes[idx]) return res.status(400).json({ error: 'Invalid scene index.' });
  if (entry.status === 'processing') return res.status(400).json({ error: 'Pipeline already running.' });

  const scene = entry.scenes[idx];

  // Apply optional prompt overrides
  const { imagePrompt, videoPrompt } = req.body || {};
  if (imagePrompt) updateSceneInStory(taskUUID, idx, { imagePrompt });
  if (videoPrompt) updateSceneInStory(taskUUID, idx, { videoPrompt });

  // Determine which step failed
  let retryPhase;
  if (scene.imageStatus === 'failed' || scene.imageStatus === 'pending') {
    retryPhase = 'images';
    // Reset image and video for this scene
    updateSceneInStory(taskUUID, idx, {
      imageStatus: 'pending', imageError: null,
      videoStatus: 'pending', videoError: null,
    });
  } else if (scene.videoStatus === 'failed' || scene.videoStatus === 'pending') {
    retryPhase = 'videos';
    updateSceneInStory(taskUUID, idx, { videoStatus: 'pending', videoError: null });
  } else {
    return res.status(400).json({ error: 'Scene has no failed step to retry.' });
  }

  console.log(`[Story] ── Retry Scene ${idx + 1} ──────────────────────`);
  console.log(`[Story]  taskUUID: ${taskUUID} | phase: ${retryPhase} | scene: ${idx}`);

  updateStoryEntry(taskUUID, { status: 'processing', currentPhase: retryPhase, currentSceneIndex: idx, error: null });
  res.json({ success: true, message: `Retrying scene ${idx + 1} (${retryPhase}) and continuing...` });

  // Resume pipeline from that scene
  runPipeline(taskUUID, retryPhase, idx);
});

// ── POST /api/resubmit-images/:taskUUID ─────────────────────────────────────
// Manually re-submit ALL pending/failed images from scratch (resets their status to pending)
router.post('/api/resubmit-images/:taskUUID', async (req, res) => {
  const { taskUUID } = req.params;
  const entry = loadStoryHistory().find(h => h.taskUUID === taskUUID);

  if (!entry) return res.status(404).json({ error: 'Story not found.' });
  if (!entry.scenes || entry.scenes.length === 0) return res.status(400).json({ error: 'No scenes found — story must be planned first.' });
  if (entry.status === 'processing') return res.status(400).json({ error: 'Pipeline already running.' });

  // Find all scenes that are not completed (pending, generating, or failed)
  // Also include last scene if its CTA image is pending
  const toReset = entry.scenes
    .map((s, i) => i)
    .filter(i => {
      const s = entry.scenes[i];
      if (s.imageStatus !== 'completed') return true;
      if (i === entry.scenes.length - 1 && s.ctaImagePrompt && s.ctaImageStatus !== 'completed') return true;
      return false;
    });

  if (toReset.length === 0) {
    return res.status(400).json({ error: 'All images are already completed.' });
  }

  console.log(`[Story] ── Manual Resubmit Images ──────────────────────`);
  console.log(`[Story]  taskUUID: ${taskUUID} | resetting ${toReset.length} scene(s): [${toReset.join(', ')}]`);

  // Reset those scenes' image + CTA image status to pending
  for (const i of toReset) {
    const updates = {
      imageStatus: 'pending', imageError: null,
      videoStatus: 'pending', videoError: null, // reset video too since we'll need new images
    };
    // Reset CTA image for last scene
    if (i === entry.scenes.length - 1 && entry.scenes[i].ctaImagePrompt) {
      updates.ctaImageStatus = 'pending';
      updates.ctaImageError = null;
    }
    updateSceneInStory(taskUUID, i, updates);
  }

  // Find the first non-completed index to resume from
  const firstIdx = toReset[0];
  updateStoryEntry(taskUUID, {
    status: 'processing',
    currentPhase: 'images',
    currentSceneIndex: firstIdx,
    error: null,
  });

  res.json({ success: true, message: `Re-submitting ${toReset.length} image(s) from scene ${firstIdx + 1}...` });

  // Run pipeline from images phase at the first pending index
  runPipeline(taskUUID, 'images', firstIdx);
});

// ── POST /api/resubmit-videos/:taskUUID ──────────────────────────────────────
// Manually re-submit ALL pending/failed videos from scratch (resets their status to pending)
router.post('/api/resubmit-videos/:taskUUID', async (req, res) => {
  const { taskUUID } = req.params;
  const entry = loadStoryHistory().find(h => h.taskUUID === taskUUID);

  if (!entry) return res.status(404).json({ error: 'Story not found.' });
  if (!entry.scenes || entry.scenes.length === 0) return res.status(400).json({ error: 'No scenes found — story must be planned first.' });
  if (entry.status === 'processing') return res.status(400).json({ error: 'Pipeline already running.' });

  // Find all scenes that are not completed for video
  const toReset = entry.scenes
    .map((s, i) => i)
    .filter(i => entry.scenes[i].videoStatus !== 'completed');

  if (toReset.length === 0) {
    return res.status(400).json({ error: 'All videos are already completed.' });
  }

  console.log(`[Story] ── Manual Resubmit Videos ──────────────────────`);
  console.log(`[Story]  taskUUID: ${taskUUID} | resetting ${toReset.length} scene(s): [${toReset.join(', ')}]`);

  // Reset those scenes' video status to pending
  for (const i of toReset) {
    updateSceneInStory(taskUUID, i, {
      videoStatus: 'pending', videoError: null, videoTaskUUID: null,
    });
  }

  const firstIdx = toReset[0];
  updateStoryEntry(taskUUID, {
    status: 'processing',
    currentPhase: 'videos',
    currentSceneIndex: firstIdx,
    error: null,
  });

  res.json({ success: true, message: `Re-submitting ${toReset.length} video(s) from scene ${firstIdx + 1}...` });

  // Run pipeline from videos phase
  runPipeline(taskUUID, 'videos', firstIdx);
});

// ── GET /api/story-history ───────────────────────────────────────────────────
router.get('/api/story-history', (req, res) => {
  const history = loadStoryHistory();
  res.json({ history });
});

// ── GET /api/story-history/:taskUUID ─────────────────────────────────────────
router.get('/api/story-history/:taskUUID', (req, res) => {
  const entry = loadStoryHistory().find(h => h.taskUUID === req.params.taskUUID);
  if (!entry) return res.status(404).json({ error: 'Story not found.' });
  res.json({ entry });
});

// ── DELETE /api/story-history/:taskUUID ──────────────────────────────────────
router.delete('/api/story-history/:taskUUID', async (req, res) => {
  const { taskUUID } = req.params;
  const history = loadStoryHistory();
  const idx = history.findIndex(h => h.taskUUID === taskUUID);
  if (idx === -1) return res.status(404).json({ error: 'Story not found.' });

  history.splice(idx, 1);
  const { saveStoryHistory } = await import('../lib/storyHistory.js');
  saveStoryHistory(history);

  // Cleanup files
  const dir = storyDir(taskUUID);
  try { await rm(dir, { recursive: true, force: true }); } catch {}

  res.json({ success: true });
});

export default router;
