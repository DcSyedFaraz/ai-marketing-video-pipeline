/**
 * Runware Video Generator — Express Server (bootstrap)
 *
 * Route files (one per frontend tab):
 *   routes/avatar.js    — 🧑‍💼 Avatar tab
 *   routes/veo.js       — 🎥 Text-to-Video tab
 *   routes/bridge.js    — 🔗 CTA Bridge tab
 *   routes/lipsync.js   — 👄 LipSync tab
 *   routes/combine.js   — ⛓ Combine tab
 *   routes/ctaFrame.js  — 🖼 CTA Frame tab
 *   routes/history.js   — 📋 History tab + 🗂 Gallery + manual check
 *   routes/story.js     — 📖 Story to Video pipeline
 *
 * Shared libraries:
 *   lib/models.js   — AVATAR_MODELS, VEO_COST, LIPSYNC_MODELS
 *   lib/helpers.js  — fileToDataURI, getMimeType, downloadVideo, downloadImage
 *   lib/ffmpeg.js   — extractLastFrame, concatVideos, hasAudioStream, getVideoDuration
 *   lib/history.js  — loadHistory, saveHistory, addHistoryEntry, updateHistoryEntry
 *   lib/runware.js  — submitAndPoll, checkOnce
 *   lib/multer.js   — upload (small files), uploadBridge (large video files)
 *   lib/claude.js   — planScenes, planPodcast (Claude AI scene/podcast planner)
 *   lib/storyHistory.js — loadStoryHistory, addStoryEntry, updateStoryEntry, updateSceneInStory
 */

import 'dotenv/config';
import express from 'express';
import { mkdir } from 'fs/promises';
import { initGlobalPoller, restorePendingTasks, sseEmitter } from './lib/globalPoller.js';

import avatarRouter      from './routes/avatar.js';
import veoRouter         from './routes/veo.js';
import bridgeRouter      from './routes/bridge.js';
import lipsyncRouter     from './routes/lipsync.js';
import combineRouter     from './routes/combine.js';
import ctaFrameRouter    from './routes/ctaFrame.js';
import historyRouter     from './routes/history.js';
import storyRouter       from './routes/story.js';
import podcastRouter     from './routes/podcast.js';
import elevenLabsRouter   from './routes/elevenlabs.js';
import splitscreenRouter  from './routes/splitscreen.js';
import quickvidRouter     from './routes/quickvid.js';

const API_KEY = process.env.RUNWARE_API_KEY;
const PORT = process.env.PORT || 3000;

if (!API_KEY || API_KEY === 'your_api_key_here') {
  console.error('ERROR: Please set RUNWARE_API_KEY in your .env file.');
  process.exit(1);
}

// Ensure output/upload directories exist
await mkdir('output', { recursive: true });
await mkdir('output/stories', { recursive: true });
await mkdir('uploads', { recursive: true });
await mkdir('public', { recursive: true });

const app = express();
app.use(express.json());

// ── SSE endpoint for real-time task completion notifications ─────────────────
const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send heartbeat every 25s to keep connection alive
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25000);

  sseClients.add(res);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// Forward globalPoller events to all SSE clients
sseEmitter.on('task-complete', (payload) => {
  const data = `event: task-complete\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) client.write(data);
});

// ── Intercept console output → broadcast as SSE log events ───────────────────
function broadcastLog(level, args) {
  if (!sseClients.size) return;
  const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const data = `event: server-log\ndata: ${JSON.stringify({ level, msg, ts: Date.now() })}\n\n`;
  for (const client of sseClients) client.write(data);
}
const _log   = console.log.bind(console);
const _warn  = console.warn.bind(console);
const _error = console.error.bind(console);
console.log   = (...a) => { _log(...a);   broadcastLog('log',   a); };
console.warn  = (...a) => { _warn(...a);  broadcastLog('warn',  a); };
console.error = (...a) => { _error(...a); broadcastLog('error', a); };

app.use(express.static('public'));
app.use('/output', express.static('output'));
app.use('/uploads', express.static('uploads'));

// Mount route files
app.use(avatarRouter);
app.use(veoRouter);
app.use(bridgeRouter);
app.use(lipsyncRouter);
app.use(combineRouter);
app.use(ctaFrameRouter);
app.use(historyRouter);
app.use(storyRouter);
app.use(podcastRouter);
app.use(elevenLabsRouter);
app.use(splitscreenRouter);
app.use(quickvidRouter);

app.listen(PORT, async () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Runware Video Generator GUI            ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║   Open : http://localhost:${PORT}             ║`);
  console.log('║   Models: KlingAI, OmniHuman, Veo 3.1   ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // Initialize global batch poller and restore any pending tasks
  await initGlobalPoller(API_KEY);
  await restorePendingTasks();
});
