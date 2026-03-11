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
 * Concatenate N videos into one, preserving resolution.
 * Audio is faded in/out (0.15s) at each clip boundary to eliminate pops/clicks.
 * @param {string[]} videoPaths — array of video file paths (at least 2)
 * @param {string}   outputPath
 * @param {object}   opts — { width, height } output resolution
 */
export async function concatMultipleVideos(videoPaths, outputPath, { width = 1080, height = 1920 } = {}) {
  if (!videoPaths || videoPaths.length === 0) throw new Error('No videos to concat');
  if (videoPaths.length === 1) {
    // Just copy the single file
    const { copyFileSync } = await import('fs');
    copyFileSync(videoPaths[0], outputPath);
    return outputPath;
  }

  // Get durations + audio flags for all inputs (in parallel)
  const [durations, audioFlags] = await Promise.all([
    Promise.all(videoPaths.map(vp => getVideoDuration(vp))),
    Promise.all(videoPaths.map(vp => hasAudioStream(vp))),
  ]);

  const FADE_DUR = 0.15; // audio fade duration at join points (seconds)

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();

    // Add each video as an input
    for (const vp of videoPaths) {
      cmd.input(vp);
    }

    // Null audio source (last input index = videoPaths.length)
    const nullIdx = videoPaths.length;
    cmd.input('anullsrc=r=44100:cl=stereo').inputOptions(['-f', 'lavfi']);

    const filters = [];

    // Scale + normalize each video, add audio fade in/out at boundaries
    for (let i = 0; i < videoPaths.length; i++) {
      filters.push(
        `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v${i}]`
      );

      if (audioFlags[i]) {
        const dur = durations[i] || 5;
        const fadeOutStart = Math.max(0, dur - FADE_DUR);
        // Fade in at start, fade out at end — eliminates audio pops at join points
        filters.push(
          `[${i}:a]afade=t=in:st=0:d=${FADE_DUR},afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${FADE_DUR},aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`
        );
      } else {
        filters.push(`[${nullIdx}:a]atrim=duration=0,asetpts=PTS-STARTPTS[a${i}]`);
      }
    }

    // Build concat filter
    const concatInputs = videoPaths.map((_, i) => `[v${i}][a${i}]`).join('');
    filters.push(`${concatInputs}concat=n=${videoPaths.length}:v=1:a=1[outv][outa]`);

    cmd
      .complexFilter(filters)
      .outputOptions([
        '-map', '[outv]', '-map', '[outa]',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
      ])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', reject)
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
  const [audio1, audio2] = await Promise.all([hasAudioStream(video1Path), hasAudioStream(video2Path)]);

  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(video1Path)
      .input(video2Path)
      .input('anullsrc=r=44100:cl=stereo').inputOptions(['-f', 'lavfi']);

    const filters = [
      '[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v0]',
      '[1:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v1]',
      audio1 ? '[0:a]aformat=sample_rates=44100:channel_layouts=stereo[a0]' : '[2:a]atrim=duration=0,asetpts=PTS-STARTPTS[a0]',
      audio2 ? '[1:a]aformat=sample_rates=44100:channel_layouts=stereo[a1]' : '[2:a]atrim=duration=0,asetpts=PTS-STARTPTS[a1]',
      '[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]',
    ];

    cmd
      .complexFilter(filters)
      .outputOptions(['-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .run();
  });
}
