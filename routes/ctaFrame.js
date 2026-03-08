// ── CTA Frame Tab ────────────────────────────────────────────────────────────
// POST /api/generate-cta-frame
// Uploads a video, extracts its last frame, then generates a CTA image
// using Nano Bana 2 (google:4@3) with reference.jpg for logo overlay

import { Router } from 'express';
import { Runware } from '@runware/sdk-js';
import { randomUUID } from 'crypto';
import { unlink, mkdir, writeFile } from 'fs/promises';
import { createWriteStream, readFileSync } from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';

import { uploadBridge } from '../lib/multer.js';
import { fileToDataURI } from '../lib/helpers.js';
import { extractLastFrame } from '../lib/ffmpeg.js';
import { addHistoryEntry } from '../lib/history.js';

const router = Router();
const API_KEY = process.env.RUNWARE_API_KEY;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

router.post('/api/generate-cta-frame', uploadBridge.fields([
  { name: 'video', maxCount: 1 },
]), async (req, res) => {
  const videoFile = req.files?.video?.[0];
  if (!videoFile) return res.status(400).json({ error: 'Video file is required.' });

  const taskUUID = randomUUID();
  const frameJpg = path.join('uploads', `frame_${Date.now()}.jpg`);
  const ctaDir = path.join('output', 'cta_frames', taskUUID);

  res.json({ status: 'submitted', taskUUID });

  (async () => {
    const logs = [];
    const log = (msg) => { logs.push(msg); console.log(msg); };
    try {
      await mkdir(ctaDir, { recursive: true });

      // Step 1: Extract last frame
      log(`[CTAFrame] Extracting last frame from ${videoFile.originalname}...`);
      await extractLastFrame(videoFile.path, frameJpg);
      log(`[CTAFrame] Last frame saved → ${frameJpg}`);

      // Step 2: Copy last frame to ctaDir
      const lastFramePath = path.join(ctaDir, 'last_frame.jpg');
      const frameData = readFileSync(frameJpg);
      await writeFile(lastFramePath, frameData);

      // Step 3: Generate CTA image with Nano Bana 2
      const refImagePath = path.join(__dirname, '..', 'public', 'reference.jpg');
      const lastFrameDataURI = fileToDataURI(frameJpg, 'image/jpeg');
      const refDataURI = fileToDataURI(refImagePath, 'image/jpeg');
      log(`[CTAFrame] Generating CTA image with Nano Bana 2...`);

      const runware = new Runware({ apiKey: API_KEY });
      await runware.ensureConnection();

      const ctaImages = await runware.imageInference({
        taskUUID: randomUUID(),
        model: 'google:4@3',
        positivePrompt: 'Take the first reference image as the base photo. Overlay the exact logo and CTA button from the second reference image onto the base photo. Preserve the logo design, colors, and text exactly as shown in the second reference — do not alter, recreate, or replace the logo. Place the logo in the top or bottom area of the image. Maintain a professional marketing look.',
        inputs: { referenceImages: [lastFrameDataURI, refDataURI] },
        width: 3072,
        height: 5504,
        numberResults: 1,
        includeCost: true,
        outputType: ['URL'],
      });

      runware.disconnect();

      if (ctaImages?.length && ctaImages[0].imageURL) {
        const ctaImagePath = path.join(ctaDir, 'cta_frame.jpg');
        await new Promise((resolve, reject) => {
          const protocol = ctaImages[0].imageURL.startsWith('https') ? https : http;
          protocol.get(ctaImages[0].imageURL, (res2) => {
            const file = createWriteStream(ctaImagePath);
            res2.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
            file.on('error', reject);
          }).on('error', reject);
        });
        log(`[CTAFrame] ✅ CTA image saved → ${ctaImagePath}`);

        addHistoryEntry({
          taskUUID,
          type: 'cta-frame',
          videoName: videoFile.originalname,
          status: 'completed',
          submittedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          lastFrameUrl: `/output/cta_frames/${taskUUID}/last_frame.jpg`,
          ctaImageUrl: `/output/cta_frames/${taskUUID}/cta_frame.jpg`,
          ctaFramesDir: `/output/cta_frames/${taskUUID}`,
          cost: ctaImages[0].cost ?? null,
        });
      } else {
        log(`[CTAFrame] ⚠ No image returned from API`);
      }
    } catch (err) {
      const errMsg = err?.message || (typeof err === 'string' ? err : JSON.stringify(err));
      log(`[CTAFrame] ❌ ERROR: ${errMsg}`);
      console.error(`[CTAFrame] ERROR (full):`, err);
    } finally {
      await unlink(videoFile.path).catch(() => {});
      await unlink(frameJpg).catch(() => {});
    }
  })();
});

export default router;
