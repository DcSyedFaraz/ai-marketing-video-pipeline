import { createWriteStream, readFileSync } from 'fs';
import { mkdir } from 'fs/promises';
import https from 'https';
import http from 'http';
import path from 'path';

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

export async function downloadImage(url, dest) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => {
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
    }).on('error', reject);
  });
}
