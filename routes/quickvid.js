// ── Quick Video Tab ─────────────────────────────────────────────────────────
// POST /api/quickvid  — generate a Seedance 2.0 video from a text prompt +
//                       optional hero reference images. No first-frame image,
//                       no Claude planning — just submit and poll.

import { Router } from 'express';
import { randomUUID } from 'crypto';
import path from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';

import { downloadVideo, fileToDataURI, getMimeType } from '../lib/helpers.js';
import { addHistoryEntry, updateHistoryEntry } from '../lib/history.js';
import { globalPoller, sseEmitter } from '../lib/globalPoller.js';
import { uploadQuickVid } from '../lib/multer.js';
import { unlink } from 'fs/promises';
import { generateQuickVideoScript, generateQuickVideoStoryScript, generateQuickVideoNarrativeScript } from '../lib/claude.js';

const router = Router();

// ─── Hero image helpers (mirrors story.js) ────────────────────────────────────
function heroSlug(name) { return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, ''); }
function heroImagesDir(name) { return path.resolve('uploads', 'heroes', heroSlug(name)); }
function listHeroImages(name) {
  const dir = heroImagesDir(name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
    .map(f => `/uploads/heroes/${heroSlug(name)}/${f}`);
}

// Convert /uploads/... URL to absolute disk path, read as data URI
function heroImageToDataURI(urlPath) {
  const relative = urlPath.replace(/^\/uploads\//, '');
  const abs = path.resolve('uploads', relative);
  if (!existsSync(abs)) return null;
  return fileToDataURI(abs, getMimeType(abs));
}

// Load up to maxRefs reference images for the given hero names
function loadHeroRefDataURIs(heroNames, maxRefs = 9) {
  if (!heroNames?.length || maxRefs <= 0) return [];
  const uris = [];
  if (heroNames.length === 1) {
    // Single hero → up to maxRefs images of that hero
    const images = listHeroImages(heroNames[0]);
    for (const img of images.slice(0, maxRefs)) {
      const uri = heroImageToDataURI(img);
      if (uri) uris.push(uri);
    }
  } else {
    // Multiple heroes → 1 image per hero
    for (const name of heroNames.slice(0, maxRefs)) {
      const images = listHeroImages(name);
      if (images.length) {
        const uri = heroImageToDataURI(images[0]);
        if (uri) uris.push(uri);
      }
    }
  }
  return uris;
}

// ── POST /api/quickvid ────────────────────────────────────────────────────────
const quickVidUpload = uploadQuickVid.fields([{ name: 'extraRefImages', maxCount: 8 }]);

router.post('/api/quickvid', quickVidUpload, async (req, res) => {
  const prompt = (req.body.prompt || '').trim();
  const duration = req.body.duration ?? 8;
  const heroes = (() => { try { return JSON.parse(req.body.heroes || '[]'); } catch { return req.body.heroes || []; } })();
  const orient = req.body.orient === 'portrait' ? 'portrait' : 'landscape';
  const negativePrompt = (req.body.negativePrompt || '').trim().slice(0, 2500) || null;

  if (!prompt?.trim()) {
    return res.status(400).json({ error: 'A script/prompt is required.' });
  }

  const dur = Math.max(4, Math.min(15, Math.round(parseInt(duration) || 8)));
  const heroNames = Array.isArray(heroes) ? heroes.filter(Boolean) : [];

  console.log(`\n[QuickVid] ── New Request ──────────────────────`);
  console.log(`[QuickVid]  Prompt  : ${prompt.slice(0, 100)}${prompt.length > 100 ? '…' : ''}`);
  console.log(`[QuickVid]  Duration: ${dur}s`);
  console.log(`[QuickVid]  Orient  : ${orient}`);
  console.log(`[QuickVid]  Heroes  : ${heroNames.join(', ') || 'none'}`);

  const taskUUID = randomUUID();

  addHistoryEntry({
    taskUUID,
    type: 'quickvid',
    model: 'bytedance:seedance@2.0',
    modelLabel: 'Seedance 2.0',
    provider: 'ByteDance',
    prompt: prompt.trim(),
    heroes: heroNames,
    duration: dur,
    status: 'pending',
    submittedAt: new Date().toISOString(),
    completedAt: null,
    videoUrl: null,
    filename: null,
    cost: null,
    error: null,
  });

  res.json({ success: true, taskUUID, status: 'pending' });

  // ─── Build Seedance payload ───────────────────────────────────────────────
  // Audio is enabled — send the full prompt including any dialogue to Seedance
  const cleanPrompt = prompt.trim();

  const heroRefs = loadHeroRefDataURIs(heroNames, 9);
  if (heroRefs.length) {
    console.log(`[QuickVid]  Hero refs loaded: ${heroRefs.length}`);
  }

  // Extra manual reference images uploaded by user
  const extraRefFiles = req.files?.extraRefImages || [];
  const extraRefDataURIs = extraRefFiles
    .map(f => existsSync(f.path) ? fileToDataURI(f.path, getMimeType(f.path)) : null)
    .filter(Boolean);
  if (extraRefDataURIs.length) {
    console.log(`[QuickVid]  Extra manual refs: ${extraRefDataURIs.length}`);
  }

  const allRefs = [...heroRefs, ...extraRefDataURIs].slice(0, 9);

  const payload = {
    taskUUID,
    model: 'bytedance:seedance@2.0',
    positivePrompt: cleanPrompt,
    duration: dur,
    outputFormat: 'mp4',
    numberResults: 1,
    includeCost: true,
    settings: { audio: true },
    // Portrait 720p (9:16) = 720×1280 | Landscape 720p (16:9) = 1280×720
    width: orient === 'portrait' ? 720 : 1280,
    height: orient === 'portrait' ? 1280 : 720,
  };

  // Attach reference images (hero catalog + extra manual)
  if (allRefs.length) {
    payload.inputs = { referenceImages: allRefs };
  }
  if (negativePrompt) payload.negativePrompt = negativePrompt;

  // ─── Submit ───────────────────────────────────────────────────────────────
  try {
    const debugPayload = JSON.parse(JSON.stringify(payload));
    if (debugPayload.inputs?.referenceImages) {
      debugPayload.inputs.referenceImages = debugPayload.inputs.referenceImages.map(r =>
        typeof r === 'string' && r.startsWith('data:') ? `${r.slice(0, 30)}...(${(r.length/1024).toFixed(0)}KB)` : r
      );
    }
    console.log(`[QuickVid]  Payload:`, JSON.stringify(debugPayload));
    console.log(`[QuickVid]  Submitting task ${taskUUID}…`);
    await globalPoller.getConnection().videoInference({ ...payload, skipResponse: true });
    console.log(`[QuickVid]  Task submitted OK — polling started`);
  } catch (submitErr) {
    const msg = submitErr?.message || (typeof submitErr === 'object' ? JSON.stringify(submitErr) : String(submitErr));
    console.error(`[QuickVid]  ❌ Submit failed (full):`, submitErr);
    console.error(`[QuickVid]  ❌ Submit failed: ${msg}`);
    updateHistoryEntry(taskUUID, { status: 'failed', error: msg, completedAt: new Date().toISOString() });
    sseEmitter.emit('task-complete', { taskUUID, type: 'quickvid', status: 'failed', error: msg });
    return;
  } finally {
    for (const f of extraRefFiles) await unlink(f.path).catch(() => {});
  }

  // ─── Poll ─────────────────────────────────────────────────────────────────
  globalPoller.register(taskUUID, {
    type: 'video',
    label: 'QuickVid',
    onComplete: async (result) => {
      const filename = `quickvid_${Date.now()}.mp4`;
      const outputPath = path.join('output', filename);
      try {
        await downloadVideo(result.videoURL, outputPath);
        console.log(`[QuickVid]  ✅ Downloaded: ${outputPath}`);
        const updated = updateHistoryEntry(taskUUID, {
          status: 'completed',
          completedAt: new Date().toISOString(),
          videoUrl: `/output/${filename}`,
          filename,
          cost: result.cost ?? null,
        });
        sseEmitter.emit('task-complete', {
          taskUUID,
          type: 'quickvid',
          status: 'completed',
          videoUrl: `/output/${filename}`,
          entry: updated,
        });
      } catch (dlErr) {
        const msg = dlErr?.message || String(dlErr);
        console.error(`[QuickVid]  ❌ Download failed: ${msg}`);
        updateHistoryEntry(taskUUID, { status: 'failed', error: `Download failed: ${msg}`, completedAt: new Date().toISOString() });
        sseEmitter.emit('task-complete', { taskUUID, type: 'quickvid', status: 'failed', error: msg });
      }
    },
    onError: async (err) => {
      const msg = err?.message || String(err);
      console.error(`[QuickVid]  ❌ Generation failed: ${msg}`);
      updateHistoryEntry(taskUUID, { status: 'failed', error: msg, completedAt: new Date().toISOString() });
      sseEmitter.emit('task-complete', { taskUUID, type: 'quickvid', status: 'failed', error: msg });
    },
  });
});

// ── POST /api/quickvid/generate-script ────────────────────────────────────────
// Generate a ready-to-submit Seedance video prompt using Claude, tailored to a
// target audience and a product point (USP/feature) from game-context.txt.
router.post('/api/quickvid/generate-script', async (req, res) => {
  try {
    const audience = (req.body.audience || '').trim();
    const productPoint = req.body.productPoint && req.body.productPoint !== 'auto'
      ? String(req.body.productPoint).trim()
      : null;
    const duration = parseInt(req.body.duration) || 8;
    const showMobileScreen = req.body.showMobileScreen !== false; // default true

    let gameContext = '';
    try {
      gameContext = readFileSync(path.resolve('public', 'game-context.txt'), 'utf-8');
    } catch {
      gameContext = '';
    }

    console.log(`[QuickVid/Script]  audience="${audience.slice(0, 60) || '(auto)'}" point="${productPoint || 'auto'}" dur=${duration}s showMobile=${showMobileScreen}`);
    const { script, suggestedDuration } = await generateQuickVideoScript({ audience, productPoint, duration, gameContext, showMobileScreen });
    console.log(`[QuickVid/Script]  ✅ done | suggestedDuration=${suggestedDuration}s`);
    res.json({ script, suggestedDuration });
  } catch (err) {
    console.error('[QuickVid/Script] ❌ failed:', err?.message || err);
    res.status(500).json({ error: err?.message || 'Script generation failed' });
  }
});

// ── POST /api/quickvid/generate-story-script ─────────────────────────────────
// Generate a story/angle-driven Seedance video prompt using a marketing angle.
router.post('/api/quickvid/generate-story-script', async (req, res) => {
  try {
    const angleId = parseInt(req.body.angleId);
    const audience = (req.body.audience || '').trim();
    const duration = parseInt(req.body.duration) || 8;
    const showMobileScreen = req.body.showMobileScreen !== false;

    if (!angleId) return res.status(400).json({ error: 'angleId is required.' });

    // Load marketing angles
    let angle;
    try {
      const anglesData = JSON.parse(readFileSync(path.resolve('public', 'marketing_angles.json'), 'utf-8'));
      angle = (anglesData.marketing_angles || []).find(a => a.id === angleId);
    } catch {
      return res.status(500).json({ error: 'Could not load marketing angles.' });
    }
    if (!angle) return res.status(400).json({ error: `Angle ${angleId} not found.` });

    let gameContext = '';
    try { gameContext = readFileSync(path.resolve('public', 'game-context.txt'), 'utf-8'); } catch { gameContext = ''; }

    console.log(`[QuickVid/Story]  angle="${angle.name}" audience="${audience.slice(0, 50) || '(auto)'}" dur=${duration}s showMobile=${showMobileScreen}`);
    const { script, suggestedDuration } = await generateQuickVideoStoryScript({ angle, audience, duration, gameContext, showMobileScreen });
    console.log(`[QuickVid/Story]  ✅ done | suggestedDuration=${suggestedDuration}s`);
    res.json({ script, suggestedDuration });
  } catch (err) {
    console.error('[QuickVid/Story] ❌ failed:', err?.message || err);
    res.status(500).json({ error: err?.message || 'Story script generation failed' });
  }
});

// ── POST /api/quickvid/generate-narrative-script ──────────────────────────────
router.post('/api/quickvid/generate-narrative-script', async (req, res) => {
  try {
    const premise = (req.body.premise || '').trim();
    const angleId = req.body.angleId ? parseInt(req.body.angleId) : null;
    const duration = parseInt(req.body.duration) || 15;
    const showMobileScreen = req.body.showMobileScreen !== false;

    // Load angle if provided
    let angle = null;
    if (angleId) {
      try {
        const anglesData = JSON.parse(readFileSync(path.resolve('public', 'marketing_angles.json'), 'utf-8'));
        angle = (anglesData.marketing_angles || []).find(a => a.id === angleId) || null;
      } catch { /* angle stays null */ }
    }

    let gameContext = '';
    try { gameContext = readFileSync(path.resolve('public', 'game-context.txt'), 'utf-8'); } catch { gameContext = ''; }

    console.log(`[QuickVid/Narrative]  premise="${premise.slice(0, 80) || '(auto)'}" angle="${angle?.name || 'none'}" dur=${duration}s`);
    const { script, suggestedDuration } = await generateQuickVideoNarrativeScript({ premise, angle, duration, gameContext, showMobileScreen });
    console.log(`[QuickVid/Narrative]  ✅ done | suggestedDuration=${suggestedDuration}s`);
    res.json({ script, suggestedDuration });
  } catch (err) {
    console.error('[QuickVid/Narrative] ❌ failed:', err?.message || err);
    res.status(500).json({ error: err?.message || 'Narrative script generation failed' });
  }
});

export default router;
