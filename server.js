/**
 * Runware Avatar Generator - Express GUI Server
 * Supports KlingAI Avatar 2.0 Pro/Standard, OmniHuman-1/1.5, Google Veo 3.1
 * Features: async polling, history log, pending/completed tracking
 */

import 'dotenv/config';
import express from 'express';
import multer, { diskStorage } from 'multer';
import { Runware } from '@runware/sdk-js';
import { createWriteStream, readFileSync, writeFileSync, existsSync } from 'fs';
import { mkdir, readdir, unlink, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import https from 'https';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';

ffmpeg.setFfmpegPath(ffmpegPath);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.RUNWARE_API_KEY;
const PORT = process.env.PORT || 3000;
const HISTORY_FILE = 'output/history.json';

if (!API_KEY || API_KEY === 'your_api_key_here') {
  console.error('ERROR: Please set RUNWARE_API_KEY in your .env file.');
  process.exit(1);
}

// ---- Avatar models catalogue ----
export const AVATAR_MODELS = [
  {
    id: 'klingai:avatar@2.0-pro',
    label: 'KlingAI Avatar 2.0 Pro',
    provider: 'KlingAI',
    description: 'Highest fidelity, smoothest motion, production-ready',
    cost: '$0.087/sec',
    costPerSec: 0.087,
    badge: 'PRO',
  },
  {
    id: 'klingai:avatar@2.0-standard',
    label: 'KlingAI Avatar 2.0 Standard',
    provider: 'KlingAI',
    description: 'Faster, more economical, great for longer content',
    cost: '$0.044/sec',
    costPerSec: 0.044,
    badge: 'STANDARD',
  },
  {
    id: 'bytedance:5@2',
    label: 'OmniHuman 1.5',
    provider: 'ByteDance',
    description: 'High fidelity, multi-subject, context-aware gestures',
    cost: '~$0.13/sec',
    costPerSec: 0.13,
    badge: 'NEW',
  },
  {
    id: 'bytedance:5@1',
    label: 'OmniHuman 1',
    provider: 'ByteDance',
    description: 'Strong generalization across portraits, cartoons, full body',
    cost: '~$0.10/sec',
    costPerSec: 0.10,
    badge: null,
  },
];

// Cost-per-sec for Veo models
const VEO_COST = {
  'google/veo-3.1': 0.20,
  'google:3@3': 0.15,
};

// ---- Setup directories ----
await mkdir('output', { recursive: true });
await mkdir('uploads', { recursive: true });
await mkdir('public', { recursive: true });

// ---- History helpers ----
function loadHistory() {
  try {
    if (existsSync(HISTORY_FILE)) {
      return JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch {}
  return [];
}

function saveHistory(history) {
  try {
    writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (e) {
    console.error('[History] Failed to save:', e.message);
  }
}

function addHistoryEntry(entry) {
  const history = loadHistory();
  history.unshift(entry); // newest first
  saveHistory(history);
  return entry;
}

function updateHistoryEntry(taskUUID, updates) {
  const history = loadHistory();
  const idx = history.findIndex(h => h.taskUUID === taskUUID);
  if (idx !== -1) {
    history[idx] = { ...history[idx], ...updates };
    saveHistory(history);
    return history[idx];
  }
  return null;
}

// ---- Multer storage ----
const storage = diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|webp|mp3|wav|m4a|aac|ogg|mp4|webm|mov)$/i;
    allowed.test(file.originalname) ? cb(null, true) : cb(new Error(`File type not allowed: ${file.originalname}`));
  },
});

const uploadBridge = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB for video
  fileFilter: (req, file, cb) => {
    const allowed = /\.(mp4|webm|mov|mkv|avi|jpg|jpeg|png|webp)$/i;
    allowed.test(file.originalname) ? cb(null, true) : cb(new Error(`File type not allowed: ${file.originalname}`));
  },
});

