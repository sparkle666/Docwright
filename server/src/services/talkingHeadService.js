import path from 'path';
import fs from 'fs';
import { getAudioDuration, getVideoDuration } from './ffmpegService.js';
import { spawn } from 'child_process';

// Path to the bundled mock talking-head video (root of server package)
const MOCK_TALKING_HEAD_PATH = path.join(process.cwd(), 'talking-head.mp4');

const FFMPEG_TIMEOUT_MS =
  (parseInt(process.env.FFMPEG_TIMEOUT_SECONDS || '600', 10)) * 1000;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = '';
    const timer = FFMPEG_TIMEOUT_MS > 0
      ? setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`${cmd} timed out`)); }, FFMPEG_TIMEOUT_MS)
      : null;
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(`${cmd} exited ${code}\n${stderr}`));
    });
  });
}

/**
 * MOCK implementation — loops/trims talking-head.mp4 to exactly match
 * `targetDurationSeconds`, producing a self-contained video whose audio
 * track is the *original* TTS audio passed in as `audioPath`.
 *
 * The video portion is looped from the bundled talking-head.mp4 sample
 * (silent loop) and the real TTS audio is muxed in, so there is only one
 * audio track. When you integrate a real talking-head API later, replace
 * this function with one that calls the API with `audioPath` + a portrait
 * image and returns the API's video file at `outputPath`.
 *
 * @param {object} opts
 * @param {string} opts.audioPath      - Path to the TTS WAV that will be the audio track
 * @param {number} opts.targetDuration - Seconds the output video must run for
 * @param {string} opts.outputPath     - Where to write the resulting MP4
 */
export async function generateTalkingHeadVideo({ audioPath, targetDuration, outputPath }) {
  if (!fs.existsSync(MOCK_TALKING_HEAD_PATH)) {
    throw new Error(
      'Mock talking-head video not found at server/talking-head.mp4. ' +
      'Place the sample file there or integrate a real talking-head API.',
    );
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const mockDuration = await getVideoDuration(MOCK_TALKING_HEAD_PATH);

  // How many times we need to loop the clip to cover targetDuration
  const loopCount = Math.ceil(targetDuration / mockDuration);

  // Step 1: loop the video-only stream to a temp file, trimmed to exact duration
  const loopedVideoPath = `${outputPath}.looped.mp4`;

  await run('ffmpeg', [
    '-y',
    '-stream_loop', String(loopCount),
    '-i', MOCK_TALKING_HEAD_PATH,
    '-t', String(targetDuration),
    '-an',                       // strip audio — the TTS track goes in next step
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', // ensure even dimensions
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    loopedVideoPath,
  ]);

  // Step 2: mux the real TTS audio over the looped video
  await run('ffmpeg', [
    '-y',
    '-i', loopedVideoPath,
    '-i', audioPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-shortest',
    outputPath,
  ]);

  // Clean up temp
  if (fs.existsSync(loopedVideoPath)) fs.rmSync(loopedVideoPath, { force: true });

  return outputPath;
}
