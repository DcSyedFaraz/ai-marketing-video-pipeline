/**
 * Runware Veo 3.1 - Video Extension
 * Extends an existing video by 7 seconds using Veo 3.1's extension feature.
 *
 * Requirements for the input video:
 *   - Duration : max 30 seconds
 *   - Resolution: 1280x720 or 720x1280
 *   - Frame rate: 24 FPS
 *
 * Usage: node extend.js [path-to-video] [prompt]
 *   Example: node extend.js output/video1.mp4 "Camera slowly pans right revealing a waterfall"
 *   If no arguments are given, the script reads output/video1_meta.json written by index.js.
 */

import 'dotenv/config';
import { Runware } from '@runware/sdk-js';
import { readFileSync, createReadStream, createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import https from 'https';
import path from 'path';

const API_KEY = process.env.RUNWARE_API_KEY;

if (!API_KEY || API_KEY === 'your_api_key_here') {
  console.error('ERROR: Please set RUNWARE_API_KEY in your .env file.');
  process.exit(1);
}

// ---------- Resolve inputs ----------
let inputVideoPath = process.argv[2];
let extensionPrompt = process.argv[3] || 'Continue the scene naturally, maintaining the same cinematic style and atmosphere';

if (!inputVideoPath) {
  try {
    const meta = JSON.parse(readFileSync('output/video1_meta.json', 'utf8'));
    inputVideoPath = meta.localFile;
    console.log(`Using video from previous run: ${inputVideoPath}`);
  } catch {
    console.error('No input video provided and output/video1_meta.json not found.');
    console.error('Run "node index.js" first, or pass the video path as an argument.');
    process.exit(1);
  }
}
// ------------------------------------

async function downloadVideo(url, dest) {
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
    }).on('error', (err) => { file.close(); reject(err); });
  });
}

async function extendVideo() {
  console.log('Connecting to Runware API...');
  const runware = new Runware({ apiKey: API_KEY });

  try {
    await runware.ensureConnection();
    console.log('Connected.\n');

    console.log(`Extending video: ${inputVideoPath}`);
    console.log(`  Extension prompt : "${extensionPrompt}"`);
    console.log(`  Extension length : 7 seconds (fixed by API)`);
    console.log(`  Model            : google/veo-3.1\n`);

    // The SDK accepts a local file path or a URL for inputs.video.
    // We pass the local file path directly; the SDK handles the upload.
    const [result] = await runware.videoInference({
      taskUUID: randomUUID(),
      model: 'google/veo-3.1',
      positivePrompt: extensionPrompt,
      duration: 7,              // Extension is always 7 seconds
      // Do NOT pass width/height when extending — API requirement
      outputFormat: 'mp4',
      numberResults: 1,
      inputs: [
        {
          type: 'video',
          data: inputVideoPath,  // local file path (SDK uploads it) or video URL
        },
      ],
    });

    if (!result || !result.videoURL) {
      throw new Error('No video URL returned from API.');
    }

    const outputFile = 'output/video2_extension.mp4';
    console.log(`Extension generated!`);
    console.log(`  URL: ${result.videoURL}`);

    console.log(`\nDownloading to ${outputFile}...`);
    await downloadVideo(result.videoURL, outputFile);
    console.log(`Saved: ${outputFile}`);

    return result;
  } finally {
    runware.disconnect();
  }
}

extendVideo().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
