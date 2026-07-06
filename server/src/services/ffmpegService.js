import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const FFMPEG_TIMEOUT_MS =
  (parseInt(process.env.FFMPEG_TIMEOUT_SECONDS || '600', 10)) * 1000;

/**
 * Spawn a subprocess and resolve with its stderr output (many ffmpeg tools
 * write useful info there). Rejects on non-zero exit or optional timeout.
 */
function run(cmd, args, { timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = '';
    let timer = null;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`${cmd} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
    }

    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(`${cmd} exited with code ${code}\n${stderr}`));
    });
  });
}

/**
 * Verify ffmpeg is available and return its version string.
 * Used by the health-check endpoint.
 */
export async function checkFfmpegAvailable() {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-version']);
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.split('\n')[0].trim());
      else reject(new Error('ffmpeg -version failed'));
    });
  });
}

/**
 * Extract mono 16 kHz WAV audio from a video file (Whisper-friendly format).
 */
export async function extractAudio(videoPath, outputAudioPath) {
  fs.mkdirSync(path.dirname(outputAudioPath), { recursive: true });
  await run('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ar', '16000',
    '-ac', '1',
    outputAudioPath,
  ]);
  return outputAudioPath;
}

/**
 * Probe video duration in seconds using ffprobe.
 */
export async function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ]);
    let stdout = '';
    let stderr = '';
    let timer = null;

    if (FFMPEG_TIMEOUT_MS > 0) {
      timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`ffprobe timed out after ${FFMPEG_TIMEOUT_MS / 1000}s`));
      }, FFMPEG_TIMEOUT_MS);
    }

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(parseFloat(stdout.trim()));
      else reject(new Error(`ffprobe failed: ${stderr}`));
    });
  });
}

/**
 * Detect scene-change candidate frames using ffmpeg's `select` scene filter,
 * and extract them as JPEGs with their timestamps via the showinfo filter.
 *
 * Returns an array of { timestampSeconds, filePath, changeScore }.
 */
export async function extractSceneChangeFrames(videoPath, outputDir, threshold = 0.12) {
  fs.mkdirSync(outputDir, { recursive: true });
  const pattern = path.join(outputDir, 'scene_%05d.jpg');
  // format=yuvj420p forces full-range JPEG color sampling so the mjpeg
  // encoder doesn't choke on tv-range/bt709 input (ffmpeg exit code -22).
  const filter = `select='gt(scene,${threshold})',format=yuvj420p,showinfo`;

  const stderr = await run('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-vf', filter,
    '-fps_mode', 'vfr',
    '-q:v', '2',
    pattern,
  ]);

  // Parse showinfo lines for pts_time (timestamp) in the same order frames were written
  const timestamps = [];
  for (const line of stderr.split('\n')) {
    if (line.includes('Parsed_showinfo')) {
      const match = line.match(/pts_time:([\d.]+)/);
      if (match) timestamps.push(parseFloat(match[1]));
    }
  }

  const files = fs.readdirSync(outputDir)
    .filter((f) => f.startsWith('scene_') && f.endsWith('.jpg'))
    .sort();

  return files
    .map((file, idx) => ({
      timestampSeconds: timestamps[idx] ?? null,
      filePath: path.join(outputDir, file),
      changeScore: null,
    }))
    .filter((f) => f.timestampSeconds !== null);
}

/**
 * Extract one frame every N seconds across the whole video (a "safety net"
 * sampling pass to complement scene-change detection). Scene-change detection
 * alone tends to fire mid-transition (cursor mid-click, partially rendered
 * UI, fade in/out) — sampling at a fixed cadence gives us extra candidates
 * that land mid-action instead, which the sharpness filter and Vision model
 * can then choose between.
 *
 * Returns an array of { timestampSeconds, filePath, changeScore: null }.
 */
export async function extractIntervalFrames(videoPath, outputDir, intervalSeconds = 3) {
  fs.mkdirSync(outputDir, { recursive: true });
  const pattern = path.join(outputDir, 'interval_%05d.jpg');
  const fps = `fps=1/${intervalSeconds}`;
  const filter = `${fps},format=yuvj420p,showinfo`;

  const stderr = await run('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-vf', filter,
    '-fps_mode', 'vfr',
    '-q:v', '2',
    pattern,
  ]);

  const timestamps = [];
  for (const line of stderr.split('\n')) {
    if (line.includes('Parsed_showinfo')) {
      const match = line.match(/pts_time:([\d.]+)/);
      if (match) timestamps.push(parseFloat(match[1]));
    }
  }

  const files = fs.readdirSync(outputDir)
    .filter((f) => f.startsWith('interval_') && f.endsWith('.jpg'))
    .sort();

  return files
    .map((file, idx) => ({
      timestampSeconds: timestamps[idx] ?? null,
      filePath: path.join(outputDir, file),
      changeScore: null,
    }))
    .filter((f) => f.timestampSeconds !== null);
}

/**
 * Extract a single frame at an exact timestamp (used for manual/added screenshots,
 * or as a fallback when no scene-change candidate exists near a step).
 */
export async function extractFrameAtTimestamp(videoPath, timestampSeconds, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await run('ffmpeg', [
    '-y',
    '-ss', String(timestampSeconds),
    '-i', videoPath,
    '-frames:v', '1',
    '-vf', 'format=yuvj420p',
    '-q:v', '2',
    outputPath,
  ]);
  return outputPath;
}

// ─── AI voice-over helpers ─────────────────────────────────────────────────
// These build a single replacement audio track from per-segment TTS clips
// and mux it over the original video. Kept separate from the doc-generation
// helpers above since they're used by the voice pipeline, not processProject().

/**
 * Probe a media file's duration in seconds. Works for audio or video — same
 * underlying ffprobe call as getVideoDuration(), exported under a clearer
 * name for use on standalone audio clips.
 */
export const getAudioDuration = getVideoDuration;

/**
 * Re-encode any input audio to a consistent PCM WAV format (44.1kHz, stereo,
 * 16-bit). All TTS clips and generated silence are normalized to this same
 * format so they can be concatenated with a fast stream copy later.
 */
export async function convertToStandardWav(inputPath, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await run('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-ar', '44100',
    '-ac', '2',
    '-acodec', 'pcm_s16le',
    outputPath,
  ]);
  return outputPath;
}

/**
 * Generates a silent WAV clip of an exact duration, in the same standard
 * format used by convertToStandardWav(), so it can be concatenated alongside
 * real speech clips without a format mismatch.
 */
export async function generateSilence(durationSeconds, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const duration = Math.max(durationSeconds, 0.01);
  await run('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-t', String(duration),
    '-acodec', 'pcm_s16le',
    outputPath,
  ]);
  return outputPath;
}

/**
 * Speeds up an audio clip by `factor` (>1 = shorter) using ffmpeg's atempo
 * filter, which preserves pitch (unlike just changing playback rate). atempo
 * only accepts 0.5–2.0 per instance, so factors outside that range are split
 * across multiple chained instances.
 */
export async function speedUpAudio(inputPath, outputPath, factor) {
  if (factor <= 1.001) {
    fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }
  const stages = [];
  let remaining = factor;
  while (remaining > 2.0) {
    stages.push(2.0);
    remaining /= 2.0;
  }
  stages.push(remaining);
  const filter = stages.map((f) => `atempo=${f.toFixed(4)}`).join(',');

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await run('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-filter:a', filter,
    '-acodec', 'pcm_s16le',
    outputPath,
  ]);
  return outputPath;
}

/**
 * Concatenates a sequence of same-format WAV files (in the given order)
 * into one output file using ffmpeg's concat demuxer with a fast stream
 * copy. All inputs must already share the same codec/sample-rate/channels
 * (see convertToStandardWav / generateSilence).
 */
export async function concatAudioFiles(filePathsInOrder, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const listPath = `${outputPath}.concat_list.txt`;
  const listContent = filePathsInOrder
    .map((p) => `file '${path.resolve(p).replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(listPath, listContent);

  try {
    await run('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      outputPath,
    ]);
  } finally {
    fs.rmSync(listPath, { force: true });
  }
  return outputPath;
}

