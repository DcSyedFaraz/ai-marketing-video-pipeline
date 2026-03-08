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
 *
 * Shared libraries:
 *   lib/models.js   — AVATAR_MODELS, VEO_COST, LIPSYNC_MODELS
 *   lib/helpers.js  — fileToDataURI, getMimeType, downloadVideo, downloadImage
 *   lib/ffmpeg.js   — extractLastFrame, concatVideos, hasAudioStream, getVideoDuration
 *   lib/history.js  — loadHistory, saveHistory, addHistoryEntry, updateHistoryEntry
 *   lib/runware.js  — submitAndPoll, checkOnce
 *   lib/multer.js   — upload (small files), uploadBridge (large video files)
 */

import 'dotenv/config';
import express from 'express';
import { mkdir } from 'fs/promises';

import avatarRouter   from './routes/avatar.js';
import veoRouter      from './routes/veo.js';
import bridgeRouter   from './routes/bridge.js';
import lipsyncRouter  from './routes/lipsync.js';
import combineRouter  from './routes/combine.js';
import ctaFrameRouter from './routes/ctaFrame.js';
import historyRouter  from './routes/history.js';

const API_KEY = process.env.RUNWARE_API_KEY;
const PORT = process.env.PORT || 3000;

if (!API_KEY || API_KEY === 'your_api_key_here') {
  console.error('ERROR: Please set RUNWARE_API_KEY in your .env file.');
  process.exit(1);
}

// Ensure output/upload directories exist
await mkdir('output', { recursive: true });
await mkdir('uploads', { recursive: true });
await mkdir('public', { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static('public'));
app.use('/output', express.static('output'));

// Mount route files
app.use(avatarRouter);
app.use(veoRouter);
app.use(bridgeRouter);
app.use(lipsyncRouter);
app.use(combineRouter);
app.use(ctaFrameRouter);
app.use(historyRouter);

app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Runware Video Generator GUI            ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║   Open : http://localhost:${PORT}             ║`);
  console.log('║   Models: KlingAI, OmniHuman, Veo 3.1   ║');
  console.log('╚══════════════════════════════════════════╝\n');
});
