import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import { execFile, execFileSync } from 'child_process';
import { existsSync, copyFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

// Use system ffmpeg if available (Docker/Cloud Run), otherwise fall back to ffmpeg-static
function resolveSystemBinary(name, fallback) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    console.log(`[FFmpeg] Using system ${name}`);
    return name;
  } catch {
    console.log(`[FFmpeg] System ${name} not found, using bundled`);
    return fallback;
  }
}

const ffmpegPath = resolveSystemBinary('ffmpeg', ffmpegStatic);
const ffprobePath = resolveSystemBinary('ffprobe', ffprobeInstaller.path);

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

export function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration || 0);
    });
  });
}

export async function extractLastFrame(videoPath, outputJpg) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', videoPath,
      '-update', '1',
      '-q:v', '2',
      outputJpg,
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

const FADE_DUR = 0.3; // seconds of fade-out + fade-in between clips

function concatTwoVideos(videoA, videoB, outputPath, width, height, durA, durB, hasAudioA, hasAudioB, fade = false) {
  return new Promise((resolve, reject) => {
    let vA, vB, aA, aB;
    if (fade) {
      const fd = FADE_DUR;
      const fadeOutStart = Math.max(0, (durA || 5) - fd);
      vA = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p,fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fd}[v0]`;
      vB = `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p,fade=t=in:st=0:d=${fd}[v1]`;
      aA = hasAudioA ? `[0:a]aformat=sample_rates=44100:channel_layouts=stereo,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fd}[a0]`
                     : `aevalsrc=0:channel_layouts=stereo:sample_rate=44100:duration=${(durA||5).toFixed(3)}[a0]`;
      aB = hasAudioB ? `[1:a]aformat=sample_rates=44100:channel_layouts=stereo,afade=t=in:st=0:d=${fd}[a1]`
                     : `aevalsrc=0:channel_layouts=stereo:sample_rate=44100:duration=${(durB||5).toFixed(3)}[a1]`;
    } else {
      vA = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p[v0]`;
      vB = `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p[v1]`;
      aA = hasAudioA ? `[0:a]aformat=sample_rates=44100:channel_layouts=stereo[a0]`
                     : `aevalsrc=0:channel_layouts=stereo:sample_rate=44100:duration=${(durA||5).toFixed(3)}[a0]`;
      aB = hasAudioB ? `[1:a]aformat=sample_rates=44100:channel_layouts=stereo[a1]`
                     : `aevalsrc=0:channel_layouts=stereo:sample_rate=44100:duration=${(durB||5).toFixed(3)}[a1]`;
    }
    const filters = [vA, vB, aA, aB, '[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]'];
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
 * Concatenate N videos into one.
 * - fade=false: tries stream copy first (fast, no re-encode), falls back to re-encode on failure
 * - fade=true:  re-encodes with 0.3s fade-to-black between clips (stream copy can't do filters)
 * @param {string[]} videoPaths
 * @param {string}   outputPath
 * @param {object}   opts — { width, height, fade }
 */
export async function concatMultipleVideos(videoPaths, outputPath, { width = 1080, height = 1920, fade = false } = {}) {
  if (!videoPaths || videoPaths.length === 0) throw new Error('No videos to concat');
  if (videoPaths.length === 1) {
    copyFileSync(videoPaths[0], outputPath);
    return outputPath;
  }

  console.log(`[FFmpeg concat] ${videoPaths.length} clips, transition=${fade ? 'fade' : 'cut'}`);

  // Hard cut: try stream copy first (fastest, no quality loss)
  if (!fade) {
    const listFile = join(tmpdir(), `concat-list-${randomUUID()}.txt`);
    try {
      const { writeFileSync } = await import('fs');
      const lines = videoPaths.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
      writeFileSync(listFile, lines, 'utf8');
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(listFile)
          .inputOptions(['-f', 'concat', '-safe', '0'])
          .outputOptions(['-c', 'copy', '-fflags', '+genpts', '-movflags', '+faststart'])
          .output(outputPath)
          .on('start', () => console.log('[FFmpeg concat] stream copy start'))
          .on('end', () => { console.log('[FFmpeg concat] ✅ stream copy done'); resolve(); })
          .on('error', (err, _, stderr) => reject(new Error(`Stream copy failed: ${err.message}\n${stderr?.slice(-300)}`)))
          .run();
      });
      return outputPath;
    } catch (err) {
      console.warn('[FFmpeg concat] stream copy failed, falling back to re-encode:', err.message);
      try { if (existsSync(listFile)) unlinkSync(listFile); } catch {}
      // fall through to re-encode below
    } finally {
      try { if (existsSync(listFile)) unlinkSync(listFile); } catch {}
    }
  }

  // Fade or re-encode fallback: pair-by-pair
  const tmpFiles = [];
  try {
    let [dur0, dur1] = await Promise.all([getVideoDuration(videoPaths[0]), getVideoDuration(videoPaths[1])]);
    let [hasA0, hasA1] = await Promise.all([hasAudioStream(videoPaths[0]), hasAudioStream(videoPaths[1])]);

    let currentPath = videoPaths.length === 2
      ? outputPath
      : join(tmpdir(), `concat-tmp-${randomUUID()}.mp4`);
    if (videoPaths.length > 2) tmpFiles.push(currentPath);

    await concatTwoVideos(videoPaths[0], videoPaths[1], currentPath, width, height, dur0, dur1, hasA0, hasA1, fade);

    for (let i = 2; i < videoPaths.length; i++) {
      const [durCurr, durNext] = await Promise.all([getVideoDuration(currentPath), getVideoDuration(videoPaths[i])]);
      const [hasACurr, hasANext] = await Promise.all([hasAudioStream(currentPath), hasAudioStream(videoPaths[i])]);
      const isLast = i === videoPaths.length - 1;
      const nextPath = isLast ? outputPath : join(tmpdir(), `concat-tmp-${randomUUID()}.mp4`);
      if (!isLast) tmpFiles.push(nextPath);
      await concatTwoVideos(currentPath, videoPaths[i], nextPath, width, height, durCurr, durNext, hasACurr, hasANext, fade);
      currentPath = nextPath;
    }

    return outputPath;
  } finally {
    for (const f of tmpFiles) {
      try { if (existsSync(f)) unlinkSync(f); } catch {}
    }
  }
}

/**
 * Mix background music into a video at low volume.
 */
export async function mixMusicIntoVideo(videoPath, musicPath, outputPath, musicVolume = 0.3) {
  const videoDuration = await getVideoDuration(videoPath);
  const videoHasAudio = await hasAudioStream(videoPath);
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(videoPath)
      .input(musicPath)
      .inputOptions(['-stream_loop', '-1']);
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
