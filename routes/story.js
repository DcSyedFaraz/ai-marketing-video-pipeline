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
import { mkdir, rm, unlink } from 'fs/promises';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

import { STORY_VIDEO_MODELS } from '../lib/models.js';
import { planScenes, generateVideoDescription } from '../lib/gemini.js';
import { fileToDataURI, downloadVideo, downloadImage, getMimeType } from '../lib/helpers.js';
import { concatMultipleVideos, extractLastFrame, mixMusicIntoVideo } from '../lib/ffmpeg.js';
import { submitAndPoll, imageSubmitAndPollOwn } from '../lib/runware.js';
import { uploadStory } from '../lib/multer.js';
import {
  loadStoryHistory, addStoryEntry, updateStoryEntry, updateSceneInStory,
} from '../lib/storyHistory.js';

const router = Router();
const API_KEY = process.env.RUNWARE_API_KEY;

// ─── Load game hero catalog (Blitz_of_Battle_Heroes.json) once at startup ────
let HEROES_DATA = null;
try {
  const heroesJsonPath = path.resolve('public', 'Blitz_of_Battle_Heroes.json');
  if (existsSync(heroesJsonPath)) {
    HEROES_DATA = JSON.parse(readFileSync(heroesJsonPath, 'utf8'));
    console.log(`[Story] Loaded hero catalog: ${HEROES_DATA.heroes?.length ?? 0} heroes from ${heroesJsonPath}`);
  } else {
    console.log('[Story] No Blitz_of_Battle_Heroes.json found — hero catalog disabled');
  }
} catch (e) {
  console.warn(`[Story] Failed to load hero catalog: ${e.message}`);
}

// ─── Load marketing angles (marketing_angles.json) once at startup ────────────
let MARKETING_ANGLES_DATA = null;
try {
  const maPath = path.resolve('public', 'marketing_angles.json');
  if (existsSync(maPath)) {
    MARKETING_ANGLES_DATA = JSON.parse(readFileSync(maPath, 'utf8'));
    console.log(`[Story] Loaded ${MARKETING_ANGLES_DATA.marketing_angles?.length ?? 0} marketing angles`);
  } else {
    console.log('[Story] No marketing_angles.json found — marketing angles disabled');
  }
} catch (e) {
  console.warn(`[Story] Failed to load marketing_angles.json: ${e.message}`);
}

// ─── Helper: convert /uploads/filename.ext → absolute disk path ──────────────
function uploadRefToDiskPath(ref) {
  if (!ref || typeof ref !== 'string') return null;
  const filename = ref.replace(/^\/uploads\//, '');
  if (!filename || filename === 'undefined' || filename === 'null') {
    console.warn(`[Story] ⚠ uploadRefToDiskPath got invalid ref: "${ref}"`);
    return null;
  }
  const p = path.resolve('uploads', filename);
  if (!existsSync(p)) { console.warn(`[Story] ⚠ uploadRefToDiskPath: file not found at ${p}`); return null; }
  return p;
}

// ─── Helper: create blank scene progress from Gemini output ──────────────────
function initSceneProgress(geminiScenes, pipelineMode = 'standard') {
  const isFastPaced = (pipelineMode === 'fast-paced');
  return geminiScenes.map((s, i) => {
    const isFirstScene = (i === 0);
    const isLastScene = (i === geminiScenes.length - 1);

    const scene = {
      sceneNumber: s.sceneNumber,
      imagePrompt: s.imagePrompt || '',
      videoPrompt: s.videoPrompt,
      duration: s.duration,
      useHeroRef: s.useHeroRef || false,
      useBgRef: s.useBgRef || false,
      // Standard last scene: imageStatus skipped (no imagePrompt). Fast-paced last scene: pending (has imagePrompt)
      imageStatus: (isLastScene && !isFastPaced) ? 'skipped' : 'pending',
      imageUrl: null,
      imageError: null,
      imageCost: null,
      videoStatus: 'pending',
      videoUrl: null,
      videoTaskUUID: null,
      videoError: null,
      videoCost: null,
    };
    // Standard mode only: first scene has imageBPrompt (frame B / end frame)
    if (!isFastPaced && isFirstScene && s.imageBPrompt) {
      Object.assign(scene, {
        imageBPrompt: s.imageBPrompt,
        imageBStatus: 'pending',
        imageBUrl: null,
        imageBError: null,
        imageBCost: null,
      });
    }
    // Both modes: last scene gets ctaImagePrompt
    if (isLastScene && s.ctaImagePrompt) {
      Object.assign(scene, {
        ctaImagePrompt: s.ctaImagePrompt,
        ctaImageStatus: 'pending',
        ctaImageUrl: null,
        ctaImageError: null,
        ctaImageCost: null,
      });
    }
    return scene;
  });
}

// ─── Helper: get story dir ───────────────────────────────────────────────────
function storyDir(taskUUID) {
  return path.resolve('output', 'stories', taskUUID);
}

// ─── Helper: build video request payload for Kling or Google ─────────────────
function buildVideoPayload(isKling, videoModel, scene, videoTaskUUID, firstFrameDataURI, lastFrameDataURI) {
  if (isKling) {
    const klingFrames = [{ image: firstFrameDataURI }];
    if (lastFrameDataURI) klingFrames.push({ image: lastFrameDataURI });
    return {
      taskUUID: videoTaskUUID,
      model: videoModel,
      positivePrompt: scene.videoPrompt,
      duration: scene.duration,
      outputFormat: 'mp4',
      numberResults: 1,
      inputs: { frameImages: klingFrames },
      providerSettings: { klingai: { sound: true } },
    };
  } else {
    const googleFrames = [{ inputImage: firstFrameDataURI }];
    if (lastFrameDataURI) googleFrames.push({ inputImage: lastFrameDataURI });
    return {
      taskUUID: videoTaskUUID,
      model: videoModel,
      positivePrompt: scene.videoPrompt,
      duration: scene.duration,
      outputFormat: 'mp4',
      width: 1080, height: 1920,
      fps: 24, numberResults: 1, outputQuality: 85,
      frameImages: googleFrames,
      providerSettings: { google: { generateAudio: true, enhancePrompt: true } },
    };
  }
}

// ─── Fast-Paced video phase: generate ALL scene videos in parallel ────────────
async function runFastPacedVideoPhase(taskUUID, current, dir, startSceneIdx = 0, endSceneIdx = null) {
  const lastIdx = current.scenes.length - 1;
  const isKling = current.videoModel.startsWith('klingai:');

  const pendingScenes = current.scenes
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => s.videoStatus !== 'completed' && i >= startSceneIdx && (endSceneIdx === null || i <= endSceneIdx));

  if (pendingScenes.length === 0) {
    console.log(`[Story/FastPaced] All videos already completed, skipping.`);
    return false;
  }

  console.log(`[Story/FastPaced] Launching ${pendingScenes.length} parallel video(s)...`);

  // Mark all as generating upfront
  for (const { i } of pendingScenes) {
    updateSceneInStory(taskUUID, i, { videoStatus: 'generating', videoError: null });
  }

  const results = await Promise.allSettled(
    pendingScenes.map(async ({ s, i }) => {
      const isLast = (i === lastIdx);
      const imgPath = path.join(dir, `scene_${s.sceneNumber}_image.jpg`);
      if (!existsSync(imgPath)) throw new Error(`Scene ${s.sceneNumber}: opening image not found on disk`);
      const firstFrameDataURI = fileToDataURI(imgPath, 'image/jpeg');

      let lastFrameDataURI = null;
      if (isLast) {
        const ctaPath = path.join(dir, `scene_${s.sceneNumber}_cta_image.jpg`);
        if (existsSync(ctaPath)) {
          lastFrameDataURI = fileToDataURI(ctaPath, 'image/jpeg');
          console.log(`[Story/FastPaced] Scene ${s.sceneNumber} (last): will animate to CTA frame`);
        }
      }

      const videoTaskUUID = randomUUID();
      const requestPayload = buildVideoPayload(isKling, current.videoModel, s, videoTaskUUID, firstFrameDataURI, lastFrameDataURI);

      updateSceneInStory(taskUUID, i, { videoTaskUUID });

      // Each video uses its own dedicated Runware connection (parallel safe)
      const conn = new Runware({ apiKey: API_KEY });
      try {
        await conn.ensureConnection();
        const label = `Story-Scene${s.sceneNumber}-Vid-FP`;
        console.log(`[Story/FastPaced] Scene ${s.sceneNumber} video submit | ${isKling ? 'KlingAI' : 'Google'} | taskUUID: ${videoTaskUUID}`);
        const vidResult = await submitAndPoll(conn, requestPayload, label, videoTaskUUID);
        if (!vidResult.videoURL) throw new Error('No videoURL in response');
        const videoFilename = `scene_${s.sceneNumber}_video.mp4`;
        await downloadVideo(vidResult.videoURL, path.join(dir, videoFilename));
        console.log(`[Story/FastPaced] ✅ Scene ${s.sceneNumber} video saved | cost: ${vidResult.cost != null ? '$' + vidResult.cost : 'N/A'}`);
        return { i, videoFilename, cost: vidResult.cost ?? null };
      } finally {
        try { conn.disconnect(); } catch {}
      }
    })
  );

  let anyFailed = false;
  for (let pi = 0; pi < results.length; pi++) {
    const { i } = pendingScenes[pi];
    const scene = current.scenes[i];
    const result = results[pi];
    if (result.status === 'fulfilled') {
      const { videoFilename, cost } = result.value;
      updateSceneInStory(taskUUID, i, {
        videoStatus: 'completed',
        videoUrl: `/output/stories/${taskUUID}/${videoFilename}`,
        videoCost: cost,
      });
    } else {
      const errMsg = result.reason?.message || String(result.reason);
      console.error(`[Story/FastPaced] ❌ Scene ${scene.sceneNumber} video failed: ${errMsg}`);
      updateSceneInStory(taskUUID, i, { videoStatus: 'failed', videoError: errMsg });
      if (!anyFailed) {
        anyFailed = true;
        updateStoryEntry(taskUUID, {
          status: 'paused', currentPhase: 'videos', currentSceneIndex: i,
          error: `Scene ${scene.sceneNumber}: ${errMsg}`,
        });
      }
    }
  }

  console.log(`[Story/FastPaced] ── Parallel video phase complete | anyFailed: ${anyFailed} ──`);
  return anyFailed;
}