/**
 * Extends a video's picture by freezing its last frame for `extraSeconds`,
 * using ffmpeg's `tpad` filter (stop_mode=clone) — a single-pass operation,
 * no manual frame extraction / re-concatenation needed.
 *
 * Used when a generated AI voice-over (in particular the outro line on
 * "flowing" walkthrough narration) runs longer than the source video: rather
 * than let muxAudioIntoVideo's `-shortest` flag truncate the narration, we
 * pad the picture out to match so the full voice-over always finishes before
 * the video ends.
 *
 * `tpad` forces a re-encode of the video stream (filters can't stream-copy),
 * so this is slower than a straight mux — it should only be called for the
 * (relatively rare) overrun case, not on every voice-over generation.
 */
export async function extendVideoWithFreezeFrame(inputPath, extraSeconds, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const ext = path.extname(outputPath).toLowerCase();
  const isWebm = ext === '.webm';

  const args = [
    '-y',
    '-i', inputPath,
    '-vf', `tpad=stop_mode=clone:stop_duration=${extraSeconds.toFixed(3)}`,
    '-an', // original audio is dropped anyway once muxed with the new track
    '-c:v', isWebm ? 'libvpx-vp9' : 'libx264',
  ];

  if (isWebm) {
    args.push('-b:v', '0', '-crf', '30');
  } else {
    args.push('-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p');
  }

  args.push(outputPath);
  await run('ffmpeg', args);
  return outputPath;
}

/**
 * Muxes a replacement audio track over a video's existing video stream,
 * dropping the original audio. Video is stream-copied (no re-encode, no
 * quality loss, fast); audio is encoded to a codec compatible with the
 * output container (AAC for mp4/mov/mkv, Opus for webm).
 */
export async function muxAudioIntoVideo(videoPath, audioPath, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const ext = path.extname(outputPath).toLowerCase();
  const audioCodec = ext === '.webm' ? 'libopus' : 'aac';

  await run('ffmpeg', [
    '-y',
    '-i', videoPath,
    '-i', audioPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', audioCodec,
    '-b:a', '192k',
    '-shortest',
    outputPath,
  ]);
  return outputPath;
}