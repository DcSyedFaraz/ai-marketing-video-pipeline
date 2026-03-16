import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import { execFile } from 'child_process';
import { existsSync, copyFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

export function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration || 0);
    });
  });
}

export async function extractLastFrame(videoPath, outputJpg) {
  // Use execFile directly so paths with spaces are passed as separate args (no shell splitting).
  // Strategy: -update 1 tells FFmpeg to overwrite the output JPG with every decoded frame.
  // When the video finishes decoding, the file contains the TRUE last frame — pixel-perfect.
  // This decodes the full video so it's slower than seeking, but guarantees the exact last frame.
  return new Promise((resolve, reject) => {
    const args = [
      '-y',                        // overwrite output without asking
      '-i', videoPath,             // input file
      '-update', '1',              // overwrite output per frame → last frame wins
      '-q:v', '2',                 // JPEG quality
      outputJpg,                   // output file
    ];
    console.log(`[FFmpeg] Extracting exact last frame: ${videoPath}`);
    execFile(ffmpegPath, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[FFmpeg extractLastFrame] stderr:', stderr?.slice(-500));
        return reject(new Error(`FFmpeg failed: ${err.message}\n${stderr?.slice(-300)}`));
      }
      if (!existsSync(outputJpg)) {
        console.error('[FFmpeg extractLastFrame] stderr:', stderr?.slice(-500));
        return reject(new Error(`FFmpeg ran but output file was not created: ${outputJpg}`));
      }
      console.log(`[FFmpeg] ✅ Last frame extracted → ${outputJpg}`);
      resolve(outputJpg);
    });
  });
}

export function hasAudioStream(videoPath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) return resolve(false);
      resolve((meta.streams || []).some(s => s.codec_type === 'audio'));
    });
  });
}

/**
 * Concatenate exactly two videos with a hard cut (no crossfade).
 * Memory-efficient: only two clips in memory at once.
 * Used internally by concatMultipleVideos.
 */
