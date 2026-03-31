// ── Split Screen Tab ──────────────────────────────────────────────────────────
// GET  /api/music-files   — list audio files from uploads/
// POST /api/splitscreen   — composite podcast + UGC into split-screen MP4

import { Router } from 'express';
import { existsSync, statSync } from 'fs';
import { unlink, readdir } from 'fs/promises';
import path from 'path';

import { uploadBridge } from '../lib/multer.js';
import { createSplitScreen } from '../lib/ffmpeg.js';

const router = Router();

// ── List audio files in uploads/ ─────────────────────────────────────────────
router.get('/api/music-files', async (req, res) => {
  try {
    const files = await readdir('uploads');
    const audioExt = /\.(mp3|wav|m4a|aac|ogg)$/i;
    const result = [];
    for (const filename of files) {
      if (!audioExt.test(filename)) continue;
      try {
        const stat = statSync(path.join('uploads', filename));
        result.push({ filename, url: `/uploads/${filename}`, size: stat.size, mtime: stat.mtimeMs });
      } catch { /* skip unreadable */ }
    }
    result.sort((a, b) => b.mtime - a.mtime);
    res.json({ files: result.map(({ filename, url, size }) => ({ filename, url, size })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Create split-screen composite ────────────────────────────────────────────
router.post('/api/splitscreen', uploadBridge.fields([
  { name: 'podcast', maxCount: 1 },
  { name: 'ugc',     maxCount: 1 },
  { name: 'music',   maxCount: 1 },
]), async (req, res) => {
  const podcastFile = req.files?.podcast?.[0];
  const ugcFile     = req.files?.ugc?.[0];
  const musicFile   = req.files?.music?.[0];

  if (!podcastFile) return res.status(400).json({ error: 'Podcast video is required.' });
  if (!ugcFile)     return res.status(400).json({ error: 'UGC video is required.' });

  const podcastOrientation = req.body.podcastOrientation || 'portrait';
  const ugcOrientation     = req.body.ugcOrientation     || 'portrait';
  if (!['portrait', 'landscape'].includes(podcastOrientation))
    return res.status(400).json({ error: 'podcastOrientation must be portrait or landscape.' });
  if (!['portrait', 'landscape'].includes(ugcOrientation))
    return res.status(400).json({ error: 'ugcOrientation must be portrait or landscape.' });

  const isLandscapePodcast = podcastOrientation === 'landscape';
  const isLandscapeUgc     = ugcOrientation     === 'landscape';

  // Resolve music path: prefer fresh upload, fall back to existing upload ref
  let resolvedMusicPath = null;
  if (musicFile) {
    resolvedMusicPath = musicFile.path;
  } else if (req.body.musicFileRef) {
    // Sanitize: must be a relative path under uploads/
    const ref = req.body.musicFileRef.replace(/^\//, ''); // strip leading slash
    const abs = path.resolve(ref);
    const uploadsAbs = path.resolve('uploads');
    if (abs.startsWith(uploadsAbs) && existsSync(abs)) {
      resolvedMusicPath = abs;
    }
  }

  const rawVol = parseFloat(req.body.musicVolume);
  // Frontend sends 5–50 (percentage). Convert to 0.05–0.50 float.
  const musicVolume = isNaN(rawVol) ? 0.15 : Math.min(0.5, Math.max(0.05, rawVol / 100));

  const outFilename = `splitscreen_${Date.now()}.mp4`;
  const outPath = path.join('output', outFilename);

  console.log(`\n[SplitScreen] podcast=${podcastOrientation} ugc=${ugcOrientation} music=${resolvedMusicPath ? 'yes' : 'no'} vol=${musicVolume}`);
  try {
    await createSplitScreen(podcastFile.path, ugcFile.path, outPath, {
      isLandscapePodcast,
      isLandscapeUgc,
      musicPath: resolvedMusicPath,
      musicVolume,
    });
    console.log(`[SplitScreen] ✅ Done: ${outFilename}`);
    res.json({ success: true, filename: outFilename, url: `/output/${outFilename}` });
  } catch (err) {
    console.error('[SplitScreen] ❌ ERROR:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (podcastFile) await unlink(podcastFile.path).catch(() => {});
    if (ugcFile)     await unlink(ugcFile.path).catch(() => {});
    if (musicFile)   await unlink(musicFile.path).catch(() => {});
  }
});

export default router;