// ---- Helpers ----
function fileToDataURI(filePath, mimeType) {
  const data = readFileSync(path.resolve(filePath));
  return `data:${mimeType};base64,${data.toString('base64')}`;
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.webp': 'image/webp',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
  };
  return map[ext] || 'application/octet-stream';
}

async function downloadVideo(url, dest) {
  await mkdir(path.dirname(dest), { recursive: true });
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadVideo(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
      file.on('error', reject);
    }).on('error', reject);
  });
}

// ---- FFmpeg helpers ----
function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration || 0);
    });
  });
}

async function extractLastFrame(videoPath, outputJpg) {
  // Get exact duration via ffprobe, then seek to (duration - 1/framerate) for the true last frame
  const duration = await getVideoDuration(videoPath);
  const seekTo = Math.max(0, duration - 0.05); // 50ms before end → guaranteed last frame
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .seekInput(seekTo)
      .outputOptions(['-vframes', '1', '-q:v', '2'])
      .output(outputJpg)
      .on('end', () => resolve(outputJpg))
      .on('error', reject)
      .run();
  });
}

function hasAudioStream(videoPath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) return resolve(false);
      resolve((meta.streams || []).some(s => s.codec_type === 'audio'));
    });
  });
}

async function concatVideos(video1Path, video2Path, outputPath) {
  const [audio1, audio2] = await Promise.all([hasAudioStream(video1Path), hasAudioStream(video2Path)]);

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(video1Path)
      .input(video2Path)
      .input('anullsrc=r=44100:cl=stereo').inputOptions(['-f', 'lavfi']); // [2] silent source

    const filters = [
      '[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v0]',
      '[1:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v1]',
      audio1 ? '[0:a]aformat=sample_rates=44100:channel_layouts=stereo[a0]' : '[2:a]atrim=duration=0,asetpts=PTS-STARTPTS[a0]',
      audio2 ? '[1:a]aformat=sample_rates=44100:channel_layouts=stereo[a1]' : '[2:a]atrim=duration=0,asetpts=PTS-STARTPTS[a1]',
      '[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]',
    ];

    cmd
      .complexFilter(filters)
      .outputOptions(['-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .run();
  });
}

