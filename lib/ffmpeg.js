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

async function concatTwoVideos(videoA, videoB, outputPath, width, height, durA, durB, hasAudioA, hasAudioB, fade = false) {
  // Two-pass approach: normalize each clip to a temp file, then concat via demuxer.
  // This avoids FFmpeg "Reconfiguring filter graph" when inputs have different colorspaces.

  const tmpA = join(tmpdir(), `normA_${randomUUID()}.mp4`);
  const tmpB = join(tmpdir(), `normB_${randomUUID()}.mp4`);
  const concatList = join(tmpdir(), `concat2_${randomUUID()}.txt`);

  function normalizeClip(inputPath, tmpPath, hasAudio, dur, fadeType) {
    return new Promise((resolve, reject) => {
      const vFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p`;
      let vChain = `[0:v]setpts=PTS-STARTPTS,${vFilter}`;
      let aChain;

      if (fade && fadeType === 'out') {
        const fd = FADE_DUR;
        const fadeOutStart = Math.max(0, (dur || 5) - fd);
        vChain += `,fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fd}`;
        aChain = hasAudio
          ? `[0:a]asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fd}[outa]`
          : `aevalsrc=0:channel_layout=stereo:sample_rate=44100:duration=${(dur||5).toFixed(3)}[outa]`;
      } else if (fade && fadeType === 'in') {
        const fd = FADE_DUR;
        vChain += `,fade=t=in:st=0:d=${fd}`;
        aChain = hasAudio
          ? `[0:a]asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo,afade=t=in:st=0:d=${fd}[outa]`
          : `aevalsrc=0:channel_layout=stereo:sample_rate=44100:duration=${(dur||5).toFixed(3)}[outa]`;
      } else {
        aChain = hasAudio
          ? `[0:a]asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[outa]`
          : `aevalsrc=0:channel_layout=stereo:sample_rate=44100:duration=${(dur||5).toFixed(3)}[outa]`;
      }
      vChain += '[outv]';

      const filterGraph = `${vChain};${aChain}`;
      const args = [
        '-y',
        '-i', inputPath,
        '-filter_complex', filterGraph,
        '-map', '[outv]', '-map', '[outa]',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
        '-movflags', '+faststart',
        tmpPath,
      ];

      console.log(`[FFmpeg normalize2] ${inputPath} → ${tmpPath}`);
      execFile(ffmpegPath, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`Normalize failed: ${err.message}\n${stderr?.slice(-400)}`));
        resolve(tmpPath);
      });
    });
  }

  try {
    await Promise.all([
      normalizeClip(videoA, tmpA, hasAudioA, durA, fade ? 'out' : null),
      normalizeClip(videoB, tmpB, hasAudioB, durB, fade ? 'in' : null),
    ]);

    const { writeFileSync } = await import('fs');
    writeFileSync(concatList, `file '${tmpA.replace(/\\/g, '/')}'\nfile '${tmpB.replace(/\\/g, '/')}'`);

    await new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-f', 'concat', '-safe', '0', '-i', concatList,
        '-c', 'copy',
        '-movflags', '+faststart',
        outputPath,
      ];
      execFile(ffmpegPath, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`Concat2 demuxer failed: ${err.message}\n${stderr?.slice(-400)}`));
        resolve(outputPath);
      });
    });

    return outputPath;
  } finally {
    try { unlinkSync(tmpA); } catch {}
    try { unlinkSync(tmpB); } catch {}
    try { unlinkSync(concatList); } catch {}
  }
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
 * Create a split-screen composite from a podcast video + UGC video.
 *
 * Layout (output always 1080x1920 portrait):
 *  - portrait + portrait  → side-by-side (hstack), each 540×1920
 *  - landscape + portrait → podcast top 1/3 (1080×640) / UGC bottom 2/3 (1080×1280) vstack
 *  - portrait + landscape → podcast top 2/3 (1080×1280) / UGC bottom 1/3 (1080×640) vstack
 *  - landscape + landscape→ podcast top 1/3 / UGC bottom 2/3 vstack
 *
 * If one video is shorter, the longer video plays full-screen for the remainder.
 * Optional background music mixed at low volume.
 */
export async function createSplitScreen(podcastPath, ugcPath, outputPath, {
  isLandscapePodcast = false,
  isLandscapeUgc = false,
  musicPath = null,
  musicVolume = 0.15,
} = {}) {
  const [podcastDur, ugcDur, podcastHasAudio, ugcHasAudio] = await Promise.all([
    getVideoDuration(podcastPath),
    getVideoDuration(ugcPath),
    hasAudioStream(podcastPath),
    hasAudioStream(ugcPath),
  ]);

  const minDur = Math.min(podcastDur, ugcDur);
  const maxDur = Math.max(podcastDur, ugcDur);
  const equalDurs = (maxDur - minDur) < 0.1;
  const longerIs = podcastDur >= ugcDur ? 'podcast' : 'ugc';

  const tmpPhase1 = join(tmpdir(), `ss_p1_${randomUUID()}.mp4`);
  const tmpPhase2 = equalDurs ? null : join(tmpdir(), `ss_p2_${randomUUID()}.mp4`);
  // composed = final video before music mix; if no music, write directly to outputPath
  const composedPath = musicPath
    ? join(tmpdir(), `ss_comp_${randomUUID()}.mp4`)
    : outputPath;
  const tmpFiles = [tmpPhase1];
  if (tmpPhase2) tmpFiles.push(tmpPhase2);
  if (musicPath) tmpFiles.push(composedPath);

  try {
    // ── Phase 1: simultaneous split screen ─────────────────────────────────
    console.log(`[SplitScreen] Phase 1: split screen for ${minDur.toFixed(2)}s`);

    // Build video split filters.
    // Every slot uses scale-to-FILL + center-crop to exact dimensions.
    // No letterboxing/padding on individual slots = zero black bars between zones.
    // First video gets padded to full 1080x1920 canvas, second is overlaid.
    //
    // fill(idx,w,h) = scale to overshoot then crop to exact w×h from center
    const fill = (idx, w, h) =>
      `[${idx}:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:(iw-${w})/2:(ih-${h})/2,setsar=1,fps=24,format=yuv420p`;

    let phase1VideoFilters;
    if (!isLandscapePodcast && !isLandscapeUgc) {
      // Both portrait → side-by-side: podcast left 540px, UGC right 540px
      phase1VideoFilters = [
        `${fill(0, 540, 1920)},pad=1080:1920:0:0:black[base]`,
        `${fill(1, 540, 1920)}[right]`,
        `[base][right]overlay=x=540:y=0:shortest=1,trim=duration=${minDur.toFixed(3)},setpts=PTS-STARTPTS[outv]`,
      ];
    } else if (isLandscapePodcast && !isLandscapeUgc) {
      // Landscape podcast top 640px, portrait UGC bottom 1280px
      phase1VideoFilters = [
        `${fill(0, 1080, 640)},pad=1080:1920:0:0:black[base]`,
        `${fill(1, 1080, 1280)}[bottom]`,
        `[base][bottom]overlay=x=0:y=640:shortest=1,trim=duration=${minDur.toFixed(3)},setpts=PTS-STARTPTS[outv]`,
      ];
    } else if (!isLandscapePodcast && isLandscapeUgc) {
      // Portrait podcast top 1280px, landscape UGC bottom 640px
      phase1VideoFilters = [
        `${fill(0, 1080, 1280)},pad=1080:1920:0:0:black[base]`,
        `${fill(1, 1080, 640)}[bottom]`,
        `[base][bottom]overlay=x=0:y=1280:shortest=1,trim=duration=${minDur.toFixed(3)},setpts=PTS-STARTPTS[outv]`,
      ];
    } else {
      // Both landscape → podcast top 640px, UGC bottom 1280px
      phase1VideoFilters = [
        `${fill(0, 1080, 640)},pad=1080:1920:0:0:black[base]`,
        `${fill(1, 1080, 1280)}[bottom]`,
        `[base][bottom]overlay=x=0:y=640:shortest=1,trim=duration=${minDur.toFixed(3)},setpts=PTS-STARTPTS[outv]`,
      ];
    }

    // Build audio mix filters for phase 1
    // Podcast audio is dominant (full volume), UGC is background (25%)
    const aP = podcastHasAudio
      ? `[0:a]atrim=duration=${minDur.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo,volume=1.0[ap]`
      : `aevalsrc=0:channel_layout=stereo:sample_rate=44100:duration=${minDur.toFixed(3)}[ap]`;
    const aU = ugcHasAudio
      ? `[1:a]atrim=duration=${minDur.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo,volume=0.25[au]`
      : `aevalsrc=0:channel_layout=stereo:sample_rate=44100:duration=${minDur.toFixed(3)}[au]`;
    const aMix = `[ap][au]amix=inputs=2:duration=shortest:normalize=0[outa]`;

    const phase1Filters = [...phase1VideoFilters, aP, aU, aMix];

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(podcastPath)
        .input(ugcPath)
        .complexFilter(phase1Filters)
        .outputOptions([
          '-map', '[outv]', '-map', '[outa]',
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
          '-c:a', 'aac', '-b:a', '128k',
          '-movflags', '+faststart',
        ])
        .output(tmpPhase1)
        .on('start', cmd => console.log('[SplitScreen] phase1 cmd:', cmd))
        .on('end', () => { console.log('[SplitScreen] ✅ Phase 1 done'); resolve(); })
        .on('error', (err, _, stderr) => reject(new Error(`SplitScreen phase1 failed: ${err.message}\n${stderr?.slice(-500)}`)))
        .run();
    });

    if (equalDurs) {
      // No phase 2 needed — copy/rename phase1 to composedPath
      copyFileSync(tmpPhase1, composedPath);
    } else {
      // ── Phase 2: full-screen remainder of longer video ──────────────────
      const longerPath = longerIs === 'podcast' ? podcastPath : ugcPath;
      const longerHasAudio = longerIs === 'podcast' ? podcastHasAudio : ugcHasAudio;
      const remainDur = maxDur - minDur;
      console.log(`[SplitScreen] Phase 2: ${longerIs} full screen for ${remainDur.toFixed(2)}s`);

      const p2VideoFilter = `[0:v]trim=start=${minDur.toFixed(3)},setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p[outv]`;
      const p2AudioFilter = longerHasAudio
        ? `[0:a]atrim=start=${minDur.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[outa]`
        : `aevalsrc=0:channel_layout=stereo:sample_rate=44100:duration=${remainDur.toFixed(3)}[outa]`;

      const p2Filters = longerHasAudio
        ? [p2VideoFilter, p2AudioFilter]
        : [p2VideoFilter, p2AudioFilter];

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(longerPath)
          .complexFilter(p2Filters)
          .outputOptions([
            '-map', '[outv]', '-map', '[outa]',
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart',
          ])
          .output(tmpPhase2)
          .on('end', () => { console.log('[SplitScreen] ✅ Phase 2 done'); resolve(); })
          .on('error', (err, _, stderr) => reject(new Error(`SplitScreen phase2 failed: ${err.message}\n${stderr?.slice(-500)}`)))
          .run();
      });

      // ── Concat phase 1 + phase 2 ─────────────────────────────────────────
      console.log('[SplitScreen] Concatenating phases…');
      await concatMultipleVideos([tmpPhase1, tmpPhase2], composedPath, { width: 1080, height: 1920 });
      console.log('[SplitScreen] ✅ Concat done');
    }

    // ── Mix music if provided ─────────────────────────────────────────────
    if (musicPath) {
      console.log('[SplitScreen] Mixing music…');
      await mixMusicIntoVideo(composedPath, musicPath, outputPath, musicVolume);
      console.log('[SplitScreen] ✅ Music mixed');
    }

    console.log(`[SplitScreen] ✅ Complete → ${outputPath}`);
    return outputPath;
  } finally {
    for (const f of tmpFiles) {
      try { if (f && existsSync(f)) unlinkSync(f); } catch {}
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

/**
 * Change the playback speed of an audio file using FFmpeg atempo filter.
 * speed: 0.5–2.0 (chain filters for values outside that range)
 */
export async function changeAudioSpeed(inputPath, outputPath, speed) {
  return new Promise((resolve, reject) => {
    // atempo only supports 0.5–2.0; chain filters for values outside that range
    let filters;
    if (speed <= 2.0 && speed >= 0.5) {
      filters = `atempo=${speed}`;
    } else if (speed > 2.0) {
      // e.g. 2.5x → atempo=2.0,atempo=1.25
      const stages = [];
      let rem = speed;
      while (rem > 2.0) { stages.push('atempo=2.0'); rem /= 2.0; }
      stages.push(`atempo=${rem.toFixed(4)}`);
      filters = stages.join(',');
    } else {
      // speed < 0.5
      const stages = [];
      let rem = speed;
      while (rem < 0.5) { stages.push('atempo=0.5'); rem /= 0.5; }
      stages.push(`atempo=${rem.toFixed(4)}`);
      filters = stages.join(',');
    }

    const args = ['-y', '-i', inputPath, '-filter:a', filters, '-vn', outputPath];
    console.log(`[FFmpeg] changeAudioSpeed: ${speed}x → ${outputPath}`);
    execFile(ffmpegPath, args, { maxBuffer: 10 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(`Speed change failed: ${err.message}\n${stderr?.slice(-300)}`));
      resolve(outputPath);
    });
  });
}

export async function concatVideos(video1Path, video2Path, outputPath, { width = 1080, height = 1920 } = {}) {
  // Two-pass approach to avoid FFmpeg "Reconfiguring filter graph" colorspace mismatch:
  // 1. Normalize each video to an identical temp file (same res, fps, codec, colorspace, pix_fmt)
  // 2. Concat the normalized files using the concat demuxer (file-level, no filter graph)

  const [audio1, audio2, dur1, dur2] = await Promise.all([
    hasAudioStream(video1Path), hasAudioStream(video2Path),
    getVideoDuration(video1Path), getVideoDuration(video2Path),
  ]);

  const tmp1 = join(tmpdir(), `norm1_${randomUUID()}.mp4`);
  const tmp2 = join(tmpdir(), `norm2_${randomUUID()}.mp4`);
  const concatList = join(tmpdir(), `concat_${randomUUID()}.txt`);

  // Helper: normalize a single video to standard params using raw execFile for full control
  function normalizeClip(inputPath, tmpPath, hasAudio, dur) {
    return new Promise((resolve, reject) => {
      const vFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p`;
      const aFilter = hasAudio
        ? `[0:a]aformat=sample_rates=44100:channel_layouts=stereo[outa]`
        : `aevalsrc=0:channel_layout=stereo:sample_rate=44100:duration=${(dur||5).toFixed(3)}[outa]`;

      const filterGraph = `[0:v]${vFilter}[outv];${aFilter}`;

      const args = [
        '-y',
        '-i', inputPath,
        '-filter_complex', filterGraph,
        '-map', '[outv]', '-map', '[outa]',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
        '-movflags', '+faststart',
        tmpPath,
      ];

      console.log(`[FFmpeg normalize] ${inputPath} → ${tmpPath}`);
      execFile(ffmpegPath, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`Normalize failed: ${err.message}\n${stderr?.slice(-400)}`));
        resolve(tmpPath);
      });
    });
  }

  try {
    // Pass 1: normalize both clips in parallel
    await Promise.all([
      normalizeClip(video1Path, tmp1, audio1, dur1),
      normalizeClip(video2Path, tmp2, audio2, dur2),
    ]);

    // Pass 2: concat using demuxer (file-level, no filter graph reconfiguration)
    const { writeFileSync } = await import('fs');
    writeFileSync(concatList, `file '${tmp1.replace(/\\/g, '/')}'\nfile '${tmp2.replace(/\\/g, '/')}'`);

    await new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-f', 'concat', '-safe', '0', '-i', concatList,
        '-c', 'copy',
        '-movflags', '+faststart',
        outputPath,
      ];
      execFile(ffmpegPath, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`Concat demuxer failed: ${err.message}\n${stderr?.slice(-400)}`));
        resolve(outputPath);
      });
    });

    return outputPath;
  } finally {
    try { unlinkSync(tmp1); } catch {}
    try { unlinkSync(tmp2); } catch {}
    try { unlinkSync(concatList); } catch {}
  }
}
