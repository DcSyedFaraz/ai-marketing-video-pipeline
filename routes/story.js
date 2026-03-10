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
import { existsSync } from 'fs';
import path from 'path';

import { STORY_VIDEO_MODELS } from '../lib/models.js';
import { planScenes } from '../lib/gemini.js';
import { fileToDataURI, downloadVideo, downloadImage, getMimeType } from '../lib/helpers.js';
import { concatMultipleVideos, extractLastFrame } from '../lib/ffmpeg.js';
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
    const isFirstScene = (i === 0);
    const isLastScene = (i === geminiScenes.length - 1);

    const scene = {
      sceneNumber: s.sceneNumber,
      imagePrompt: s.imagePrompt || '',
      videoPrompt: s.videoPrompt,
      duration: s.duration,
      useHeroRef: s.useHeroRef || false,
      useBgRef: s.useBgRef || false,
      // Image A status — first scene + middle scenes have imagePrompt
      imageStatus: isLastScene ? 'skipped' : 'pending',
      imageUrl: null,
      imageError: null,
      imageCost: null,
      videoStatus: 'pending',
      videoUrl: null,
      videoTaskUUID: null,
      videoError: null,
      videoCost: null,
    };
    // First scene: also has imageBPrompt (frame B / end frame)
    if (isFirstScene && s.imageBPrompt) {
      scene.imageBPrompt = s.imageBPrompt;
      scene.imageBStatus = 'pending';
      scene.imageBUrl = null;
      scene.imageBError = null;
      scene.imageBCost = null;
    }
    // Last scene: only CTA image (no imagePrompt)
    if (isLastScene && s.ctaImagePrompt) {
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
  return path.resolve('output', 'stories', taskUUID);
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
        // Look up selected model's exact allowed durations for Claude
        const modelInfo = STORY_VIDEO_MODELS.find(m => m.id === entry.videoModel);
        const allowedDurations = modelInfo?.allowedDurations || [5, 8];

        const geminiResult = await planScenes(
          entry.storyText,
          { min: entry.durationMin || 15, max: entry.durationMax || 30 },
          entry.gameContext, entry.voiceDesc, entry.heroDesc,
          { heroImagePath: entry.heroImagePath || null, backgroundImagePath: entry.bgImagePath || null },
          allowedDurations,
        );
        const scenes = initSceneProgress(geminiResult.scenes);
        const sceneCount = scenes.length;
        const totalDuration = scenes.reduce((sum, s) => sum + (s.duration || 0), 0);
        const voiceOver = geminiResult.voiceOverCharacteristics || entry.voiceDesc || '';
        updateStoryEntry(taskUUID, {
          scenes,
          sceneCount,
          voiceOverCharacteristics: voiceOver,
          currentPhase: 'images',
          currentSceneIndex: 0,
        });
        console.log(`[Story] ✅ Claude planned ${sceneCount} scenes | Total: ${totalDuration}s | Voice: ${voiceOver}`);
      } catch (err) {
        console.error(`[Story] ❌ Claude planning failed:`, err.message);
        updateStoryEntry(taskUUID, {
          status: 'paused', currentPhase: 'planning',
          error: `Claude planning failed: ${err.message}`,
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
    // New flow:
    //   Scene 1: generate 2 images (imagePrompt = frame A, imageBPrompt = frame B)
    //   Middle scenes: generate 1 image each (imagePrompt = end frame)
    //   Last scene: generate only CTA image (no imagePrompt)
    if (startPhase === 'images') {
      updateStoryEntry(taskUUID, { status: 'processing', currentPhase: 'images', error: null });

      const lastIdx = current.scenes.length - 1;

      // Collect indices that still need image work
      const pendingIndices = current.scenes
        .map((s, i) => i)
        .filter(i => {
          if (i < startSceneIdx) return false;
          const s = current.scenes[i];
          const isFirst = (i === 0);
          const isLast = (i === lastIdx);
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

        // Build all image jobs: scene images + imageB for scene 1 + CTA for last scene
        const allImageJobs = [];

        for (const i of pendingIndices) {
          const scene = current.scenes[i];
          const isFirst = (i === 0);
          const isLast = (i === lastIdx);

          const referenceImages = [];
          if (scene.useHeroRef && heroDataURI) {
            referenceImages.push(heroDataURI);
            console.log(`[Story] Scene ${scene.sceneNumber}: will attach hero ref`);
          }
          if (scene.useBgRef && bgDataURI) {
            referenceImages.push(bgDataURI);
            console.log(`[Story] Scene ${scene.sceneNumber}: will attach bg ref`);
          }

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

      startPhase = 'videos';
      startSceneIdx = 0;
    }

    // Reload
    current = loadStoryHistory().find(h => h.taskUUID === taskUUID);

    // ── PHASE: VIDEOS (SEQUENTIAL — each needs previous video's last frame) ──
    // Flow:
    //   Scene 1: firstFrame = imageA, lastFrame = imageB → generate video → extract last frame
    //   Scene 2..N-1: firstFrame = extracted last frame from prev video, lastFrame = this scene's image
    //   Scene N (last): firstFrame = extracted last frame from prev video, lastFrame = CTA image
    if (startPhase === 'videos') {
      updateStoryEntry(taskUUID, { status: 'processing', currentPhase: 'videos', error: null });

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

        for (let i = videoStartIdx; i <= lastIdx; i++) {
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
          let requestPayload;

          if (isKling) {
            const klingFrames = [{ image: firstFrameDataURI }];
            if (lastFrameDataURI) klingFrames.push({ image: lastFrameDataURI });
            requestPayload = {
              taskUUID: videoTaskUUID,
              model: current.videoModel,
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
            requestPayload = {
              taskUUID: videoTaskUUID,
              model: current.videoModel,
              positivePrompt: scene.videoPrompt,
              duration: scene.duration,
              outputFormat: 'mp4',
              width: 1080, height: 1920,
              fps: 24, numberResults: 1, outputQuality: 85,
              frameImages: googleFrames,
              providerSettings: { google: { generateAudio: true, enhancePrompt: true } },
            };
          }

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
  const { storyText, durationRange, gameContext, voiceDesc, heroDesc, videoModel } = req.body;

  if (!storyText || !storyText.trim()) {
    return res.status(400).json({ error: 'Story text is required.' });
  }

  // Parse duration range "15-30" → { min: 15, max: 30 }
  const [durMin, durMax] = (durationRange || '15-30').split('-').map(Number);
  const model = videoModel || 'google:3@3';
  const modelInfo = STORY_VIDEO_MODELS.find(m => m.id === model);
  const taskUUID = randomUUID();

  // Hero and background image paths (from multer uploads)
  const heroImagePath = req.files?.heroImage?.[0]?.path || null;
  const bgImagePath = req.files?.bgImage?.[0]?.path || null;

  console.log(`\n[Story] ── New Story Request ──────────────────────`);
  console.log(`[Story]  taskUUID : ${taskUUID}`);
  console.log(`[Story]  Duration : ${durMin}-${durMax}s (AI picks scene count)`);
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
    durationRange: `${durMin}-${durMax}`,
    durationMin: durMin,
    durationMax: durMax,
    gameContext: (gameContext || '').trim(),
    voiceDesc: (voiceDesc || '').trim(),
    heroDesc: (heroDesc || '').trim(),
    videoModel: model,
    videoModelLabel: modelInfo?.label || model,
    voiceOverCharacteristics: null, // Claude will populate this during planning
    heroImagePath,    // saved for resume — Claude + Nano Bana 2 reference
    bgImagePath,      // saved for resume — Claude + Nano Bana 2 reference
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
  const isFirst = (idx === 0);
  const isLast = (idx === entry.scenes.length - 1);
  let retryPhase;

  const imgFailed = !isLast && (scene.imageStatus === 'failed' || scene.imageStatus === 'pending');
  const imgBFailed = isFirst && scene.imageBPrompt && (scene.imageBStatus === 'failed' || scene.imageBStatus === 'pending');
  const ctaFailed = isLast && scene.ctaImagePrompt && (scene.ctaImageStatus === 'failed' || scene.ctaImageStatus === 'pending');

  if (imgFailed || imgBFailed || ctaFailed) {
    retryPhase = 'images';
    // Reset image(s) and video for this scene
    const updates = { videoStatus: 'pending', videoError: null };
    if (imgFailed) { updates.imageStatus = 'pending'; updates.imageError = null; }
    if (imgBFailed) { updates.imageBStatus = 'pending'; updates.imageBError = null; }
    if (ctaFailed) { updates.ctaImageStatus = 'pending'; updates.ctaImageError = null; }
    updateSceneInStory(taskUUID, idx, updates);
    // Also reset all subsequent videos (sequential dependency)
    for (let j = idx + 1; j < entry.scenes.length; j++) {
      updateSceneInStory(taskUUID, j, { videoStatus: 'pending', videoError: null });
    }
  } else if (scene.videoStatus === 'failed' || scene.videoStatus === 'pending') {
    retryPhase = 'videos';
    // Reset this scene + all subsequent videos (sequential dependency)
    for (let j = idx; j < entry.scenes.length; j++) {
      updateSceneInStory(taskUUID, j, { videoStatus: 'pending', videoError: null });
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

// ── POST /api/resubmit-images/:taskUUID ─────────────────────────────────────
// Manually re-submit ALL pending/failed images from scratch (resets their status to pending)
router.post('/api/resubmit-images/:taskUUID', async (req, res) => {
  const { taskUUID } = req.params;
  const entry = loadStoryHistory().find(h => h.taskUUID === taskUUID);

  if (!entry) return res.status(404).json({ error: 'Story not found.' });
  if (!entry.scenes || entry.scenes.length === 0) return res.status(400).json({ error: 'No scenes found — story must be planned first.' });
  if (entry.status === 'processing') return res.status(400).json({ error: 'Pipeline already running.' });

  const lastIdx = entry.scenes.length - 1;

  // Find scenes that need image work:
  //   Scene 1: imageStatus or imageBStatus not completed
  //   Middle scenes: imageStatus not completed
  //   Last scene: ctaImageStatus not completed
  const toReset = entry.scenes
    .map((s, i) => i)
    .filter(i => {
      const s = entry.scenes[i];
      const isFirst = (i === 0);
      const isLast = (i === lastIdx);
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
    if (isLast) {
      // Last scene: only CTA image
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

  // Also reset all videos after the first reset scene (sequential dependency)
  for (let i = toReset[0]; i <= lastIdx; i++) {
    if (!toReset.includes(i)) {
      updateSceneInStory(taskUUID, i, { videoStatus: 'pending', videoError: null });
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

  // Find first non-completed video scene
  const firstPending = entry.scenes.findIndex(s => s.videoStatus !== 'completed');
  if (firstPending === -1) {
    return res.status(400).json({ error: 'All videos are already completed.' });
  }

  // Reset ALL scenes from firstPending onward (sequential: later scenes depend on earlier ones)
  const toReset = entry.scenes.map((s, i) => i).filter(i => i >= firstPending);

  console.log(`[Story] ── Manual Resubmit Videos (sequential) ──────────────────────`);
  console.log(`[Story]  taskUUID: ${taskUUID} | resetting scenes ${firstPending + 1} onward (${toReset.length} scene(s))`);

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

  res.json({ success: true, message: `Re-submitting videos from scene ${firstPending + 1} onward (${toReset.length} video(s))...` });

  // Run pipeline from videos phase
  runPipeline(taskUUID, 'videos', firstPending);
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
