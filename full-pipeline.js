/**
 * Runware Veo 3.1 - Full Pipeline
 * Step 1: Generate the initial video with Veo 3.1
 * Step 2: Extend that video by 7 seconds using Veo 3.1 extension
 *
 * Usage: node full-pipeline.js
 * Outputs:
 *   output/video1.mp4             — original generated video
 *   output/video2_extension.mp4   — 7-second extension clip
 */

import 'dotenv/config';
import { Runware } from '@runware/sdk-js';
import { writeFileSync, createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import https from 'https';
import path from 'path';

const API_KEY = process.env.RUNWARE_API_KEY;

if (!API_KEY || API_KEY === 'your_api_key_here') {
  console.error('ERROR: Please set RUNWARE_API_KEY in your .env file.');
  console.error('Get your key at https://runware.ai');
  process.exit(1);
}

// ============================================================
// CONFIGURATION — edit these to customise your videos
// ============================================================
const PIPELINE = {
  model: 'google/veo-3.1',

  // Step 1 — initial video
  video1: {
    prompt: 'A serene mountain lake at sunrise, mist rising from the water, pine trees reflected on the surface, golden hour light, cinematic 4K',
    duration: 7,       // seconds (minimum unit; increase in multiples of 7)
    width: 1280,
    height: 720,
    outputFormat: 'mp4',
    outputFile: 'output/video1.mp4',
  },

  // Step 2 — extension clip appended after video1
  video2: {
    prompt: 'Camera slowly pans across the lake revealing a distant waterfall cascading down a rocky cliff, morning light catching the spray',
    // duration is always 7 for extensions (API requirement)
    outputFormat: 'mp4',
    outputFile: 'output/video2_extension.mp4',
  },
};
// ============================================================

async function downloadVideo(url, dest) {
  await mkdir(path.dirname(dest), { recursive: true });
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    function fetch(targetUrl) {
      https.get(targetUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          file.close();
          return fetch(response.headers.location);
        }
        response.pipe(file);
        file.on('finish', () => { file.close(); resolve(dest); });
      }).on('error', (err) => { file.close(); reject(err); });
    }
    fetch(url);
  });
}

function separator(label) {
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${label}`);
  console.log(`${line}`);
}

async function runPipeline() {
  const runware = new Runware({ apiKey: API_KEY });

  try {
    separator('STEP 0 — Connecting to Runware API');
    await runware.ensureConnection();
    console.log('Connected.\n');

    // ── STEP 1: Generate initial video ──────────────────────────
    separator('STEP 1 — Generating initial video with Veo 3.1');
    const cfg1 = PIPELINE.video1;
    console.log(`  Prompt  : "${cfg1.prompt}"`);
    console.log(`  Size    : ${cfg1.width}x${cfg1.height}`);
    console.log(`  Length  : ${cfg1.duration}s`);
    console.log(`  Model   : ${PIPELINE.model}\n`);

    const [result1] = await runware.videoInference({
      taskUUID: randomUUID(),
      model: PIPELINE.model,
      positivePrompt: cfg1.prompt,
      duration: cfg1.duration,
      width: cfg1.width,
      height: cfg1.height,
      outputFormat: cfg1.outputFormat,
      numberResults: 1,
    });

    if (!result1?.videoURL) throw new Error('Step 1: No video URL returned.');

    console.log(`\nVideo 1 ready!  URL: ${result1.videoURL}`);
    console.log(`Downloading to ${cfg1.outputFile}...`);
    await downloadVideo(result1.videoURL, cfg1.outputFile);
    console.log(`Saved: ${cfg1.outputFile}`);

    // Persist metadata
    writeFileSync('output/video1_meta.json', JSON.stringify({
      videoURL: result1.videoURL,
      localFile: cfg1.outputFile,
      taskUUID: result1.taskUUID,
    }, null, 2));

    // ── STEP 2: Extend the video ─────────────────────────────────
    separator('STEP 2 — Extending video with Veo 3.1 extension');
    const cfg2 = PIPELINE.video2;
    console.log(`  Input   : ${cfg1.outputFile}`);
    console.log(`  Prompt  : "${cfg2.prompt}"`);
    console.log(`  Length  : 7s (fixed by API)\n`);

    const [result2] = await runware.videoInference({
      taskUUID: randomUUID(),
      model: PIPELINE.model,
      positivePrompt: cfg2.prompt,
      duration: 7,                    // always 7 for extension
      outputFormat: cfg2.outputFormat,
      numberResults: 1,
      inputs: [
        {
          type: 'video',
          data: cfg1.outputFile,      // pass local file path; SDK uploads it
        },
      ],
    });

    if (!result2?.videoURL) throw new Error('Step 2: No video URL returned.');

    console.log(`\nVideo extension ready!  URL: ${result2.videoURL}`);
    console.log(`Downloading to ${cfg2.outputFile}...`);
    await downloadVideo(result2.videoURL, cfg2.outputFile);
    console.log(`Saved: ${cfg2.outputFile}`);

    // ── DONE ─────────────────────────────────────────────────────
    separator('DONE');
    console.log(`  Original video  : ${cfg1.outputFile}`);
    console.log(`  Extension clip  : ${cfg2.outputFile}`);
    console.log(`\nTip: use FFmpeg to stitch them into one file:`);
    console.log(`  ffmpeg -f concat -safe 0 -i concat_list.txt -c copy output/final.mp4\n`);

    // Write FFmpeg concat list for convenience
    writeFileSync('output/concat_list.txt',
      `file '${path.resolve(cfg1.outputFile)}'\nfile '${path.resolve(cfg2.outputFile)}'\n`
    );
    console.log(`FFmpeg concat list written to output/concat_list.txt`);

  } finally {
    runware.disconnect();
  }
}

runPipeline().catch((err) => {
  console.error('\nPipeline error:', err.message || err);
  process.exit(1);
});