function concatTwoVideos(videoA, videoB, outputPath, width, height, durA, durB, hasAudioA, hasAudioB) {
  return new Promise((resolve, reject) => {
    const filters = [
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p[v0]`,
      `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p[v1]`,
      hasAudioA ? '[0:a]aformat=sample_rates=44100:channel_layouts=stereo[a0]'
                : `aevalsrc=0:channel_layouts=stereo:sample_rate=44100:duration=${(durA||5).toFixed(3)}[a0]`,
      hasAudioB ? '[1:a]aformat=sample_rates=44100:channel_layouts=stereo[a1]'
                : `aevalsrc=0:channel_layouts=stereo:sample_rate=44100:duration=${(durB||5).toFixed(3)}[a1]`,
      '[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]',
    ];
    ffmpeg()
      .input(videoA)
      .input(videoB)
      .complexFilter(filters)
      .outputOptions(['-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err, _, stderr) => reject(new Error(`Concat2 failed: ${err.message}\n${stderr?.slice(-400)}`)))
      .run();
  });
}

/**
 * Concatenate N videos into one using sequential pair-by-pair concat.
 * Processes only 2 clips at a time to keep memory usage low (avoids SIGKILL on Railway).
 * Uses hard cuts between clips (no xfade) — xfade with many clips requires all in memory at once.
 * @param {string[]} videoPaths — array of video file paths (at least 2)
 * @param {string}   outputPath
 * @param {object}   opts — { width, height } output resolution
 */
export async function concatMultipleVideos(videoPaths, outputPath, { width = 1080, height = 1920 } = {}) {
  if (!videoPaths || videoPaths.length === 0) throw new Error('No videos to concat');
  if (videoPaths.length === 1) {
    copyFileSync(videoPaths[0], outputPath);
    return outputPath;
  }

  console.log(`[FFmpeg concat] ${videoPaths.length} clips, sequential pair-by-pair`);

  const tmpFiles = [];

  try {
    // Get durations + audio flags for first two clips
    let [dur0, dur1] = await Promise.all([getVideoDuration(videoPaths[0]), getVideoDuration(videoPaths[1])]);
    let [hasA0, hasA1] = await Promise.all([hasAudioStream(videoPaths[0]), hasAudioStream(videoPaths[1])]);

    // Start with first two clips
    let currentPath;
    if (videoPaths.length === 2) {
      currentPath = outputPath; // write directly to final output if only 2 clips
    } else {
      currentPath = join(tmpdir(), `concat-tmp-${randomUUID()}.mp4`);
      tmpFiles.push(currentPath);
    }

    await concatTwoVideos(videoPaths[0], videoPaths[1], currentPath, width, height, dur0, dur1, hasA0, hasA1);
    console.log(`[FFmpeg concat] joined clips 0+1 → ${currentPath}`);

    // Append remaining clips one at a time
    for (let i = 2; i < videoPaths.length; i++) {
      const [durCurr, durNext] = await Promise.all([getVideoDuration(currentPath), getVideoDuration(videoPaths[i])]);
      const [hasACurr, hasANext] = await Promise.all([hasAudioStream(currentPath), hasAudioStream(videoPaths[i])]);

      const isLast = i === videoPaths.length - 1;
      const nextPath = isLast ? outputPath : join(tmpdir(), `concat-tmp-${randomUUID()}.mp4`);
      if (!isLast) tmpFiles.push(nextPath);

      await concatTwoVideos(currentPath, videoPaths[i], nextPath, width, height, durCurr, durNext, hasACurr, hasANext);
      console.log(`[FFmpeg concat] joined with clip ${i} → ${nextPath}`);
      currentPath = nextPath;
    }

    return outputPath;
  } finally {
    // Clean up temp files
    for (const f of tmpFiles) {
      try { if (existsSync(f)) unlinkSync(f); } catch {}
    }
  }
}

/**
 * Mix background music into a video at low volume.
 * Music is looped if shorter than the video, then trimmed to video duration.
 * If the video has no audio track, the music becomes the sole audio.
 * If the video already has audio, music is mixed in at `musicVolume` level.
 * @param {string} videoPath
 * @param {string} musicPath
 * @param {string} outputPath
 * @param {number} musicVolume — 0.0–1.0 (default 0.3 = 30%)
 */
export async function mixMusicIntoVideo(videoPath, musicPath, outputPath, musicVolume = 0.3) {
  const videoDuration = await getVideoDuration(videoPath);
  const videoHasAudio = await hasAudioStream(videoPath);
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(videoPath)
      .input(musicPath)
      .inputOptions(['-stream_loop', '-1']); // loop music if shorter than video
    const filters = videoHasAudio
      ? [
          `[1:a]atrim=duration=${videoDuration.toFixed(3)},asetpts=PTS-STARTPTS,volume=${musicVolume}[music]`,
          `[0:a][music]amix=inputs=2:duration=first:normalize=0[outa]`,
        ]
      : [
          `[1:a]atrim=duration=${videoDuration.toFixed(3)},asetpts=PTS-STARTPTS,volume=${musicVolume}[outa]`,
        ];
    cmd
      .complexFilter(filters)
      .outputOptions([
        '-map', '0:v',
        '-map', '[outa]',
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
      ])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err, _, stderr) => reject(new Error(`Music mix failed: ${err.message}\n${stderr?.slice(-300)}`)))
      .run();
  });
}

export async function concatVideos(video1Path, video2Path, outputPath) {
  const [audio1, audio2, dur1, dur2] = await Promise.all([
    hasAudioStream(video1Path), hasAudioStream(video2Path),
    getVideoDuration(video1Path), getVideoDuration(video2Path),
  ]);

  return new Promise((resolve, reject) => {
    const filters = [
      '[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v0]',
      '[1:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v1]',
      audio1 ? '[0:a]aformat=sample_rates=44100:channel_layouts=stereo[a0]' : `aevalsrc=0:channel_layouts=stereo:sample_rate=44100:duration=${(dur1||5).toFixed(3)}[a0]`,
      audio2 ? '[1:a]aformat=sample_rates=44100:channel_layouts=stereo[a1]' : `aevalsrc=0:channel_layouts=stereo:sample_rate=44100:duration=${(dur2||5).toFixed(3)}[a1]`,
      '[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]',
    ];

    ffmpeg()
      .input(video1Path)
      .input(video2Path)
      .complexFilter(filters)
      .outputOptions(['-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .run();
  });
}
