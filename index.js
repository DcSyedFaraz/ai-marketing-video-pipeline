/**
 * Runware Veo 3.1 - Video Generation
 * Generates a video using Google Veo 3.1 via the Runware API.
 * Usage: node index.js
 */

import 'dotenv/config';
import { Runware } from '@runware/sdk-js';
import { writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import https from 'https';
import path from 'path';

const API_KEY = process.env.RUNWARE_API_KEY;

if (!API_KEY || API_KEY === 'your_api_key_here') {
  console.error('ERROR: Please set RUNWARE_API_KEY in your .env file.');
  console.error('Get your key at https://runware.ai');
  process.exit(1);
}

// ---------- Config ----------
const CONFIG = {
  model: 'google/veo-3.1',
  prompt: 'A serene mountain lake at sunrise, mist rising from the water, pine trees reflected on the surface, golden hour light, cinematic 4K',
  duration: 7,          // seconds (7 is the minimum / extension unit)
  width: 1280,
  height: 720,
  outputFormat: 'mp4',
  outputFile: 'output/video1.mp4',
};
// ----------------------------

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = import('fs').then(({ createWriteStream }) => {
      const stream = createWriteStream(dest);
      https.get(url, (response) => {
        response.pipe(stream);
        stream.on('finish', () => { stream.close(); resolve(dest); });
      }).on('error', (err) => {
        import('fs').then(({ unlink }) => unlink(dest, () => {}));
        reject(err);
      });
    });
  });
}

async function downloadVideo(url, dest) {
  const { createWriteStream } = await import('fs');
  const { mkdir } = await import('fs/promises');

  await mkdir(path.dirname(dest), { recursive: true });

  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        downloadVideo(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
    }).on('error', (err) => {
      file.close();
      reject(err);
    });
  });
}

async function generateVideo() {
  console.log('Connecting to Runware API...');
  const runware = new Runware({ apiKey: API_KEY });

  try {
    await runware.ensureConnection();
    console.log('Connected.\n');

    console.log(`Generating video with Veo 3.1...`);
    console.log(`  Prompt : "${CONFIG.prompt}"`);
    console.log(`  Size   : ${CONFIG.width}x${CONFIG.height}`);
    console.log(`  Length : ${CONFIG.duration}s`);
    console.log(`  Model  : ${CONFIG.model}\n`);

    const [result] = await runware.videoInference({
      taskUUID: randomUUID(),
      model: CONFIG.model,
      positivePrompt: CONFIG.prompt,
      duration: CONFIG.duration,
      width: CONFIG.width,
      height: CONFIG.height,
      outputFormat: CONFIG.outputFormat,
      numberResults: 1,
    });

    if (!result || !result.videoURL) {
      throw new Error('No video URL returned from API.');
    }

    console.log(`Video generated!`);
    console.log(`  URL: ${result.videoURL}`);

    console.log(`\nDownloading to ${CONFIG.outputFile}...`);
    await downloadVideo(result.videoURL, CONFIG.outputFile);
    console.log(`Saved: ${CONFIG.outputFile}`);

    // Save metadata for use by extend.js
    const meta = { videoURL: result.videoURL, localFile: CONFIG.outputFile, taskUUID: result.taskUUID };
    writeFileSync('output/video1_meta.json', JSON.stringify(meta, null, 2));
    console.log('Metadata saved to output/video1_meta.json');

    return result;
  } finally {
    runware.disconnect();
  }
}

generateVideo().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