// ---- Core: submit task + poll every 3s ----
async function submitAndPoll(runware, payload, label, taskUUID) {
  const POLL_INTERVAL_MS = 3000;
  const MAX_WAIT_MS = 10 * 60 * 1000;

  console.log(`\n[${label}] Submitting task ${taskUUID} (async, skipResponse, includeCost)...`);
  const submitStart = Date.now();
  try {
    await runware.videoInference({ ...payload, includeCost: true, skipResponse: true });
  } catch (submitErr) {
    const submitErrMsg = submitErr?.message || (typeof submitErr === 'string' ? submitErr : JSON.stringify(submitErr));
    console.error(`[${label}] Submit failed (full):`, submitErr);
    throw new Error(`Submit failed: ${submitErrMsg}`);
  }
  console.log(`[${label}] Task submitted OK. Polling every ${POLL_INTERVAL_MS / 1000}s...`);

  let attempt = 0;
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    attempt++;
    const elapsed = ((Date.now() - submitStart) / 1000).toFixed(1);
    console.log(`[${label}] Poll #${attempt} | elapsed: ${elapsed}s | taskUUID: ${taskUUID}`);

    try {
      const responses = await runware.getResponse({ taskUUID });
      console.log(`[${label}] Poll #${attempt} | getResponse → ${responses?.length ?? 0} item(s)`);

      if (responses?.length) {
        for (const r of responses) {
          // Log full raw response to see all available fields
          console.log(`[${label}] Poll #${attempt} | raw:`, JSON.stringify(r));
          if (r.error) throw new Error(`API error: ${JSON.stringify(r.error)}`);
          if (r.status === 'success' && r.videoURL) {
            const cost = r.cost ?? r.taskCost ?? r.inferCost ?? null;
            console.log(`[${label}] ✅ SUCCESS after ${elapsed}s | cost: ${cost !== null ? '$'+cost : 'not returned by API'} | URL: ${r.videoURL}`);
            return { ...r, cost };
          }
        }
        console.log(`[${label}] Poll #${attempt} | not ready yet...`);
      } else {
        console.log(`[${label}] Poll #${attempt} | no result yet...`);
      }
    } catch (err) {
      const pollErrMsg = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
      console.error(`[${label}] Poll #${attempt} | ERROR (full):`, err);
      console.error(`[${label}] Poll #${attempt} | ERROR: ${pollErrMsg}`);
      throw err instanceof Error ? err : new Error(pollErrMsg);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out after ${MAX_WAIT_MS / 1000}s waiting for video.`);
}

// ---- Core: single manual poll (check once) ----
async function checkOnce(runware, taskUUID, label) {
  console.log(`[${label}] Manual check for taskUUID: ${taskUUID}`);
  const responses = await runware.getResponse({ taskUUID });
  console.log(`[${label}] Manual check → ${responses?.length ?? 0} item(s)`);
  if (responses?.length) {
    for (const r of responses) {
      console.log(`[${label}] item:`, JSON.stringify({ status: r.status, videoURL: r.videoURL || null, error: r.error || null }));
      if (r.error) throw new Error(`API error: ${JSON.stringify(r.error)}`);
      if (r.status === 'success' && r.videoURL) return r;
    }
  }
  return null;
}

// ---- Express app ----
const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/output', express.static('output'));

// ---- API: Get available models ----
app.get('/api/models', (req, res) => {
  res.json({ models: AVATAR_MODELS });
});

// ---- API: Generate Avatar video ----
app.post('/api/generate-avatar', upload.fields([
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

  // Add to history as pending immediately
  const historyEntry = addHistoryEntry({
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

  // Respond immediately with taskUUID so frontend can track
  res.json({ success: true, taskUUID, status: 'pending', message: 'Task submitted. Use taskUUID to check status.' });

  // Run generation in background (don't await in request)
  const runware = new Runware({ apiKey: API_KEY });
  (async () => {
    try {
      await runware.ensureConnection();
      console.log(`[Avatar] Connected to Runware WebSocket`);

      console.log(`[Avatar] Encoding image...`);
      const imageDataURI = fileToDataURI(imageFile.path, getMimeType(imageFile.path));
      console.log(`[Avatar] Image encoded: ${(imageDataURI.length / 1024).toFixed(1)} KB`);

      console.log(`[Avatar] Encoding audio...`);
      const audioDataURI = fileToDataURI(audioFile.path, getMimeType(audioFile.path));
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
      console.log(`[Avatar] Downloading → ${outputPath}`);
      await downloadVideo(result.videoURL, outputPath);
      console.log(`[Avatar] ✅ Download complete: ${outputPath}`);

      const resolvedCost = result.cost ?? null;
      console.log(`[Avatar] Final cost: ${resolvedCost !== null ? '$'+resolvedCost : 'not returned by API'}`);

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

// ---- API: Generate Veo text-to-video ----
app.post('/api/generate-veo', async (req, res) => {
  const { prompt, duration = 7, width = 1280, height = 720, model = 'google/veo-3.1' } = req.body;

  if (!prompt?.trim()) return res.status(400).json({ error: 'A prompt is required.' });

  console.log(`\n[Veo] ── New Request ────────────────────────`);
  console.log(`[Veo]  Prompt   : ${prompt}`);
  console.log(`[Veo]  Model    : ${model}`);
  console.log(`[Veo]  Duration : ${duration}s  Size: ${width}x${height}`);

  const taskUUID = randomUUID();

  const historyEntry = addHistoryEntry({
    taskUUID,
    type: 'veo',
    model,
    modelLabel: model === 'google:3@3' ? 'Google Veo 3.1 Fast' : 'Google Veo 3.1',
    provider: 'Google',
    prompt,
    status: 'pending',
    submittedAt: new Date().toISOString(),
    completedAt: null,
    videoUrl: null,
    videoURL: null,
    filename: null,
    cost: null,
    error: null,
    duration: parseInt(duration),
    width: parseInt(width),
    height: parseInt(height),
  });

  console.log(`[Veo]  taskUUID: ${taskUUID} → added to history as PENDING`);

  res.json({ success: true, taskUUID, status: 'pending', message: 'Task submitted. Use taskUUID to check status.' });

  const runware = new Runware({ apiKey: API_KEY });
  (async () => {
    try {
      await runware.ensureConnection();
      console.log(`[Veo] Connected to Runware WebSocket`);

      const requestPayload = {
        taskUUID,
        model,
        positivePrompt: prompt.trim(),
        duration: parseInt(duration),
        width: parseInt(width),
        height: parseInt(height),
        outputFormat: 'mp4',
        numberResults: 1,
      };

      const result = await submitAndPoll(runware, requestPayload, 'Veo', taskUUID);

      const filename = `veo_${Date.now()}.mp4`;
      const outputPath = path.join('output', filename);
      console.log(`[Veo] Downloading → ${outputPath}`);
      await downloadVideo(result.videoURL, outputPath);
      console.log(`[Veo] ✅ Download complete: ${outputPath}`);

      const resolvedCost = result.cost ?? null;
      console.log(`[Veo] Final cost: ${resolvedCost !== null ? '$'+resolvedCost : 'not returned by API'}`);

      updateHistoryEntry(taskUUID, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        videoUrl: `/output/${filename}`,
        videoURL: result.videoURL,
        filename,
        cost: resolvedCost,
        costSource: resolvedCost !== null ? 'api' : null,
      });
      console.log(`[Veo] History updated → COMPLETED`);

    } catch (err) {
      console.error(`[Veo] ❌ ERROR: ${err.message}`);
      updateHistoryEntry(taskUUID, { status: 'failed', error: err.message, completedAt: new Date().toISOString() });
    } finally {
      runware.disconnect();
    }
  })();
});

// ---- API: Generate CTA Bridge video ----
app.post('/api/generate-bridge', uploadBridge.fields([
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
  console.log(`[Bridge]  Bridge duration: ${bridgeDuration}s`);

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
      console.log(`[Bridge] Encoding first frame (last frame of video)...`);
      const firstFrameDataURI = fileToDataURI(frameJpg, 'image/jpeg');
      console.log(`[Bridge] First frame encoded: ${(firstFrameDataURI.length / 1024).toFixed(1)} KB`);

      console.log(`[Bridge] Encoding CTA image...`);
      const ctaDataURI = fileToDataURI(ctaFile.path, getMimeType(ctaFile.path));
      console.log(`[Bridge] CTA image encoded: ${(ctaDataURI.length / 1024).toFixed(1)} KB`);

      // Step 3: Build and submit request
      const requestPayload = {
        taskUUID,
        model,
        positivePrompt: prompt || 'Smooth cinematic transition to the next scene',
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
      console.log(`[Bridge] ✅ Concatenation complete: ${bridgeFinal}`);

      const filename = path.basename(bridgeFinal);
      const resolvedCost = result.cost ?? null;
      console.log(`[Bridge] Final cost: ${resolvedCost !== null ? '$'+resolvedCost : 'not returned by API'}`);

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
      // Cleanup temp uploads only (keep frameJpg and bridgeGenerated as output)
      await unlink(videoFile.path).catch(() => {});
      await unlink(ctaFile.path).catch(() => {});
    }
  })();
});

// ---- API: PixVerse LipSync ----
app.post('/api/generate-lipsync', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'audio', maxCount: 1 },
]), async (req, res) => {
  const videoFile = req.files?.video?.[0];
  const audioFile = req.files?.audio?.[0];

  if (!videoFile || !audioFile) {
    return res.status(400).json({ error: 'Both a video and audio file are required.' });
  }

  console.log(`\n[LipSync] ── New Request ──────────────────────`);
  console.log(`[LipSync]  Video : ${videoFile.originalname} (${(videoFile.size / 1024).toFixed(1)} KB)`);
  console.log(`[LipSync]  Audio : ${audioFile.originalname} (${(audioFile.size / 1024).toFixed(1)} KB)`);

  const taskUUID = randomUUID();

  addHistoryEntry({
    taskUUID,
    type: 'lipsync',
    model: 'pixverse:lipsync@1',
    modelLabel: 'PixVerse LipSync',
    provider: 'PixVerse',
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

      console.log(`[LipSync] Encoding video...`);
      const videoDataURI = fileToDataURI(videoFile.path, 'video/mp4');
      console.log(`[LipSync] Video encoded: ${(videoDataURI.length / 1024).toFixed(1)} KB`);

      console.log(`[LipSync] Encoding audio...`);
      const audioDataURI = fileToDataURI(audioFile.path, getMimeType(audioFile.path));
      console.log(`[LipSync] Audio encoded: ${(audioDataURI.length / 1024).toFixed(1)} KB`);

      const requestPayload = {
        taskUUID,
        model: 'pixverse:lipsync@1',
        outputFormat: 'mp4',
        numberResults: 1,
        referenceVideos: [videoDataURI],
        inputAudios: [audioDataURI],
      };

      const result = await submitAndPoll(runware, requestPayload, 'LipSync', taskUUID);

      const filename = `lipsync_${Date.now()}.mp4`;
      const outputPath = path.join('output', filename);
      console.log(`[LipSync] Downloading → ${outputPath}`);
      await downloadVideo(result.videoURL, outputPath);
      console.log(`[LipSync] ✅ Download complete: ${outputPath}`);

      const resolvedCost = result.cost ?? null;
      console.log(`[LipSync] Final cost: ${resolvedCost !== null ? '$'+resolvedCost : 'not returned by API'}`);

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

// ---- API: Manual check on a pending task ----
app.post('/api/check/:taskUUID', async (req, res) => {
  const { taskUUID } = req.params;
  const history = loadHistory();
  const entry = history.find(h => h.taskUUID === taskUUID);

  if (!entry) return res.status(404).json({ error: 'Task not found in history.' });
  if (entry.status === 'completed') return res.json({ status: 'completed', entry });
  if (entry.status === 'failed') return res.json({ status: 'failed', entry });

  const logs = [];
  const log = (msg) => { console.log(msg); logs.push(msg); };

  log(`[Check] Manual check for taskUUID: ${taskUUID}`);
  log(`[Check] Type: ${entry.type} | Model: ${entry.modelLabel || entry.model}`);
  const runware = new Runware({ apiKey: API_KEY });

  try {
    await runware.ensureConnection();
    log(`[Check] Connected to Runware WebSocket`);

    const result = await checkOnce(runware, taskUUID, 'Check');

    if (!result) {
      log(`[Check] Status: still processing / not ready yet`);
      return res.json({ status: 'pending', entry, logs });
    }

    log(`[Check] ✅ Result ready! videoURL: ${result.videoURL}`);

    const typeMap = { avatar: 'avatar', veo: 'veo', bridge: 'bridge_final', lipsync: 'lipsync' };
    const prefix = typeMap[entry.type] || entry.type || 'video';
    const filename = `${prefix}_${Date.now()}.mp4`;
    const outputPath = path.join('output', filename);
    log(`[Check] Downloading → ${outputPath}`);
    await downloadVideo(result.videoURL, outputPath);
    log(`[Check] ✅ Download complete: ${filename}`);

    const resolvedCost = result.cost ?? null;
    log(`[Check] Cost: ${resolvedCost !== null ? '$'+resolvedCost : 'not returned by API'}`);

    const updated = updateHistoryEntry(taskUUID, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      videoUrl: `/output/${filename}`,
      videoURL: result.videoURL,
      filename,
      cost: resolvedCost,
      costSource: resolvedCost !== null ? 'api' : null,
    });

    res.json({ status: 'completed', entry: updated, logs });

  } catch (err) {
    const errMsg = err?.message || JSON.stringify(err);
    log(`[Check] ❌ ERROR: ${errMsg}`);
    console.error(`[Check] ERROR (full):`, err);
    const updated = updateHistoryEntry(taskUUID, { status: 'failed', error: errMsg });
    res.status(500).json({ status: 'failed', error: errMsg, entry: updated, logs });
  } finally {
    runware.disconnect();
  }
});

// ---- API: Get history ----
app.get('/api/history', (req, res) => {
  res.json({ history: loadHistory() });
});

// ---- API: Clear history entry ----
app.delete('/api/history/:taskUUID', (req, res) => {
  const { taskUUID } = req.params;
  const history = loadHistory().filter(h => h.taskUUID !== taskUUID);
  saveHistory(history);
  res.json({ success: true });
});

// ---- API: List generated videos (for gallery) ----
app.get('/api/videos', async (req, res) => {
  try {
    const files = await readdir('output');
    const videos = files
      .filter(f => f.endsWith('.mp4'))
      .map(f => ({
        filename: f,
        url: `/output/${f}`,
        type: f.startsWith('avatar_') ? 'avatar' : f.startsWith('lipsync_') ? 'lipsync' : f.startsWith('bridge_') || f.startsWith('combined_') ? 'bridge' : 'veo',
        created: f.split('_')[1]?.replace('.mp4', '') || '0',
      }))
      .sort((a, b) => parseInt(b.created) - parseInt(a.created));
    res.json({ videos });
  } catch {
    res.json({ videos: [] });
  }
});

// ---- API: Combine two videos (output filenames or uploads) ----
app.post('/api/combine', uploadBridge.fields([
  { name: 'upload1', maxCount: 1 },
  { name: 'upload2', maxCount: 1 },
]), async (req, res) => {
  const safe = f => (f || '').replace(/[^a-zA-Z0-9_.\-]/g, '');
  const upload1 = req.files?.upload1?.[0];
  const upload2 = req.files?.upload2?.[0];
  const file1 = safe(req.body.video1);
  const file2 = safe(req.body.video2);

  // Resolve paths: uploaded file takes priority over filename
  const v1path = upload1 ? upload1.path : (file1 ? path.join('output', file1) : null);
  const v2path = upload2 ? upload2.path : (file2 ? path.join('output', file2) : null);
  const v1label = upload1 ? upload1.originalname : file1;
  const v2label = upload2 ? upload2.originalname : file2;

  if (!v1path || !v2path) {
    return res.status(400).json({ error: 'Both videos are required (upload or select from output).' });
  }
  if (!existsSync(v1path)) return res.status(404).json({ error: `File not found: ${v1label}` });
  if (!existsSync(v2path)) return res.status(404).json({ error: `File not found: ${v2label}` });

  const outFilename = `combined_${Date.now()}.mp4`;
  const outPath = path.join('output', outFilename);

  console.log(`\n[Combine] ${v1label} + ${v2label} → ${outFilename}`);
  try {
    await concatVideos(v1path, v2path, outPath);
    console.log(`[Combine] ✅ Done: ${outFilename}`);
    res.json({ success: true, filename: outFilename, url: `/output/${outFilename}` });
  } catch (err) {
    console.error(`[Combine] ❌ ERROR:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (upload1) await unlink(upload1.path).catch(() => {});
    if (upload2) await unlink(upload2.path).catch(() => {});
  }
});

// ---- API: Delete a video file ----
app.delete('/api/videos/:filename', async (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9_.-]/g, '');
  try {
    await unlink(path.join('output', filename));
    res.json({ success: true });
  } catch {
    res.status(404).json({ error: 'File not found.' });
  }
});

// ---- Start server ----
app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Runware Video Generator GUI            ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║   Open : http://localhost:${PORT}             ║`);
  console.log('║   Models: KlingAI, OmniHuman, Veo 3.1   ║');
  console.log('╚══════════════════════════════════════════╝\n');
});
