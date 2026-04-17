import multer, { diskStorage } from 'multer';
import { randomUUID } from 'crypto';
import path from 'path';

const storage = diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`);
  },
});

// For avatar/lipsync (images + small audio/video)
export const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|webp|mp3|wav|m4a|aac|ogg|mp4|webm|mov)$/i;
    allowed.test(file.originalname) ? cb(null, true) : cb(new Error(`File type not allowed: ${file.originalname}`));
  },
});

// For story mode (large hero/bg reference images + unlimited music files for background mixing)
// Hero images can be high-res game art PNGs — gemini.js compresses them before sending to Claude
// Music has no size limit — full-length tracks are mixed into the final video via FFmpeg
export const uploadStory = multer({
  storage,
  limits: { fileSize: Infinity },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|webp|mp3|wav|m4a|aac|ogg)$/i;
    allowed.test(file.originalname) ? cb(null, true) : cb(new Error(`File type not allowed: ${file.originalname}`));
  },
});

// For quick video (small reference images only)
export const uploadQuickVid = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|webp)$/i;
    allowed.test(file.originalname) ? cb(null, true) : cb(new Error(`File type not allowed: ${file.originalname}`));
  },
});

// For bridge/combine/cta-frame (large video files + optional bg music)
export const uploadBridge = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(mp4|webm|mov|mkv|avi|jpg|jpeg|png|webp|mp3|wav|m4a|aac|ogg)$/i;
    allowed.test(file.originalname) ? cb(null, true) : cb(new Error(`File type not allowed: ${file.originalname}`));
  },
});
