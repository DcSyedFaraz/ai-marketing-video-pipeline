// ── Combine Tab ─────────────────────────────────────────────────────────────
// POST /api/combine
// Concatenates two videos (from output/ or uploaded) into a single 9:16 MP4

import { Router } from 'express';
import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import path from 'path';

import { uploadBridge } from '../lib/multer.js';
import { concatVideos } from '../lib/ffmpeg.js';

const router = Router();

router.post('/api/combine', uploadBridge.fields([
  { name: 'upload1', maxCount: 1 },
  { name: 'upload2', maxCount: 1 },
]), async (req, res) => {
  const safe = f => (f || '').replace(/[^a-zA-Z0-9_.\-]/g, '');
  const upload1 = req.files?.upload1?.[0];
  const upload2 = req.files?.upload2?.[0];
  const file1 = safe(req.body.video1);
  const file2 = safe(req.body.video2);
  const orient = req.body.orient === 'landscape' ? 'landscape' : 'portrait';
  const [outW, outH] = orient === 'landscape' ? [1920, 1080] : [1080, 1920];

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
    await concatVideos(v1path, v2path, outPath, { width: outW, height: outH });
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

export default router;
