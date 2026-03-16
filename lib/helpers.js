import { createWriteStream, readFileSync } from 'fs';
import { mkdir } from 'fs/promises';
import https from 'https';
import http from 'http';
import path from 'path';
import sharp from 'sharp';
import { extractLastFrame } from './ffmpeg.js';

export function fileToDataURI(filePath, mimeType) {
  const data = readFileSync(path.resolve(filePath));
  return `data:${mimeType};base64,${data.toString('base64')}`;
}

export function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.webp': 'image/webp',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
  };
  return map[ext] || 'application/octet-stream';
}

export async function downloadVideo(url, dest) {
  await mkdir(path.dirname(dest), { recursive: true });
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadVideo(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
      file.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Generate a small thumbnail from an image file using sharp.
 * Output is always a JPEG at 200px wide (height auto to preserve aspect ratio).
 * Returns the thumb path, or null if it fails (non-fatal).
 */
export async function generateImageThumb(srcPath, thumbPath) {
  try {
    await sharp(srcPath)
      .resize({ width: 200, withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toFile(thumbPath);
    return thumbPath;
  } catch (e) {
    console.warn('[Thumb] Image thumb failed:', e.message);
    return null;
  }
}

/**
 * Generate a thumbnail from a video by extracting the first frame as a JPEG.
 * Returns the thumb path, or null if it fails (non-fatal).
 */
export async function generateVideoThumb(videoPath, thumbPath) {
  try {
    await extractLastFrame(videoPath, thumbPath);
    // Downscale the extracted frame to 200px wide
    await sharp(thumbPath)
      .resize({ width: 200, withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toFile(thumbPath + '.tmp.jpg');
    const { renameSync } = await import('fs');
    renameSync(thumbPath + '.tmp.jpg', thumbPath);
    return thumbPath;
  } catch (e) {
    console.warn('[Thumb] Video thumb failed:', e.message);
    return null;
  }
}

export async function downloadImage(url, dest) {
  await mkdir(path.dirname(dest), { recursive: true });
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadImage(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`Image download failed: HTTP ${res.statusCode}`));
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    }).on('error', reject);
  });
}
