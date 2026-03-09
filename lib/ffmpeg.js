import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';

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
  const duration = await getVideoDuration(videoPath);
  const seekTo = Math.max(0, duration - 0.05);
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .seekInput(seekTo)
      .outputOptions(['-vframes', '1', '-q:v', '2'])
      .output(outputJpg)
      .on('end', () => resolve(outputJpg))
      .on('error', reject)
      .run();
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
 * @param {string[]} videoPaths — array of video file paths (at least 2)
 * @param {string}   outputPath
 * @param {object}   opts — { width: 3072, height: 5504 } output resolution
 */
export async function concatMultipleVideos(videoPaths, outputPath, { width = 3072, height = 5504 } = {}) {
  if (!videoPaths || videoPaths.length === 0) throw new Error('No videos to concat');
  if (videoPaths.length === 1) {
    // Just copy the single file
    const { copyFileSync } = await import('fs');
    copyFileSync(videoPaths[0], outputPath);
    return outputPath;
  }

  // Detect audio streams for all inputs
  const audioFlags = await Promise.all(videoPaths.map(vp => hasAudioStream(vp)));

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

    // Scale + normalize each video
    for (let i = 0; i < videoPaths.length; i++) {
      filters.push(
        `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v${i}]`
      );
      if (audioFlags[i]) {
        filters.push(`[${i}:a]aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`);
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
