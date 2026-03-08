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
