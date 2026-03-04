/**
 * Runware KlingAI Avatar 2.0 Pro - Avatar Video Generation
 *
 * Generates a talking avatar video from:
 *   - A portrait/character image (drives appearance)
 *   - An audio track (drives lip-sync, expression, timing)
 *   - An optional text prompt (refines tone/emotion)
 *
 * Usage:
 *   node kling-avatar.js <imagePath> <audioPath> [prompt]
 *
 * Examples:
 *   node kling-avatar.js ./assets/face.jpg ./assets/speech.mp3
 *   node kling-avatar.js ./assets/face.jpg ./assets/speech.mp3 "Speak with enthusiasm and warmth"
 */

import 'dotenv/config';
import { Runware } from '@runware/sdk-js';
import { writeFileSync, readFileSync, createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import https from 'https';
import http from 'http';
import path from 'path';

const API_KEY = process.env.RUNWARE_API_KEY;

if (!API_KEY || API_KEY === 'your_api_key_here') {
  console.error('ERROR: Please set RUNWARE_API_KEY in your .env file.');
  console.error('Get your key at https://runware.ai');
  process.exit(1);
}

// ---------- Config ----------
const CONFIG = {
  model: 'klingai:avatar@2.0-pro',
  outputFormat: 'mp4',
  outputDir: 'output',
  outputFile: 'output/avatar_video.mp4',
};
// ----------------------------

/**
 * Read a local file and encode it as a base64 data URI
 */
function fileToDataURI(filePath, mimeType) {
  const absolutePath = path.resolve(filePath);
  const data = readFileSync(absolutePath);
  const base64 = data.toString('base64');
  return `data:${mimeType};base64,${base64}`;
}

/**
 * Detect MIME type from file extension
 */
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const imageTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
  const audioTypes = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg' };
  return imageTypes[ext] || audioTypes[ext] || 'application/octet-stream';
}

/**
 * Download a video from URL to local file, following redirects
 */
async function downloadVideo(url, dest) {
  await mkdir(path.dirname(dest), { recursive: true });

  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    const request = protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        downloadVideo(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Download failed with status: ${response.statusCode}`));
        return;
      }

      const file = createWriteStream(dest);
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
      file.on('error', (err) => { file.close(); reject(err); });
    });

    request.on('error', reject);
  });
}

/**
 * Main avatar generation function
 */
async function generateAvatarVideo(imagePath, audioPath, prompt = '') {
  console.log('\n========================================');
  console.log('  KlingAI Avatar 2.0 Pro - Runware API  ');
  console.log('========================================\n');

  if (!imagePath || !audioPath) {
    console.error('Usage: node kling-avatar.js <imagePath> <audioPath> [prompt]');
    console.error('  imagePath : path to portrait/character image (JPG, PNG, WEBP)');
    console.error('  audioPath : path to audio file (MP3, WAV, M4A, AAC)');
    console.error('  prompt    : optional text to refine tone/emotion (max 2500 chars)');
    process.exit(1);
  }

  // Validate files exist
  try {
    readFileSync(path.resolve(imagePath));
  } catch {
    console.error(`ERROR: Image file not found: ${imagePath}`);
    process.exit(1);
  }

  try {
    readFileSync(path.resolve(audioPath));
  } catch {
    console.error(`ERROR: Audio file not found: ${audioPath}`);
    process.exit(1);
  }

  console.log('Configuration:');
  console.log(`  Model   : ${CONFIG.model}`);
  console.log(`  Image   : ${imagePath}`);
  console.log(`  Audio   : ${audioPath}`);
  console.log(`  Prompt  : ${prompt || '(none)'}`);
  console.log(`  Output  : ${CONFIG.outputFile}\n`);

  // Encode files as data URIs for API submission
  console.log('Encoding image...');
  const imageMime = getMimeType(imagePath);
  const imageDataURI = fileToDataURI(imagePath, imageMime);
  console.log(`  Image size: ${(imageDataURI.length / 1024).toFixed(1)} KB (encoded)`);

  console.log('Encoding audio...');
  const audioMime = getMimeType(audioPath);
  const audioDataURI = fileToDataURI(audioPath, audioMime);
  console.log(`  Audio size: ${(audioDataURI.length / 1024).toFixed(1)} KB (encoded)\n`);

  // Connect to Runware API
  console.log('Connecting to Runware API...');
  const runware = new Runware({ apiKey: API_KEY });

  try {
    await runware.ensureConnection();
    console.log('Connected.\n');

    console.log('Submitting avatar generation request...');
    console.log('(This may take a few minutes for longer audio tracks)\n');

    // Build API request payload
    const requestPayload = {
      taskUUID: randomUUID(),
      model: CONFIG.model,
      outputFormat: CONFIG.outputFormat,
      numberResults: 1,
      inputs: {
        image: imageDataURI,
        audio: audioDataURI,
      },
    };

    // Add optional prompt if provided
    if (prompt && prompt.trim()) {
      requestPayload.positivePrompt = prompt.trim().slice(0, 2500);
    }

    const [result] = await runware.videoInference(requestPayload);

    if (!result || !result.videoURL) {
      throw new Error('No video URL returned from API. Check your inputs and API key.');
    }

    console.log('Avatar video generated!');
    console.log(`  Video URL : ${result.videoURL}`);
    if (result.cost) console.log(`  Cost      : $${result.cost.toFixed(4)}`);
    if (result.taskUUID) console.log(`  Task UUID : ${result.taskUUID}`);

    console.log(`\nDownloading to ${CONFIG.outputFile}...`);
    await downloadVideo(result.videoURL, CONFIG.outputFile);
    console.log(`Saved: ${CONFIG.outputFile}`);

    // Save metadata
    const meta = {
      model: CONFIG.model,
      videoURL: result.videoURL,
      localFile: CONFIG.outputFile,
      taskUUID: result.taskUUID,
      imagePath,
      audioPath,
      prompt: prompt || null,
      generatedAt: new Date().toISOString(),
      cost: result.cost || null,
    };
    const metaFile = 'output/avatar_meta.json';
    writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    console.log(`Metadata saved to ${metaFile}`);

    console.log('\n========================================');
    console.log('  Done! Avatar video ready.            ');
    console.log('========================================\n');

    return result;

  } finally {
    runware.disconnect();
  }
}

// Parse CLI arguments
const [,, imagePath, audioPath, ...promptParts] = process.argv;
const prompt = promptParts.join(' ');

generateAvatarVideo(imagePath, audioPath, prompt).catch((err) => {
  console.error('\nError:', err.message || err);
  process.exit(1);
});
