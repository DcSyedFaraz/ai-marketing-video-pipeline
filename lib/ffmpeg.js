import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { execFile } from 'child_process';
import { existsSync } from 'fs';

ffmpeg.setFfmpegPath(ffmpegPath);

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
 * Concatenate N videos into one with smooth crossfade transitions between clips.
 * Each clip overlaps the next by XFADE_DUR seconds — video uses xfade filter,
 * audio uses acrossfade — so cuts feel seamless rather than hard-cut.
 * @param {string[]} videoPaths — array of video file paths (at least 2)
 * @param {string}   outputPath
 * @param {object}   opts — { width, height, xfadeDur } output resolution + crossfade duration
 */
export async function concatMultipleVideos(videoPaths, outputPath, { width = 1080, height = 1920, xfadeDur = 0.4 } = {}) {
  if (!videoPaths || videoPaths.length === 0) throw new Error('No videos to concat');
  if (videoPaths.length === 1) {
    const { copyFileSync } = await import('fs');
    copyFileSync(videoPaths[0], outputPath);
    return outputPath;
  }

  // Get durations + audio flags for all inputs (in parallel)
  const [durations, audioFlags] = await Promise.all([
    Promise.all(videoPaths.map(vp => getVideoDuration(vp))),
    Promise.all(videoPaths.map(vp => hasAudioStream(vp))),
  ]);

  // Cap xfadeDur to half of the shortest clip so we never overlap more than a clip's half
  const minDur = Math.min(...durations.map(d => d || 5));
  const xf = Math.min(xfadeDur, minDur / 2, 0.8);

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();
    for (const vp of videoPaths) cmd.input(vp);

    const filters = [];
    const n = videoPaths.length;

    // ── Step 1: normalise every clip to same resolution, fps, sample rate ──
    for (let i = 0; i < n; i++) {
      filters.push(
        `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,` +
        `format=yuv420p[sv${i}]`
      );
      if (audioFlags[i]) {
        filters.push(
          `[${i}:a]aformat=sample_rates=44100:channel_layouts=stereo[sa${i}]`
        );
      } else {
        // Generate silence via aevalsrc inside the filtergraph (no lavfi input device needed)
        const dur = (durations[i] || 5).toFixed(3);
        filters.push(
          `aevalsrc=0:channel_layouts=stereo:sample_rate=44100:duration=${dur}[sa${i}]`
        );
      }
    }

    // ── Step 2: chain xfade (video) + acrossfade (audio) across all clips ──
    // offset = sum of (duration - xf) for all previous clips
    // Each transition: [prevV][nextV] → xfade → [xv{i}], [prevA][nextA] → acrossfade → [xa{i}]
    let runningOffset = 0;
    let prevV = `sv0`;
    let prevA = `sa0`;

    for (let i = 1; i < n; i++) {
      runningOffset += (durations[i - 1] || 5) - xf;
      const offset = runningOffset.toFixed(3);
      const outV = i < n - 1 ? `xv${i}` : 'outv';
      const outA = i < n - 1 ? `xa${i}` : 'outa';

      filters.push(
        `[${prevV}][sv${i}]xfade=transition=fade:duration=${xf.toFixed(3)}:offset=${offset}[${outV}]`
      );
      filters.push(
        `[${prevA}][sa${i}]acrossfade=d=${xf.toFixed(3)}[${outA}]`
      );

      prevV = outV;
      prevA = outA;
    }

    cmd
      .complexFilter(filters)
      .outputOptions([
        '-map', '[outv]', '-map', '[outa]',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
      ])
      .output(outputPath)
      .on('start', cmd => console.log(`[FFmpeg concat+xfade] ${n} clips, xf=${xf.toFixed(2)}s`))
      .on('end', () => resolve(outputPath))
      .on('error', (err, _, stderr) => reject(new Error(`Concat failed: ${err.message}\n${stderr?.slice(-400)}`)))
      .run();
  });
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