// ─── Core pipeline runner (works for both initial and resume) ────────────────
async function runPipeline(taskUUID, startPhase, startSceneIdx, endSceneIdx = null) {
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
        let geminiResult;

        if (entry.injectedPlan?.scenes?.length > 0) {
          // ── Use injected planning JSON — skip Claude entirely ──────────────
          console.log(`[Story] ⚡ Using injected planning JSON (${entry.injectedPlan.scenes.length} scenes)`);
          geminiResult = entry.injectedPlan;
        } else {
          // ── Let Claude plan scenes ─────────────────────────────────────────
          const modelInfo = STORY_VIDEO_MODELS.find(m => m.id === entry.videoModel);
          const allowedDurations = modelInfo?.allowedDurations || [5, 8];

          geminiResult = await planScenes(
            entry.storyText,
            { min: entry.durationMin || 15, max: entry.durationMax || 30 },
            entry.gameContext, entry.voiceDesc, entry.heroDesc,
            {
              heroImagePath: entry.heroImagePaths?.length > 0 ? entry.heroImagePaths : (entry.heroImagePath || null),
              backgroundImagePath: entry.bgImagePath || null,
            },
            allowedDurations,
            entry.pipelineMode || 'standard',
            HEROES_DATA,
            entry.namedHeroes || [],
          );
        }

        const scenes = initSceneProgress(geminiResult.scenes, entry.pipelineMode || 'standard');
        const sceneCount = scenes.length;
        const totalDuration = scenes.reduce((sum, s) => sum + (s.duration || 0), 0);
        const voiceOver = geminiResult.voiceOverCharacteristics || entry.voiceDesc || '';
        // Reload to get latest runMode (may have been updated)
        const runModeEntry = loadStoryHistory().find(h => h.taskUUID === taskUUID);
        const afterPlanningPhase = runModeEntry?.runMode === 'manual' ? 'paused_before_images' : 'images';

        updateStoryEntry(taskUUID, {
          scenes,
          sceneCount,
          voiceOverCharacteristics: voiceOver,
          currentPhase: afterPlanningPhase === 'paused_before_images' ? 'images' : 'images',
          currentSceneIndex: 0,
          ...(afterPlanningPhase === 'paused_before_images' && { status: 'paused', pauseReason: 'manual' }),
        });
        console.log(`[Story] ✅ Planning done — ${sceneCount} scenes | Total: ${totalDuration}s | Voice: ${voiceOver}`);

        if (afterPlanningPhase === 'paused_before_images') {
          console.log(`[Story] ⏸ Manual mode — paused before images. Waiting for user.`);
          return;
        }
      } catch (err) {
        console.error(`[Story] ❌ Planning failed:`, err.message);
        updateStoryEntry(taskUUID, {
          status: 'paused', currentPhase: 'planning',
          error: `Planning failed: ${err.message}`,
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
    // Standard flow:
    //   Scene 1: generate 2 images (imagePrompt = frame A, imageBPrompt = frame B)
    //   Middle scenes: generate 1 image each (imagePrompt = end frame)
    //   Last scene: generate only CTA image (no imagePrompt)
    // Fast-Paced flow:
    //   ALL scenes: generate 1 image each (imagePrompt = opening frame)
    //   Last scene: ALSO generate CTA image (ctaImagePrompt)
    if (startPhase === 'images') {
      updateStoryEntry(taskUUID, { status: 'processing', currentPhase: 'images', error: null });

      const lastIdx = current.scenes.length - 1;
      const isFastPaced = (current.pipelineMode === 'fast-paced');

      // Collect indices that still need image work
      const pendingIndices = current.scenes
        .map((s, i) => i)
        .filter(i => {
          if (i < startSceneIdx) return false;
          if (endSceneIdx !== null && i > endSceneIdx) return false;
          const s = current.scenes[i];
          const isFirst = (i === 0);
          const isLast = (i === lastIdx);

          if (isFastPaced) {
            // Fast-paced: all scenes have imagePrompt, last scene also has CTA
            if (s.imageStatus !== 'completed') return true;
            if (isLast && s.ctaImagePrompt && s.ctaImageStatus !== 'completed') return true;
            return false;
          }

          // Standard mode:
          // First scene: pending if imageA or imageB not done
          if (isFirst) {
            if (s.imageStatus !== 'completed') return true;
            if (s.imageBPrompt && s.imageBStatus !== 'completed') return true;
            return false;
          }
          // Last scene: pending only if CTA not done (no imagePrompt for last scene)
          if (isLast) {
            return s.ctaImagePrompt && s.ctaImageStatus !== 'completed';
          }
          // Middle scenes: pending if image not done
          return s.imageStatus !== 'completed';
        });

      if (pendingIndices.length === 0) {
        console.log(`[Story] All images already completed, skipping image phase.`);
      } else {
        // Pre-load hero/bg reference data URIs once (reused across scenes)
        // Support multiple hero images — load all from heroImagePaths array (fall back to heroImagePath)
        const heroPaths = (current.heroImagePaths?.length > 0)
          ? current.heroImagePaths
          : (current.heroImagePath ? [current.heroImagePath] : []);
        const heroDataURIs = heroPaths
          .filter(p => p && existsSync(p))
          .map(p => fileToDataURI(p, getMimeType(p)));

        let bgDataURI = null;
        if (current.bgImagePath && existsSync(current.bgImagePath)) {
          bgDataURI = fileToDataURI(current.bgImagePath, getMimeType(current.bgImagePath));
        }
        const ctaRefPath = path.join('public', 'reference.jpg');
        const ctaDataURI = existsSync(ctaRefPath) ? fileToDataURI(ctaRefPath, 'image/jpeg') : null;

        if (heroDataURIs.length > 0) {
          console.log(`[Story] Loaded ${heroDataURIs.length} hero ref image(s) for this run`);
        }

        // Build all image jobs: mode-aware
        const allImageJobs = [];

        for (const i of pendingIndices) {
          const scene = current.scenes[i];
          const isFirst = (i === 0);
          const isLast = (i === lastIdx);

          // Attach hero refs whenever images were uploaded — ignore useHeroRef from JSON
          // (useHeroRef was Claude's suggestion; if user uploaded images, always use them)
          const referenceImages = [];
          if (heroDataURIs.length > 0) {
            referenceImages.push(...heroDataURIs);
            console.log(`[Story] Scene ${scene.sceneNumber}: attaching ${heroDataURIs.length} hero ref(s)`);
          }
          if (scene.useBgRef && bgDataURI) {
            referenceImages.push(bgDataURI);
            console.log(`[Story] Scene ${scene.sceneNumber}: will attach bg ref`);
          }

          if (isFastPaced) {
            // ── Fast-Paced: ALL scenes get imagePrompt (opening frame) ──
            if (scene.imageStatus !== 'completed' && scene.imagePrompt) {
              const imgTaskUUID = randomUUID();
              const imgPayload = {
                taskUUID: imgTaskUUID,
                model: 'google:4@3',
                positivePrompt: scene.imagePrompt,
                width: 3072, height: 5504,
                numberResults: 1, includeCost: true, outputType: ['URL'],
              };
              if (referenceImages.length > 0) imgPayload.inputs = { referenceImages };
              allImageJobs.push({ i, type: 'scene', task: { payload: imgPayload, taskUUID: imgTaskUUID } });
            }
            // Last scene only: ALSO generate CTA image
            if (isLast && scene.ctaImagePrompt && scene.ctaImageStatus !== 'completed') {
              const ctaTaskUUID = randomUUID();
              const ctaRefs = [...referenceImages];
              if (ctaDataURI) {
                ctaRefs.push(ctaDataURI);
                console.log(`[Story] Scene ${scene.sceneNumber} (CTA): will attach reference.jpg`);
              }
              const ctaPayload = {
                taskUUID: ctaTaskUUID,
                model: 'google:4@3',
                positivePrompt: scene.ctaImagePrompt,
                width: 3072, height: 5504,
                numberResults: 1, includeCost: true, outputType: ['URL'],
              };
              if (ctaRefs.length > 0) ctaPayload.inputs = { referenceImages: ctaRefs };
              allImageJobs.push({ i, type: 'cta', task: { payload: ctaPayload, taskUUID: ctaTaskUUID } });
              console.log(`[Story] Scene ${scene.sceneNumber}: will generate CTA frame image`);
            }
          } else {
            // ── Standard: last scene = CTA only; scene 1 = imageA + imageB; middle = imageA ──
            if (isLast) {
              // Last scene: only CTA image
              if (scene.ctaImagePrompt && scene.ctaImageStatus !== 'completed') {
                const ctaTaskUUID = randomUUID();
                const ctaRefs = [...referenceImages];
                if (ctaDataURI) {
                  ctaRefs.push(ctaDataURI);
                  console.log(`[Story] Scene ${scene.sceneNumber} (CTA): will attach reference.jpg`);
                }
                const ctaPayload = {
                  taskUUID: ctaTaskUUID,
                  model: 'google:4@3',
                  positivePrompt: scene.ctaImagePrompt,
                  width: 3072, height: 5504,
                  numberResults: 1, includeCost: true, outputType: ['URL'],
                };
                if (ctaRefs.length > 0) ctaPayload.inputs = { referenceImages: ctaRefs };
                allImageJobs.push({ i, type: 'cta', task: { payload: ctaPayload, taskUUID: ctaTaskUUID } });
                console.log(`[Story] Scene ${scene.sceneNumber}: will generate CTA frame image`);
              }
            } else {
              // Scene 1 or middle scene: generate imagePrompt (frame A for scene 1, end frame for middle)
              if (scene.imageStatus !== 'completed' && scene.imagePrompt) {
                const imgTaskUUID = randomUUID();
                const imgPayload = {
                  taskUUID: imgTaskUUID,
                  model: 'google:4@3',
                  positivePrompt: scene.imagePrompt,
                  width: 3072, height: 5504,
                  numberResults: 1, includeCost: true, outputType: ['URL'],
                };
                if (referenceImages.length > 0) imgPayload.inputs = { referenceImages };
                allImageJobs.push({ i, type: 'scene', task: { payload: imgPayload, taskUUID: imgTaskUUID } });
              }

              // Scene 1 only: also generate imageBPrompt (frame B / end frame)
              if (isFirst && scene.imageBPrompt && scene.imageBStatus !== 'completed') {
                const imgBTaskUUID = randomUUID();
                const imgBPayload = {
                  taskUUID: imgBTaskUUID,
                  model: 'google:4@3',
                  positivePrompt: scene.imageBPrompt,
                  width: 3072, height: 5504,
                  numberResults: 1, includeCost: true, outputType: ['URL'],
                };
                if (referenceImages.length > 0) imgBPayload.inputs = { referenceImages };
                allImageJobs.push({ i, type: 'imageB', task: { payload: imgBPayload, taskUUID: imgBTaskUUID } });
                console.log(`[Story] Scene ${scene.sceneNumber}: will also generate frame B image`);
              }
            }
          }
        }

        console.log(`[Story] ── Launching ${allImageJobs.length} image task(s) in parallel ──`);

        // Mark all as 'generating' upfront
        for (const job of allImageJobs) {
          if (job.type === 'scene') {
            updateSceneInStory(taskUUID, job.i, { imageStatus: 'generating', imageError: null });
          } else if (job.type === 'imageB') {
            updateSceneInStory(taskUUID, job.i, { imageBStatus: 'generating', imageBError: null });
          } else if (job.type === 'cta') {
            updateSceneInStory(taskUUID, job.i, { ctaImageStatus: 'generating', ctaImageError: null });
          }
        }

        const parallelResults = await Promise.allSettled(
          allImageJobs.map(async (job) => {
            const scene = current.scenes[job.i];
            const suffix = job.type === 'cta' ? '-CTA' : (job.type === 'imageB' ? '-FrameB' : '');
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
          const typeLabel = job.type === 'cta' ? ' CTA' : (job.type === 'imageB' ? ' FrameB' : '');

          if (result.status === 'fulfilled') {
            const { img } = result.value;
            try {
              const imgURL = img?.imageURL || img?.url || img?.outputURL;
              if (!imgURL) throw new Error(`No image URL in response. Raw: ${JSON.stringify(img)?.slice(0, 300)}`);

              let imgFilename;
              if (job.type === 'cta') {
                imgFilename = `scene_${scene.sceneNumber}_cta_image.jpg`;
              } else if (job.type === 'imageB') {
                imgFilename = `scene_${scene.sceneNumber}_imageB.jpg`;
              } else {
                imgFilename = `scene_${scene.sceneNumber}_image.jpg`;
              }
              const imgPath = path.join(dir, imgFilename);
              console.log(`[Story] Downloading Scene ${scene.sceneNumber}${typeLabel} image from: ${imgURL.slice(0, 80)}...`);
              await downloadImage(imgURL, imgPath);

              const cost = img?.cost ?? img?.taskCost ?? null;
              if (job.type === 'cta') {
                updateSceneInStory(taskUUID, i, {
                  ctaImageStatus: 'completed',
                  ctaImageUrl: `/output/stories/${taskUUID}/${imgFilename}`,
                  ctaImageCost: cost,
                });
              } else if (job.type === 'imageB') {
                updateSceneInStory(taskUUID, i, {
                  imageBStatus: 'completed',
                  imageBUrl: `/output/stories/${taskUUID}/${imgFilename}`,
                  imageBCost: cost,
                });
              } else {
                updateSceneInStory(taskUUID, i, {
                  imageStatus: 'completed',
                  imageUrl: `/output/stories/${taskUUID}/${imgFilename}`,
                  imageCost: cost,
                });
              }
              console.log(`[Story] ✅ Scene ${scene.sceneNumber}${typeLabel} image saved | cost: ${cost !== null ? '$' + cost : 'N/A'}`);
            } catch (dlErr) {
              const errMsg = dlErr?.message || String(dlErr);
              console.error(`[Story] ❌ Scene ${scene.sceneNumber}${typeLabel} image download failed: ${errMsg}`);
              if (job.type === 'cta') {
                updateSceneInStory(taskUUID, i, { ctaImageStatus: 'failed', ctaImageError: errMsg });
              } else if (job.type === 'imageB') {
                updateSceneInStory(taskUUID, i, { imageBStatus: 'failed', imageBError: errMsg });
              } else {
                updateSceneInStory(taskUUID, i, { imageStatus: 'failed', imageError: errMsg });
              }
              if (!anyFailed) { anyFailed = true; firstFailIdx = i; firstFailMsg = `Scene ${scene.sceneNumber}${typeLabel} image download failed: ${errMsg}`; }
            }
          } else {
            const errMsg = result.reason?.message || String(result.reason) || 'Unknown error';
            console.error(`[Story] ❌ Scene ${scene.sceneNumber}${typeLabel} image failed: ${errMsg}`);
            console.error(`[Story]    Full reason:`, result.reason);
            if (job.type === 'cta') {
              updateSceneInStory(taskUUID, i, { ctaImageStatus: 'failed', ctaImageError: errMsg });
            } else if (job.type === 'imageB') {
              updateSceneInStory(taskUUID, i, { imageBStatus: 'failed', imageBError: errMsg });
            } else {
              updateSceneInStory(taskUUID, i, { imageStatus: 'failed', imageError: errMsg });
            }
            if (!anyFailed) { anyFailed = true; firstFailIdx = i; firstFailMsg = `Scene ${scene.sceneNumber}${typeLabel} image failed: ${errMsg}`; }
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

      // Single-scene run: pause after processing target scene, move to next pending
      if (endSceneIdx !== null) {
        const reloaded = loadStoryHistory().find(h => h.taskUUID === taskUUID);
        const nextPending = (reloaded?.scenes || []).findIndex((s, i) => i > endSceneIdx && (s.imageStatus !== 'completed' || (i === lastIdx && s.ctaImagePrompt && s.ctaImageStatus !== 'completed')));
        const nextIdx = nextPending >= 0 ? nextPending : endSceneIdx + 1;
        updateStoryEntry(taskUUID, { status: 'paused', currentPhase: 'images', currentSceneIndex: Math.min(nextIdx, current.scenes.length - 1), pauseReason: 'manual' });
        console.log(`[Story] ⏸ Single-scene run done for images scene ${endSceneIdx + 1}. Paused.`);
        return;
      }

      // Manual mode pause before videos
      const afterImagesEntry = loadStoryHistory().find(h => h.taskUUID === taskUUID);
      if (afterImagesEntry?.runMode === 'manual') {
        updateStoryEntry(taskUUID, { status: 'paused', currentPhase: 'videos', currentSceneIndex: 0, pauseReason: 'manual' });
        console.log(`[Story] ⏸ Manual mode — paused before videos. Waiting for user.`);
        return;
      }

      startPhase = 'videos';
      startSceneIdx = 0;
    }

    // Reload
    current = loadStoryHistory().find(h => h.taskUUID === taskUUID);

    // ── PHASE: VIDEOS ────────────────────────────────────────────────────────
    // Standard: sequential with frame extraction (each scene uses prev video's last frame)
    // Fast-Paced: parallel, no frame extraction (each scene animates from its own opening frame)
    if (startPhase === 'videos') {
      updateStoryEntry(taskUUID, { status: 'processing', currentPhase: 'videos', error: null });

      const isFastPacedVid = (current.pipelineMode === 'fast-paced');

      if (isFastPacedVid) {
        // ── Fast-Paced: parallel video generation ──
        const anyVidFailed = await runFastPacedVideoPhase(taskUUID, current, dir, startSceneIdx, endSceneIdx);
        if (anyVidFailed) return;
      } else {
        // ── Standard: sequential video generation with frame extraction ──
        // Flow:
        //   Scene 1: firstFrame = imageA, lastFrame = imageB → generate video → extract last frame
        //   Scene 2..N-1: firstFrame = extracted last frame from prev video, lastFrame = this scene's image
        //   Scene N (last): firstFrame = extracted last frame from prev video, lastFrame = CTA image
        const lastIdx = current.scenes.length - 1;
        const isKling = current.videoModel.startsWith('klingai:');
        const tempFrames = []; // track temp extracted frame files for cleanup

        // Find starting index — skip completed scenes
        let videoStartIdx = startSceneIdx;
        while (videoStartIdx <= lastIdx && current.scenes[videoStartIdx].videoStatus === 'completed') {
          videoStartIdx++;
        }

        if (videoStartIdx > lastIdx) {
          console.log(`[Story] All videos already completed, skipping video phase.`);
        } else {
          console.log(`[Story] ── Starting SEQUENTIAL video generation from scene ${videoStartIdx + 1} ──`);

          let anyVidFailed = false;

          for (let i = videoStartIdx; i <= (endSceneIdx !== null ? Math.min(endSceneIdx, lastIdx) : lastIdx); i++) {
            // Reload to get latest state
            current = loadStoryHistory().find(h => h.taskUUID === taskUUID);
            const scene = current.scenes[i];

            // Skip already completed
            if (scene.videoStatus === 'completed') {
              console.log(`[Story] Scene ${scene.sceneNumber} video already completed, skipping.`);
              continue;
            }

            const isFirst = (i === 0);
            const isLast = (i === lastIdx);

            // ── Determine first frame ──
            let firstFrameDataURI;
            if (isFirst) {
              // Scene 1: first frame = image A
              const imgAPath = path.join(dir, `scene_${scene.sceneNumber}_image.jpg`);
              if (!existsSync(imgAPath)) {
                console.error(`[Story] ❌ Scene ${scene.sceneNumber} image A not found — aborting video phase`);
                updateSceneInStory(taskUUID, i, { videoStatus: 'failed', videoError: 'Image A file not found on disk' });
                updateStoryEntry(taskUUID, { status: 'paused', currentPhase: 'videos', currentSceneIndex: i, error: `Scene ${scene.sceneNumber}: Image A not found` });
                anyVidFailed = true;
                break;
              }
              firstFrameDataURI = fileToDataURI(imgAPath, 'image/jpeg');
              console.log(`[Story] Scene ${scene.sceneNumber}: first frame = image A`);
            } else {
              // Scene 2+: extract last frame from previous scene's video
              const prevScene = current.scenes[i - 1];
              const prevVideoPath = path.join(dir, `scene_${prevScene.sceneNumber}_video.mp4`);
              if (!existsSync(prevVideoPath)) {
                console.error(`[Story] ❌ Scene ${scene.sceneNumber}: previous video (scene ${prevScene.sceneNumber}) not found — aborting`);
                updateSceneInStory(taskUUID, i, { videoStatus: 'failed', videoError: `Previous video (scene ${prevScene.sceneNumber}) not found` });
                updateStoryEntry(taskUUID, { status: 'paused', currentPhase: 'videos', currentSceneIndex: i, error: `Scene ${scene.sceneNumber}: previous video not found` });
                anyVidFailed = true;
                break;
              }

              const extractedFramePath = path.join(dir, `frame_after_scene_${prevScene.sceneNumber}.jpg`);
              try {
                console.log(`[Story] Scene ${scene.sceneNumber}: extracting last frame from scene ${prevScene.sceneNumber} video...`);
                await extractLastFrame(prevVideoPath, extractedFramePath);
                tempFrames.push(extractedFramePath);
                firstFrameDataURI = fileToDataURI(extractedFramePath, 'image/jpeg');
                console.log(`[Story] Scene ${scene.sceneNumber}: first frame = extracted from scene ${prevScene.sceneNumber} video ✅`);
              } catch (extractErr) {
                const errMsg = extractErr?.message || String(extractErr);
                console.error(`[Story] ❌ Scene ${scene.sceneNumber}: failed to extract frame from scene ${prevScene.sceneNumber}: ${errMsg}`);
                updateSceneInStory(taskUUID, i, { videoStatus: 'failed', videoError: `Frame extraction failed: ${errMsg}` });
                updateStoryEntry(taskUUID, { status: 'paused', currentPhase: 'videos', currentSceneIndex: i, error: `Scene ${scene.sceneNumber}: frame extraction failed` });
                anyVidFailed = true;
                break;
              }
            }

            // ── Determine last frame ──
            let lastFrameDataURI = null;
            if (isFirst) {
              // Scene 1: last frame = image B
              const imgBPath = path.join(dir, `scene_${scene.sceneNumber}_imageB.jpg`);
              if (existsSync(imgBPath)) {
                lastFrameDataURI = fileToDataURI(imgBPath, 'image/jpeg');
                console.log(`[Story] Scene ${scene.sceneNumber}: last frame = image B`);
              }
            } else if (isLast) {
              // Last scene: last frame = CTA image
              const ctaImgPath = path.join(dir, `scene_${scene.sceneNumber}_cta_image.jpg`);
              if (existsSync(ctaImgPath)) {
                lastFrameDataURI = fileToDataURI(ctaImgPath, 'image/jpeg');
                console.log(`[Story] Scene ${scene.sceneNumber} (last): last frame = CTA image`);
              }
            } else {
              // Middle scene: last frame = this scene's image (end frame)
              const imgPath = path.join(dir, `scene_${scene.sceneNumber}_image.jpg`);
              if (existsSync(imgPath)) {
                lastFrameDataURI = fileToDataURI(imgPath, 'image/jpeg');
                console.log(`[Story] Scene ${scene.sceneNumber}: last frame = scene image (end frame)`);
              }
            }

            // ── Build video payload ──
            const videoTaskUUID = randomUUID();
            const requestPayload = buildVideoPayload(isKling, current.videoModel, scene, videoTaskUUID, firstFrameDataURI, lastFrameDataURI);

            // ── Submit and poll ──
            updateSceneInStory(taskUUID, i, { videoStatus: 'generating', videoError: null, videoTaskUUID });
            updateStoryEntry(taskUUID, { currentSceneIndex: i });

            const label = `Story-Scene${scene.sceneNumber}-Vid`;
            console.log(`[Story] Scene ${scene.sceneNumber} video submit | ${isKling ? 'KlingAI' : 'Google'} | taskUUID: ${videoTaskUUID}`);

            try {
              const vidResult = await submitAndPoll(runware, requestPayload, label, videoTaskUUID);

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
            } catch (vidErr) {
              const errMsg = vidErr?.message || String(vidErr);
              console.error(`[Story] ❌ Scene ${scene.sceneNumber} video failed: ${errMsg}`);
              updateSceneInStory(taskUUID, i, { videoStatus: 'failed', videoError: errMsg });
              updateStoryEntry(taskUUID, {
                status: 'paused', currentPhase: 'videos', currentSceneIndex: i,
                error: `Scene ${scene.sceneNumber} video failed: ${errMsg}`,
              });
              anyVidFailed = true;
              break;
            }
          }

          // Cleanup temp extracted frames
          for (const tf of tempFrames) {
            await unlink(tf).catch(() => {});
          }

          console.log(`[Story] ── Video phase complete | anyFailed: ${anyVidFailed} ──────────────────`);

          if (anyVidFailed) return;
        }
      }

      // Single-scene run: pause after processing target video scene
      if (endSceneIdx !== null) {
        const reloadedV = loadStoryHistory().find(h => h.taskUUID === taskUUID);
        const nextVidPending = (reloadedV?.scenes || []).findIndex((s, i) => i > endSceneIdx && s.videoStatus !== 'completed');
        const nextVidIdx = nextVidPending >= 0 ? nextVidPending : endSceneIdx + 1;
        updateStoryEntry(taskUUID, { status: 'paused', currentPhase: 'videos', currentSceneIndex: Math.min(nextVidIdx, current.scenes.length - 1), pauseReason: 'manual' });
        console.log(`[Story] ⏸ Single-scene run done for video scene ${endSceneIdx + 1}. Paused.`);
        return;
      }

      // Manual mode pause before concat
      const afterVideosEntry = loadStoryHistory().find(h => h.taskUUID === taskUUID);
      if (afterVideosEntry?.runMode === 'manual') {
        updateStoryEntry(taskUUID, { status: 'paused', currentPhase: 'concat', pauseReason: 'manual' });
        console.log(`[Story] ⏸ Manual mode — paused before concat. Waiting for user.`);
        return;
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
        await concatMultipleVideos(videoPaths, finalPath, { width: 1080, height: 1920 });

        // Mix in background music if provided
        let finalOutputUrl = `/output/stories/${taskUUID}/final.mp4`;

        // Resolve music path — stored path may be absolute or relative to project root
        let resolvedMusicPath = current.musicFilePath || null;
        if (resolvedMusicPath && !path.isAbsolute(resolvedMusicPath)) {
          resolvedMusicPath = path.resolve(resolvedMusicPath);
        }
        console.log(`[Story] Music path: ${resolvedMusicPath || 'none'} | exists: ${resolvedMusicPath ? existsSync(resolvedMusicPath) : false}`);

        if (resolvedMusicPath && existsSync(resolvedMusicPath)) {
          console.log(`[Story] Mixing background music into final video...`);
          const musicFinalPath = path.join(dir, 'final_with_music.mp4');
          try {
            await mixMusicIntoVideo(finalPath, resolvedMusicPath, musicFinalPath, 0.3);
            finalOutputUrl = `/output/stories/${taskUUID}/final_with_music.mp4`;
            console.log(`[Story] ✅ Music mixed in → final_with_music.mp4`);
          } catch (musicErr) {
            console.warn(`[Story] ⚠ Music mix failed (non-fatal), using video without music: ${musicErr.message}`);
          }
        } else if (current.musicFilePath) {
          console.warn(`[Story] ⚠ Music file not found at: ${current.musicFilePath} — skipping music mix`);
        }

        // Calculate total cost (imageA + imageB + CTA + video costs)
        let totalCost = 0;
        for (const s of current.scenes) {
          if (s.imageCost) totalCost += s.imageCost;
          if (s.imageBCost) totalCost += s.imageBCost;
          if (s.ctaImageCost) totalCost += s.ctaImageCost;
          if (s.videoCost) totalCost += s.videoCost;
        }

        updateStoryEntry(taskUUID, {
          status: 'completed',
          currentPhase: 'done',
          completedAt: new Date().toISOString(),
          finalVideoUrl: finalOutputUrl,
          totalCost: totalCost || null,
          error: null,
        });
        console.log(`[Story] ✅ Pipeline COMPLETE | Final: ${finalOutputUrl} | Total cost: $${totalCost.toFixed(3)}`);
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

// ── GET /api/uploads ─────────────────────────────────────────────────────────
// Returns list of all uploaded files so the frontend can re-use them
router.get('/api/uploads', (req, res) => {
  const uploadsDir = path.resolve('uploads');
  const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
  const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg']);

  let files = [];
  try {
    files = readdirSync(uploadsDir)
      .map(filename => {
        const ext = path.extname(filename).toLowerCase();
        const type = IMAGE_EXT.has(ext) ? 'image' : AUDIO_EXT.has(ext) ? 'audio' : null;
        if (!type) return null; // skip videos and unknown files
        try {
          const st = statSync(path.join(uploadsDir, filename));
          return {
            filename,
            url: `/uploads/${filename}`,
            type,
            size: st.size,
            mtime: st.mtimeMs,
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime); // newest first
  } catch (e) {
    console.warn('[Story] Could not read uploads dir:', e.message);
  }
  res.json({ files });
});

// ── GET /api/story-models ────────────────────────────────────────────────────
router.get('/api/story-models', (req, res) => {
  res.json({ models: STORY_VIDEO_MODELS });
});

// ── GET /api/marketing-angles ────────────────────────────────────────────────
router.get('/api/marketing-angles', (req, res) => {
  if (!MARKETING_ANGLES_DATA) return res.status(404).json({ error: 'Marketing angles not loaded.' });
  res.json({
    angles: MARKETING_ANGLES_DATA.marketing_angles,
    game: MARKETING_ANGLES_DATA.game,
    creative_guardrails: MARKETING_ANGLES_DATA.creative_guardrails,
  });
});

// ── GET /api/hero-catalog ─────────────────────────────────────────────────────
router.get('/api/hero-catalog', (req, res) => {
  if (!HEROES_DATA) return res.json({ heroes: [] });
  const heroes = (HEROES_DATA.heroes || []).map(h => ({
    name: h.name,
    class: h.class,
    lore_description: h.lore_description,
  }));
  res.json({ heroes });
});

// ── POST /api/generate-video-desc ────────────────────────────────────────────
router.post('/api/generate-video-desc', async (req, res) => {
  const { angleId, gameContext, heroDesc, namedHeroes } = req.body;
  if (!angleId) return res.status(400).json({ error: 'angleId is required.' });
  if (!MARKETING_ANGLES_DATA) return res.status(503).json({ error: 'Marketing angles data not loaded.' });

  const angle = MARKETING_ANGLES_DATA.marketing_angles.find(a => a.id === Number(angleId));
  if (!angle) return res.status(404).json({ error: `Angle ID ${angleId} not found.` });

  try {
    const description = await generateVideoDescription(
      angle,
      MARKETING_ANGLES_DATA,
      gameContext || '',
      heroDesc || '',
      Array.isArray(namedHeroes) ? namedHeroes : [],
    );
    res.json({ description });
  } catch (err) {
    console.error('[Story] generateVideoDescription error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/generate-story ─────────────────────────────────────────────────
// Multipart: heroImages[] (optional, up to 6), bgImage (optional) + form fields
const storyUpload = uploadStory.fields([
  { name: 'heroImages', maxCount: 6 },
  { name: 'bgImage', maxCount: 1 },
  { name: 'musicFile', maxCount: 1 },
]);

router.post('/api/generate-story', storyUpload, async (req, res) => {
  const { storyText, durationRange, gameContext, voiceDesc, heroDesc, videoModel, pipelineMode, runMode } = req.body;

  // storyText is optional when a valid planningJson is injected
  const hasInjectedPlan = (() => {
    try { const p = JSON.parse(req.body.planningJson || ''); return Array.isArray(p?.scenes) && p.scenes.length > 0; }
    catch { return false; }
  })();
  if (!storyText?.trim() && !hasInjectedPlan) {
    return res.status(400).json({ error: 'Story text is required (or provide a planning JSON).' });
  }

  // Parse duration range "15-30" → { min: 15, max: 30 }
  const [durMin, durMax] = (durationRange || '15-30').split('-').map(Number);
  const model = videoModel || 'google:3@3';
  const modelInfo = STORY_VIDEO_MODELS.find(m => m.id === model);
  const taskUUID = randomUUID();
  const mode = (pipelineMode === 'fast-paced') ? 'fast-paced' : 'standard';

  // Hero images: accept uploaded files AND/OR server-path refs from media picker.
  // Multer v2 with multipart stores bracket fields as the LITERAL key 'heroImagePaths[]'.
  // We also check 'heroImagePaths' (no brackets) as a fallback.
  const heroImagePathsFromFiles = (req.files?.heroImages || []).map(f => f.path);
  // Multer strips [] from field names: 'heroImagePaths[]' arrives as 'heroImagePaths'
  const rawHeroRefs =
    req.body['heroImagePaths'] ??
    req.body['heroImagePaths[]'] ??
    [];
  const heroImageRefs = [].concat(rawHeroRefs).filter(v => v && typeof v === 'string').map(uploadRefToDiskPath).filter(Boolean);
  const heroImagePaths = [...heroImagePathsFromFiles, ...heroImageRefs];

  // Background image: uploaded file OR server-path ref
  const bgImagePath = req.files?.bgImage?.[0]?.path || uploadRefToDiskPath(req.body.bgImageRef) || null;

  // Music file: uploaded file OR server-path ref
  const musicFilePath = req.files?.musicFile?.[0]?.path || uploadRefToDiskPath(req.body.musicFileRef) || null;

  // Named heroes (from catalog, no image)
  const namedHeroes = (() => { try { return JSON.parse(req.body.namedHeroes || '[]'); } catch { return []; } })();

  // Optional pre-built planning JSON — skips Claude planning phase entirely
  const injectedPlan = (() => {
    const raw = req.body.planningJson;
    if (!raw || !raw.trim()) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.scenes) || parsed.scenes.length === 0) return null;
      return parsed; // { scenes: [...], voiceOverCharacteristics: "..." }
    } catch {
      return null;
    }
  })();

  console.log(`\n[Story] ── New Story Request ──────────────────────`);
  console.log(`[Story]  taskUUID    : ${taskUUID}`);
  console.log(`[Story]  Duration    : ${durMin}-${durMax}s (AI picks scene count)`);
  console.log(`[Story]  Mode        : ${mode}`);
  console.log(`[Story]  Model       : ${model}`);
  console.log(`[Story]  HeroImages  : ${heroImagePaths.length > 0 ? heroImagePaths.join(', ') : 'none'}`);
  console.log(`[Story]  NamedHeroes : ${namedHeroes.length > 0 ? namedHeroes.join(', ') : 'none'}`);
  console.log(`[Story]  BgImg       : ${bgImagePath || 'none'}`);
  console.log(`[Story]  Music       : ${musicFilePath || 'none'}`);
  console.log(`[Story]  PlanJSON    : ${injectedPlan ? `✅ injected (${injectedPlan.scenes.length} scenes — skipping Claude)` : 'none (Claude will plan)'}`);
  console.log(`[Story]  Story       : ${storyText.slice(0, 80)}...`);

  addStoryEntry({
    taskUUID,
    type: 'story',
    status: 'pending',
    submittedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    storyText: storyText.trim(),
    durationRange: `${durMin}-${durMax}`,
    durationMin: durMin,
    durationMax: durMax,
    gameContext: (gameContext || '').trim(),
    voiceDesc: (voiceDesc || '').trim(),
    heroDesc: (heroDesc || '').trim(),
    videoModel: model,
    videoModelLabel: modelInfo?.label || model,
    pipelineMode: mode,
    voiceOverCharacteristics: null, // Claude will populate this during planning
    heroImagePath: heroImagePaths[0] || null,   // backward compat — first hero image path
    heroImagePaths,   // full array of hero image paths
    namedHeroes,      // hero names from catalog (no image)
    bgImagePath,      // saved for resume — Claude + Nano Bana 2 reference
    musicFilePath,    // saved for resume — mixed into final video at low volume
    injectedPlan,     // pre-built planning JSON (null = let Claude plan)
    runMode: runMode === 'manual' ? 'manual' : 'auto',  // 'auto' | 'manual'
    pauseReason: null,
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

  // forcePhase lets the caller jump directly to a specific phase (e.g. 'concat')
  const { forcePhase } = req.body || {};
  if (forcePhase) {
    updateStoryEntry(taskUUID, { currentPhase: forcePhase, currentSceneIndex: 0 });
  }

  const reloaded = loadStoryHistory().find(h => h.taskUUID === taskUUID);
  const phase = reloaded?.currentPhase || 'planning';
  const sceneIdx = reloaded?.currentSceneIndex || 0;

  console.log(`[Story] ── Resume Request ──────────────────────`);
  console.log(`[Story]  taskUUID: ${taskUUID} | phase: ${phase} | scene: ${sceneIdx}${forcePhase ? ` (forced to ${forcePhase})` : ''}`);

  updateStoryEntry(taskUUID, { status: 'processing', error: null, pauseReason: null });
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
  const isFastPaced = (entry.pipelineMode === 'fast-paced');

  // Apply optional prompt overrides
  const { imagePrompt, videoPrompt } = req.body || {};
  if (imagePrompt) updateSceneInStory(taskUUID, idx, { imagePrompt });
  if (videoPrompt) updateSceneInStory(taskUUID, idx, { videoPrompt });

  // Determine which step failed
  const isFirst = (idx === 0);
  const isLast = (idx === entry.scenes.length - 1);
  let retryPhase;

  // In fast-paced mode: all scenes have imagePrompt (no imageBPrompt)
  // In standard mode: last scene has no imagePrompt (skipped)
  const imgFailed = isFastPaced
    ? (scene.imageStatus === 'failed' || scene.imageStatus === 'pending')
    : (!isLast && (scene.imageStatus === 'failed' || scene.imageStatus === 'pending'));
  const imgBFailed = !isFastPaced && isFirst && scene.imageBPrompt && (scene.imageBStatus === 'failed' || scene.imageBStatus === 'pending');
  const ctaFailed = isLast && scene.ctaImagePrompt && (scene.ctaImageStatus === 'failed' || scene.ctaImageStatus === 'pending');

  if (imgFailed || imgBFailed || ctaFailed) {
    retryPhase = 'images';
    // Reset image(s) and video for this scene
    const updates = { videoStatus: 'pending', videoError: null };
    if (imgFailed) { updates.imageStatus = 'pending'; updates.imageError = null; }
    if (imgBFailed) { updates.imageBStatus = 'pending'; updates.imageBError = null; }
    if (ctaFailed) { updates.ctaImageStatus = 'pending'; updates.ctaImageError = null; }
    updateSceneInStory(taskUUID, idx, updates);
    if (isFastPaced) {
      // Fast-paced: no sequential dependency — only reset this scene's video
      // (already reset above via updates)
    } else {
      // Standard: reset all subsequent videos (sequential dependency)
      for (let j = idx + 1; j < entry.scenes.length; j++) {
        updateSceneInStory(taskUUID, j, { videoStatus: 'pending', videoError: null });
      }
    }
  } else if (scene.videoStatus === 'failed' || scene.videoStatus === 'pending') {
    retryPhase = 'videos';
    if (isFastPaced) {
      // Fast-paced: only reset this scene (each video is independent)
      updateSceneInStory(taskUUID, idx, { videoStatus: 'pending', videoError: null });
    } else {
      // Standard: reset this scene + all subsequent videos (sequential dependency)
      for (let j = idx; j < entry.scenes.length; j++) {
        updateSceneInStory(taskUUID, j, { videoStatus: 'pending', videoError: null });
      }
    }
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

// ── POST /api/run-single-scene/:taskUUID/:sceneIndex ─────────────────────────
// Run image or video generation for exactly ONE scene, even while the pipeline is running.
// This allows node-by-node manual execution without blocking on overall status.
router.post('/api/run-single-scene/:taskUUID/:sceneIndex', async (req, res) => {
  const { taskUUID, sceneIndex } = req.params;
  const idx = parseInt(sceneIndex);
  const entry = loadStoryHistory().find(h => h.taskUUID === taskUUID);

  if (!entry) return res.status(404).json({ error: 'Story not found.' });
  if (!entry.scenes?.[idx]) return res.status(400).json({ error: 'Invalid scene index.' });

  const scene = entry.scenes[idx];
  const isFP = entry.pipelineMode === 'fast-paced';
  const isFirst = (idx === 0);
  const isLast = (idx === entry.scenes.length - 1);

  // Apply optional prompt overrides
  const { imagePrompt, videoPrompt, ctaImagePrompt } = req.body || {};
  if (imagePrompt) updateSceneInStory(taskUUID, idx, { imagePrompt });
  if (videoPrompt) updateSceneInStory(taskUUID, idx, { videoPrompt });
  if (ctaImagePrompt) updateSceneInStory(taskUUID, idx, { ctaImagePrompt });

  // Determine what needs to run for this scene
  const needsImage = isFP
    ? scene.imageStatus === 'pending' || scene.imageStatus === 'failed'
    : !isLast && (scene.imageStatus === 'pending' || scene.imageStatus === 'failed');
  const needsImageB = !isFP && isFirst && scene.imageBPrompt &&
    (scene.imageBStatus === 'pending' || scene.imageBStatus === 'failed');
  const needsCTA = isLast && scene.ctaImagePrompt &&
    (scene.ctaImageStatus === 'pending' || scene.ctaImageStatus === 'failed');
  const needsVideo = !needsImage && !needsImageB && !needsCTA &&
    (scene.videoStatus === 'pending' || scene.videoStatus === 'failed');

  if (!needsImage && !needsImageB && !needsCTA && !needsVideo) {
    return res.status(400).json({ error: 'Scene has nothing pending to run.' });
  }

  const phase = needsVideo ? 'video' : 'image';
  console.log(`[Story] ── Run Single Scene ${idx + 1} (${phase}) ──────────────────────`);
  res.json({ success: true, message: `Running scene ${idx + 1} (${phase})` });

  // Run independently without blocking on / modifying entry.status
  const dir = path.join('output', 'stories', taskUUID);
  const freshEntry = loadStoryHistory().find(h => h.taskUUID === taskUUID);
  const freshScene = freshEntry?.scenes?.[idx];
  if (!freshScene) return;

  // Load reference images
  const heroPaths = (freshEntry.heroImagePaths?.length > 0)
    ? freshEntry.heroImagePaths
    : (freshEntry.heroImagePath ? [freshEntry.heroImagePath] : []);
  const heroDataURIs = heroPaths.filter(p => p && existsSync(p)).map(p => fileToDataURI(p, getMimeType(p)));
  const bgDataURI = freshEntry.bgImagePath && existsSync(freshEntry.bgImagePath)
    ? fileToDataURI(freshEntry.bgImagePath, getMimeType(freshEntry.bgImagePath)) : null;
  const ctaRefPath = path.join('public', 'reference.jpg');
  const ctaDataURI = existsSync(ctaRefPath) ? fileToDataURI(ctaRefPath, 'image/jpeg') : null;

  const referenceImages = [...heroDataURIs];
  if (freshScene.useBgRef && bgDataURI) referenceImages.push(bgDataURI);

  if (needsVideo) {
    // ── Run video for this scene ──
    updateSceneInStory(taskUUID, idx, { videoStatus: 'generating', videoError: null });
    try {
      const s = loadStoryHistory().find(h => h.taskUUID === taskUUID)?.scenes?.[idx];
      if (!s) return;

      // Build first frame data URI (image A)
      const imgPath = path.join(dir, `scene_${s.sceneNumber}_image.jpg`);
      const firstFrameDataURI = existsSync(imgPath) ? fileToDataURI(imgPath, 'image/jpeg') : null;
      // Build last frame data URI (image B for scene 1 standard mode)
      const imgBPath = path.join(dir, `scene_${s.sceneNumber}_imageB.jpg`);
      const lastFrameDataURI = (!isFP && isFirst && existsSync(imgBPath))
        ? fileToDataURI(imgBPath, 'image/jpeg') : null;

      const isKling = freshEntry.videoModel?.startsWith?.('klingai');
      const videoTaskUUID = randomUUID();
      const payload = buildVideoPayload(isKling, freshEntry.videoModel, s, videoTaskUUID, firstFrameDataURI, lastFrameDataURI);
      const label = `Story-Scene${s.sceneNumber}-Vid-Solo`;
      console.log(`[Story] Scene ${s.sceneNumber}: run-single video | taskUUID: ${videoTaskUUID}`);
      const vid = await submitAndPoll(API_KEY, payload, label);
      const vidURL = vid?.videoURL || vid?.url;
      if (!vidURL) throw new Error(`No video URL in response`);
      const vidFilename = `scene_${s.sceneNumber}_video.mp4`;
      const vidPath = path.join(dir, vidFilename);
      await downloadVideo(vidURL, vidPath);
      const cost = vid?.cost ?? vid?.taskCost ?? null;
      updateSceneInStory(taskUUID, idx, {
        videoStatus: 'completed', videoUrl: `/output/stories/${taskUUID}/${vidFilename}`, videoCost: cost,
      });
      console.log(`[Story] ✅ Scene ${s.sceneNumber} solo video done | cost: ${cost !== null ? '$' + cost : 'N/A'}`);
    } catch (err) {
      const msg = err?.message || String(err);
      console.error(`[Story] ❌ Scene ${idx + 1} solo video failed: ${msg}`);
      updateSceneInStory(taskUUID, idx, { videoStatus: 'failed', videoError: msg });
    }
    return;
  }

  // ── Run image(s) for this scene ──
  const jobs = [];
  if (needsImage && freshScene.imagePrompt) {
    const t = randomUUID();
    const payload = { taskUUID: t, model: 'google:4@3', positivePrompt: freshScene.imagePrompt,
      width: 3072, height: 5504, numberResults: 1, includeCost: true, outputType: ['URL'] };
    if (referenceImages.length > 0) payload.inputs = { referenceImages };
    jobs.push({ type: 'scene', task: { payload, taskUUID: t } });
  }
  if (needsImageB && freshScene.imageBPrompt) {
    const t = randomUUID();
    const payload = { taskUUID: t, model: 'google:4@3', positivePrompt: freshScene.imageBPrompt,
      width: 3072, height: 5504, numberResults: 1, includeCost: true, outputType: ['URL'] };
    if (referenceImages.length > 0) payload.inputs = { referenceImages };
    jobs.push({ type: 'imageB', task: { payload, taskUUID: t } });
  }
  if (needsCTA && freshScene.ctaImagePrompt) {
    const t = randomUUID();
    const ctaRefs = [...referenceImages];
    if (ctaDataURI) ctaRefs.push(ctaDataURI);
    const payload = { taskUUID: t, model: 'google:4@3', positivePrompt: freshScene.ctaImagePrompt,
      width: 3072, height: 5504, numberResults: 1, includeCost: true, outputType: ['URL'] };
    if (ctaRefs.length > 0) payload.inputs = { referenceImages: ctaRefs };
    jobs.push({ type: 'cta', task: { payload, taskUUID: t } });
  }

  if (jobs.length === 0) return;

  // Mark all as generating
  for (const job of jobs) {
    if (job.type === 'scene') updateSceneInStory(taskUUID, idx, { imageStatus: 'generating', imageError: null });
    else if (job.type === 'imageB') updateSceneInStory(taskUUID, idx, { imageBStatus: 'generating', imageBError: null });
    else if (job.type === 'cta') updateSceneInStory(taskUUID, idx, { ctaImageStatus: 'generating', ctaImageError: null });
  }

  const results = await Promise.allSettled(
    jobs.map(async (job) => {
      const label = `Story-Scene${freshScene.sceneNumber}${job.type === 'cta' ? '-CTA' : job.type === 'imageB' ? '-FrameB' : ''}-Img-Solo`;
      const img = await imageSubmitAndPollOwn(API_KEY, job.task.payload, label);
      return { type: job.type, img };
    })
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') {
      const msg = result.reason?.message || String(result.reason);
      const { type } = result.value || result.reason || {};
      // mark failed — we need the type from jobs array
      continue; // handle below
    }
    const { type, img } = result.value;
    try {
      const imgURL = img?.imageURL || img?.url || img?.outputURL;
      if (!imgURL) throw new Error(`No image URL in response`);
      const suffix = type === 'cta' ? '_cta_image' : type === 'imageB' ? '_imageB' : '_image';
      const filename = `scene_${freshScene.sceneNumber}${suffix}.jpg`;
      await downloadImage(imgURL, path.join(dir, filename));
      const cost = img?.cost ?? img?.taskCost ?? null;
      if (type === 'cta') updateSceneInStory(taskUUID, idx, { ctaImageStatus: 'completed', ctaImageUrl: `/output/stories/${taskUUID}/${filename}`, ctaImageCost: cost });
      else if (type === 'imageB') updateSceneInStory(taskUUID, idx, { imageBStatus: 'completed', imageBUrl: `/output/stories/${taskUUID}/${filename}`, imageBCost: cost });
      else updateSceneInStory(taskUUID, idx, { imageStatus: 'completed', imageUrl: `/output/stories/${taskUUID}/${filename}`, imageCost: cost });
      console.log(`[Story] ✅ Scene ${freshScene.sceneNumber} solo ${type} image done`);
    } catch (err) {
      const msg = err?.message || String(err);
      if (type === 'cta') updateSceneInStory(taskUUID, idx, { ctaImageStatus: 'failed', ctaImageError: msg });
      else if (type === 'imageB') updateSceneInStory(taskUUID, idx, { imageBStatus: 'failed', imageBError: msg });
      else updateSceneInStory(taskUUID, idx, { imageStatus: 'failed', imageError: msg });
      console.error(`[Story] ❌ Scene ${freshScene.sceneNumber} solo ${type} image failed: ${msg}`);
    }
  }
  // Handle rejected promises
  for (let ri = 0; ri < results.length; ri++) {
    if (results[ri].status === 'rejected') {
      const msg = results[ri].reason?.message || String(results[ri].reason);
      const type = jobs[ri].type;
      if (type === 'cta') updateSceneInStory(taskUUID, idx, { ctaImageStatus: 'failed', ctaImageError: msg });
      else if (type === 'imageB') updateSceneInStory(taskUUID, idx, { imageBStatus: 'failed', imageBError: msg });
      else updateSceneInStory(taskUUID, idx, { imageStatus: 'failed', imageError: msg });
      console.error(`[Story] ❌ Scene ${freshScene.sceneNumber} solo ${type} image rejected: ${msg}`);
    }
  }
});

// ── POST /api/resubmit-images/:taskUUID ─────────────────────────────────────
// Manually re-submit ALL pending/failed images from scratch (resets their status to pending)
router.post('/api/resubmit-images/:taskUUID', async (req, res) => {
  const { taskUUID } = req.params;
  const entry = loadStoryHistory().find(h => h.taskUUID === taskUUID);

  if (!entry) return res.status(404).json({ error: 'Story not found.' });
  if (!entry.scenes || entry.scenes.length === 0) return res.status(400).json({ error: 'No scenes found — story must be planned first.' });
  if (entry.status === 'processing') return res.status(400).json({ error: 'Pipeline already running.' });

  const lastIdx = entry.scenes.length - 1;
  const isFastPacedImg = (entry.pipelineMode === 'fast-paced');

  // Find scenes that need image work (mode-aware)
  const toReset = entry.scenes
    .map((s, i) => i)
    .filter(i => {
      const s = entry.scenes[i];
      const isFirst = (i === 0);
      const isLast = (i === lastIdx);
      if (isFastPacedImg) {
        // Fast-paced: all scenes have imagePrompt; last scene also has CTA
        if (s.imageStatus !== 'completed') return true;
        if (isLast && s.ctaImagePrompt && s.ctaImageStatus !== 'completed') return true;
        return false;
      }
      // Standard:
      if (isFirst) {
        return s.imageStatus !== 'completed' || (s.imageBPrompt && s.imageBStatus !== 'completed');
      }
      if (isLast) {
        return s.ctaImagePrompt && s.ctaImageStatus !== 'completed';
      }
      return s.imageStatus !== 'completed';
    });

  if (toReset.length === 0) {
    return res.status(400).json({ error: 'All images are already completed.' });
  }

  console.log(`[Story] ── Manual Resubmit Images ──────────────────────`);
  console.log(`[Story]  taskUUID: ${taskUUID} | resetting ${toReset.length} scene(s): [${toReset.join(', ')}]`);

  // Reset those scenes' image + video status to pending
  for (const i of toReset) {
    const s = entry.scenes[i];
    const isFirst = (i === 0);
    const isLast = (i === lastIdx);

    const updates = {
      videoStatus: 'pending', videoError: null, // reset video too since images changed
    };
    if (isFastPacedImg) {
      // Fast-paced: all scenes have imagePrompt; last also has CTA
      updates.imageStatus = 'pending';
      updates.imageError = null;
      if (isLast && s.ctaImagePrompt) {
        updates.ctaImageStatus = 'pending';
        updates.ctaImageError = null;
      }
    } else if (isLast) {
      // Standard last scene: only CTA image
      if (s.ctaImagePrompt) {
        updates.ctaImageStatus = 'pending';
        updates.ctaImageError = null;
      }
    } else {
      updates.imageStatus = 'pending';
      updates.imageError = null;
      // Scene 1: also reset imageB
      if (isFirst && s.imageBPrompt) {
        updates.imageBStatus = 'pending';
        updates.imageBError = null;
      }
    }
    updateSceneInStory(taskUUID, i, updates);
  }

  if (!isFastPacedImg) {
    // Standard: also reset all videos after the first reset scene (sequential dependency)
    for (let i = toReset[0]; i <= lastIdx; i++) {
      if (!toReset.includes(i)) {
        updateSceneInStory(taskUUID, i, { videoStatus: 'pending', videoError: null });
      }
    }
  }

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
// Re-submit videos from the first failed/pending scene onward (sequential dependency)
router.post('/api/resubmit-videos/:taskUUID', async (req, res) => {
  const { taskUUID } = req.params;
  const entry = loadStoryHistory().find(h => h.taskUUID === taskUUID);

  if (!entry) return res.status(404).json({ error: 'Story not found.' });
  if (!entry.scenes || entry.scenes.length === 0) return res.status(400).json({ error: 'No scenes found — story must be planned first.' });
  if (entry.status === 'processing') return res.status(400).json({ error: 'Pipeline already running.' });

  const isFastPacedResubmit = (entry.pipelineMode === 'fast-paced');

  // Find first non-completed video scene
  const firstPending = entry.scenes.findIndex(s => s.videoStatus !== 'completed');
  if (firstPending === -1) {
    return res.status(400).json({ error: 'All videos are already completed.' });
  }

  let toReset;
  if (isFastPacedResubmit) {
    // Fast-paced: each video is independent — only reset non-completed scenes
    toReset = entry.scenes.map((s, i) => i).filter(i => entry.scenes[i].videoStatus !== 'completed');
    console.log(`[Story] ── Manual Resubmit Videos (fast-paced parallel) ──────────────────────`);
    console.log(`[Story]  taskUUID: ${taskUUID} | resetting ${toReset.length} non-completed scene(s): [${toReset.join(', ')}]`);
  } else {
    // Standard: reset ALL scenes from firstPending onward (sequential: later scenes depend on earlier ones)
    toReset = entry.scenes.map((s, i) => i).filter(i => i >= firstPending);
    console.log(`[Story] ── Manual Resubmit Videos (sequential) ──────────────────────`);
    console.log(`[Story]  taskUUID: ${taskUUID} | resetting scenes ${firstPending + 1} onward (${toReset.length} scene(s))`);
  }

  for (const i of toReset) {
    updateSceneInStory(taskUUID, i, {
      videoStatus: 'pending', videoError: null, videoTaskUUID: null,
    });
  }

  updateStoryEntry(taskUUID, {
    status: 'processing',
    currentPhase: 'videos',
    currentSceneIndex: firstPending,
    error: null,
  });

  res.json({ success: true, message: `Re-submitting ${toReset.length} video(s)...` });

  // Run pipeline from videos phase
  runPipeline(taskUUID, 'videos', firstPending);
});

// ── POST /api/run-scene-only/:taskUUID/:sceneIndex ───────────────────────────
// Runs ONLY a single scene node (image or video) then pauses with pauseReason:'manual'.
// Used by manual-mode canvas to run nodes one-by-one.
router.post('/api/run-scene-only/:taskUUID/:sceneIndex', async (req, res) => {
  const { taskUUID, sceneIndex } = req.params;
  const idx = parseInt(sceneIndex);
  const entry = loadStoryHistory().find(h => h.taskUUID === taskUUID);

  if (!entry) return res.status(404).json({ error: 'Story not found.' });
  if (!entry.scenes?.[idx]) return res.status(400).json({ error: 'Invalid scene index.' });
  if (entry.status === 'processing') return res.status(400).json({ error: 'Pipeline already running.' });

  const scene = entry.scenes[idx];
  const isFastPaced = (entry.pipelineMode === 'fast-paced');
  const isLast = (idx === entry.scenes.length - 1);

  // Determine which phase this scene needs to run
  // Images phase: image/imageB/CTA not completed
  const needsImage = isFastPaced
    ? (scene.imageStatus !== 'completed' || (isLast && scene.ctaImagePrompt && scene.ctaImageStatus !== 'completed'))
    : (scene.imageStatus !== 'completed' || (idx === 0 && scene.imageBPrompt && scene.imageBStatus !== 'completed') || (isLast && scene.ctaImagePrompt && scene.ctaImageStatus !== 'completed'));

  // Videos phase: video not completed (only if images are done)
  const needsVideo = !needsImage && scene.videoStatus !== 'completed';

  if (!needsImage && !needsVideo) {
    return res.status(400).json({ error: 'Scene already completed — nothing to run.' });
  }

  const phase = needsImage ? 'images' : 'videos';

  // Reset the target scene's status to pending
  if (phase === 'images') {
    const updates = {};
    if (scene.imageStatus !== 'completed') { updates.imageStatus = 'pending'; updates.imageError = null; }
    if (idx === 0 && scene.imageBPrompt && scene.imageBStatus !== 'completed') { updates.imageBStatus = 'pending'; updates.imageBError = null; }
    if (isLast && scene.ctaImagePrompt && scene.ctaImageStatus !== 'completed') { updates.ctaImageStatus = 'pending'; updates.ctaImageError = null; }
    updateSceneInStory(taskUUID, idx, updates);
  } else {
    updateSceneInStory(taskUUID, idx, { videoStatus: 'pending', videoError: null });
  }

  console.log(`[Story] ── Run Scene Only: scene ${idx + 1} | phase: ${phase} ──────────────`);
  updateStoryEntry(taskUUID, { status: 'processing', currentPhase: phase, currentSceneIndex: idx, error: null, pauseReason: null });
  res.json({ success: true, message: `Running ${phase} for scene ${idx + 1} only...` });

  // Run pipeline with endSceneIdx = idx to stop after this one scene
  runPipeline(taskUUID, phase, idx, idx);
});

// ── POST /api/regen-image/:taskUUID/:sceneIndex ──────────────────────────────
// Regenerate only the image(s) for one specific completed scene (user doesn't like the result).
// Resets image status → pending, resets that scene's video too (image changed = video must redo).
// In standard mode also resets subsequent videos (sequential dependency on frame extraction).
router.post('/api/regen-image/:taskUUID/:sceneIndex', async (req, res) => {
  const { taskUUID, sceneIndex } = req.params;
  const idx = parseInt(sceneIndex);
  const entry = loadStoryHistory().find(h => h.taskUUID === taskUUID);

  if (!entry) return res.status(404).json({ error: 'Story not found.' });
  if (!entry.scenes?.[idx]) return res.status(400).json({ error: 'Invalid scene index.' });
  if (entry.status === 'processing') return res.status(400).json({ error: 'Pipeline already running.' });

  const scene = entry.scenes[idx];
  const isFastPaced = (entry.pipelineMode === 'fast-paced');
  const isFirst = (idx === 0);
  const isLast = (idx === entry.scenes.length - 1);

  // Apply optional prompt override
  const { imagePrompt, ctaImagePrompt } = req.body || {};
  if (imagePrompt) updateSceneInStory(taskUUID, idx, { imagePrompt });
  if (ctaImagePrompt) updateSceneInStory(taskUUID, idx, { ctaImagePrompt });

  // Reset image(s) for this scene + its own video (image changed → video must redo)
  const updates = { videoStatus: 'pending', videoError: null, videoTaskUUID: null };

  if (isFastPaced || !isLast) {
    updates.imageStatus = 'pending';
    updates.imageError = null;
    updates.imageUrl = null;
  }
  if (!isFastPaced && isFirst && scene.imageBPrompt) {
    updates.imageBStatus = 'pending';
    updates.imageBError = null;
    updates.imageBUrl = null;
  }
  if (isLast && scene.ctaImagePrompt) {
    updates.ctaImageStatus = 'pending';
    updates.ctaImageError = null;
    updates.ctaImageUrl = null;
  }
  updateSceneInStory(taskUUID, idx, updates);

  // Standard mode: subsequent videos depend on frame extraction — reset them too
  if (!isFastPaced) {
    for (let j = idx + 1; j < entry.scenes.length; j++) {
      updateSceneInStory(taskUUID, j, { videoStatus: 'pending', videoError: null, videoTaskUUID: null });
    }
  }

  console.log(`[Story] ── Regen Image Scene ${idx + 1} ──────────────────────`);
  updateStoryEntry(taskUUID, { status: 'processing', currentPhase: 'images', currentSceneIndex: idx, error: null });
  res.json({ success: true, message: `Regenerating image for scene ${idx + 1}...` });
  runPipeline(taskUUID, 'images', idx);
});

// ── POST /api/regen-video/:taskUUID/:sceneIndex ───────────────────────────────
// Regenerate only the video for one specific completed scene (user doesn't like the result).
// In fast-paced mode: only this scene's video. In standard mode: this + all subsequent videos.
router.post('/api/regen-video/:taskUUID/:sceneIndex', async (req, res) => {
  const { taskUUID, sceneIndex } = req.params;
  const idx = parseInt(sceneIndex);
  const entry = loadStoryHistory().find(h => h.taskUUID === taskUUID);

  if (!entry) return res.status(404).json({ error: 'Story not found.' });
  if (!entry.scenes?.[idx]) return res.status(400).json({ error: 'Invalid scene index.' });
  if (entry.status === 'processing') return res.status(400).json({ error: 'Pipeline already running.' });

  const isFastPaced = (entry.pipelineMode === 'fast-paced');

  // Apply optional prompt override
  const { videoPrompt } = req.body || {};
  if (videoPrompt) updateSceneInStory(taskUUID, idx, { videoPrompt });

  if (isFastPaced) {
    // Fast-paced: each video is independent — only reset this one
    updateSceneInStory(taskUUID, idx, { videoStatus: 'pending', videoError: null, videoTaskUUID: null });
  } else {
    // Standard: reset this scene + all subsequent (sequential frame extraction dependency)
    for (let j = idx; j < entry.scenes.length; j++) {
      updateSceneInStory(taskUUID, j, { videoStatus: 'pending', videoError: null, videoTaskUUID: null });
    }
  }

  console.log(`[Story] ── Regen Video Scene ${idx + 1} ──────────────────────`);
  updateStoryEntry(taskUUID, { status: 'processing', currentPhase: 'videos', currentSceneIndex: idx, error: null });
  res.json({ success: true, message: `Regenerating video for scene ${idx + 1}...` });
  runPipeline(taskUUID, 'videos', idx);
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
