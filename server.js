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
import { mkdir, readdir, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import https from 'https';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

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
  'google/veo-3.1-fast': 0.15,
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
    const allowed = /\.(jpg|jpeg|png|webp|mp3|wav|m4a|aac|ogg)$/i;
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

// ---- Core: submit task + poll every 3s ----
async function submitAndPoll(runware, payload, label, taskUUID) {
  const POLL_INTERVAL_MS = 3000;
  const MAX_WAIT_MS = 10 * 60 * 1000;

  console.log(`\n[${label}] Submitting task ${taskUUID} (async, skipResponse, includeCost)...`);
  const submitStart = Date.now();
  await runware.videoInference({ ...payload, includeCost: true, skipResponse: true });
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
      console.error(`[${label}] Poll #${attempt} | ERROR: ${err.message}`);
      throw err;
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
    modelLabel: model === 'google/veo-3.1-fast' ? 'Google Veo 3.1 Fast' : 'Google Veo 3.1',
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

// ---- API: Manual check on a pending task ----
app.post('/api/check/:taskUUID', async (req, res) => {
  const { taskUUID } = req.params;
  const history = loadHistory();
  const entry = history.find(h => h.taskUUID === taskUUID);

  if (!entry) return res.status(404).json({ error: 'Task not found in history.' });
  if (entry.status === 'completed') return res.json({ status: 'completed', entry });
  if (entry.status === 'failed') return res.json({ status: 'failed', entry });

  console.log(`\n[Check] Manual check for taskUUID: ${taskUUID}`);
  const runware = new Runware({ apiKey: API_KEY });

  try {
    await runware.ensureConnection();
    const result = await checkOnce(runware, taskUUID, 'Check');

    if (!result) {
      console.log(`[Check] Still pending: ${taskUUID}`);
      return res.json({ status: 'pending', entry });
    }

    const prefix = entry.type === 'avatar' ? 'avatar' : 'veo';
    const filename = `${prefix}_${Date.now()}.mp4`;
    const outputPath = path.join('output', filename);
    console.log(`[Check] Downloading → ${outputPath}`);
    await downloadVideo(result.videoURL, outputPath);
    console.log(`[Check] ✅ Download complete`);

    const resolvedCost = result.cost ?? null;
    console.log(`[Check] Final cost: ${resolvedCost !== null ? '$'+resolvedCost : 'not returned by API'}`);

    const updated = updateHistoryEntry(taskUUID, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      videoUrl: `/output/${filename}`,
      videoURL: result.videoURL,
      filename,
      cost: resolvedCost,
      costSource: resolvedCost !== null ? 'api' : null,
    });

    res.json({ status: 'completed', entry: updated });

  } catch (err) {
    console.error(`[Check] ERROR: ${err.message}`);
    const updated = updateHistoryEntry(taskUUID, { status: 'failed', error: err.message });
    res.status(500).json({ status: 'failed', error: err.message, entry: updated });
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
        type: f.startsWith('avatar_') ? 'avatar' : 'veo',
        created: f.split('_')[1]?.replace('.mp4', '') || '0',
      }))
      .sort((a, b) => parseInt(b.created) - parseInt(a.created));
    res.json({ videos });
  } catch {
    res.json({ videos: [] });
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
