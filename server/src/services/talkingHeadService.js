import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { getVideoDuration } from './ffmpegService.js';

// The single presenter photo, used two ways:
//  1. As the reference "image" input the avatar API animates for speech segments.
//  2. As the frozen frame shown during silence, so the presenter never
//     appears to keep talking/moving when there's no audio driving it.
const STILL_IMAGE_PATH = path.join(process.cwd(), 'talking-head-still-image.png');

const AVATAR_MODEL = 'prunaai/p-video-avatar';
const REPLICATE_API_BASE = 'https://api.replicate.com/v1';
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

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

// Fixed target dimensions per requested resolution, so every clip — speech
// and silence alike — is normalized to the same size/fps up front. This
// avoids any ordering dependency (e.g. a video that opens with a silent
// pause before the first speech segment) that probing an API clip's actual
// output resolution would introduce.
const RESOLUTION_DIMENSIONS = {
  '480p': { width: 854, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
};
const TRACK_FPS = 30;

function resolveMeta(resolution) {
  const dims = RESOLUTION_DIMENSIONS[resolution] || RESOLUTION_DIMENSIONS['720p'];
  return { ...dims, fps: TRACK_FPS };
}

function fileToDataUri(filePath, mimeType) {
  const buf = fs.readFileSync(filePath);
  return `data:${mimeType};base64,${buf.toString('base64')}`;
}

function mimeForAudio(filePath) {
  return filePath.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav';
}

/**
 * Calls the avatar API (Replicate, prunaai/p-video-avatar) with a single
 * segment's own audio as the drive signal and the presenter still image as
 * the face to animate. Returns the raw downloaded clip's local path.
 * Docs: https://replicate.com/prunaai/p-video-avatar
 *
 * @param {object} opts
 * @param {string}  opts.segmentAudioPath - WAV/MP3 for this speech segment
 * @param {string}  opts.outputPath       - Where to write the downloaded clip
 * @param {string}  [opts.resolution]     - '480p' | '720p' | '1080p'
 * @param {string}  [opts.chunksDir]      - If set, a copy of every raw clip
 *                                          returned by Replicate is saved here
 *                                          so you never lose a paid generation.
 * @param {number}  [opts.segmentIndex]   - Used in the persisted filename.
 */
async function callAvatarApi({ segmentAudioPath, outputPath, resolution = '720p', chunksDir, segmentIndex }) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    throw new Error('REPLICATE_API_TOKEN is not set on the server.');
  }

  const createRes = await fetch(`${REPLICATE_API_BASE}/models/${AVATAR_MODEL}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'wait',
    },
    body: JSON.stringify({
      input: {
        image: fileToDataUri(STILL_IMAGE_PATH, 'image/png'),
        audio: fileToDataUri(segmentAudioPath, mimeForAudio(segmentAudioPath)),
        resolution,
        video_prompt: 'The person is talking.',
      },
    }),
  });

  if (!createRes.ok) {
    throw new Error(`Avatar API request failed: ${createRes.status} ${await createRes.text()}`);
  }

  let prediction = await createRes.json();
  const startedAt = Date.now();

  while (prediction.status !== 'succeeded' && prediction.status !== 'failed' && prediction.status !== 'canceled') {
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      throw new Error('Avatar API timed out waiting for a result.');
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pollRes = await fetch(`${REPLICATE_API_BASE}/predictions/${prediction.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    prediction = await pollRes.json();
  }

  if (prediction.status !== 'succeeded') {
    throw new Error(`Avatar API generation failed: ${prediction.error || prediction.status}`);
  }

  const output = prediction.output;
  const videoUrl = typeof output === 'string' ? output : Array.isArray(output) ? output[0] : output?.video || output?.url;
  if (!videoUrl) {
    throw new Error('Avatar API returned no video URL.');
  }

  const videoRes = await fetch(videoUrl);
  if (!videoRes.ok) {
    throw new Error(`Failed to download avatar clip: ${videoRes.status}`);
  }
  const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
  fs.writeFileSync(outputPath, videoBuffer);

  // ── Persist a copy to chunksDir so every paid Replicate generation
  //    survives even if the final composite fails or the workDir is wiped.
  if (chunksDir) {
    try {
      fs.mkdirSync(chunksDir, { recursive: true });
      const idx = segmentIndex !== undefined ? String(segmentIndex).padStart(4, '0') : Date.now();
      const chunkName = `chunk_${idx}_${prediction.id}.mp4`;
      fs.writeFileSync(path.join(chunksDir, chunkName), videoBuffer);
    } catch (saveErr) {
      // Non-fatal — log but never let a save failure abort the pipeline.
      console.warn('[talkingHeadService] Could not persist chunk to chunksDir:', saveErr.message);
    }
  }

  return outputPath;
}

function findPersistedChunk(chunksDir, segmentIndex) {
  if (!chunksDir || segmentIndex === undefined || !fs.existsSync(chunksDir)) return null;
  const prefix = `chunk_${String(segmentIndex).padStart(4, '0')}_`;
  const match = fs.readdirSync(chunksDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.mp4'))
    .sort()
    .pop();
  return match ? path.join(chunksDir, match) : null;
}

/**
 * Forces a clip to an exact duration: trims if the API returned something
 * longer than the source audio, or freezes the last frame if it returned
 * something shorter. Also normalizes scale/fps/pix_fmt so every clip
 * (speech and silence alike) can later be concatenated with `-c copy`.
 */
async function normalizeToExactDuration(inputPath, targetSeconds, outputPath, meta) {
  const { width, height, fps } = meta;
  const scaleFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps}`;
  const actual = await getVideoDuration(inputPath);

  if (actual >= targetSeconds) {
    await run('ffmpeg', [
      '-y', '-i', inputPath,
      '-t', targetSeconds.toFixed(3),
      '-vf', scaleFilter,
      '-an',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      outputPath,
    ]);
  } else {
    const padSeconds = (targetSeconds - actual).toFixed(3);
    await run('ffmpeg', [
      '-y', '-i', inputPath,
      '-vf', `${scaleFilter},tpad=stop_mode=clone:stop_duration=${padSeconds}`,
      '-t', targetSeconds.toFixed(3),
      '-an',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      outputPath,
    ]);
  }
}

async function buildStillClip(durationSeconds, outputPath, meta) {
  const { width, height, fps } = meta;
  await run('ffmpeg', [
    '-y',
    '-loop', '1',
    '-i', STILL_IMAGE_PATH,
    '-t', durationSeconds.toFixed(3),
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps}`,
    '-an',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    outputPath,
  ]);
}

/**
 * Builds the full talking-head video for the whole narration timeline and
 * muxes the already-stitched narration audio onto it, so the output has
 * exactly the same contract as before: a single video file whose audio
 * track IS the narration — no separate audio mapping needed downstream.
 *
 * For each segment:
 *  - type 'speech'  -> real avatar API call driven by that segment's own
 *                      audio file, then trimmed/padded to its exact duration.
 *  - type 'silence' -> a frozen clip of the still image for that duration,
 *                      so the presenter doesn't appear to talk or move
 *                      when nothing is being said.
 *
 * All per-segment clips are silent; the ONLY audio in the final output is
 * the narration track passed in as `audioPath`. This is what avoids the
 * double-audio problem — the avatar API's own generated audio (which is
 * just an encode of the same audio we fed it) is discarded entirely, we
 * only keep the video/mouth-movement half of its output.
 *
 * @param {object} opts
 * @param {Array<{type: 'speech'|'silence', filePath: string, duration: number}>} opts.segments
 * @param {string} opts.audioPath      - Path to the full stitched narration WAV
 * @param {number} opts.targetDuration - Total seconds the output video must run for
 * @param {string} opts.outputPath     - Where to write the resulting MP4
 * @param {string} [opts.resolution]   - '480p' | '720p' | '1080p'
 * @param {string} [opts.chunksDir]    - Persistent directory to save every raw
 *                                       Replicate clip so no generation is lost.
 */
export async function generateTalkingHeadVideo({
  segments,
  audioPath,
  targetDuration,
  outputPath,
  resolution = '720p',
  chunksDir,
  beforeSegment,
  afterSegment,
}) {
  if (!fs.existsSync(STILL_IMAGE_PATH)) {
    throw new Error(
      `Presenter still image not found at ${STILL_IMAGE_PATH}. ` +
      'Place talking-head-still-image.png in the server root.',
    );
  }
  if (!segments || segments.length === 0) {
    throw new Error('generateTalkingHeadVideo requires at least one segment.');
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const workDir = `${outputPath}.parts`;
  fs.mkdirSync(workDir, { recursive: true });

  try {
    const meta = resolveMeta(resolution);
    const clipPaths = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const clipPath = path.join(workDir, `clip_${String(i).padStart(4, '0')}.mp4`);
      if (beforeSegment) {
        await beforeSegment(i, seg);
      }

      if (seg.type === 'speech') {
        const rawPath = path.join(workDir, `raw_${String(i).padStart(4, '0')}.mp4`);
        const persistedChunk = findPersistedChunk(chunksDir, i);
        if (persistedChunk) {
          fs.copyFileSync(persistedChunk, rawPath);
        } else {
          await callAvatarApi({
            segmentAudioPath: seg.filePath,
            outputPath: rawPath,
            resolution,
            chunksDir,
            segmentIndex: i,
          });
        }
        await normalizeToExactDuration(rawPath, seg.duration, clipPath, meta);
        fs.rmSync(rawPath, { force: true });
      } else {
        await buildStillClip(seg.duration, clipPath, meta);
      }
      clipPaths.push(clipPath);
      if (afterSegment) {
        await afterSegment(i, seg, clipPath);
      }
    }

    const listPath = path.join(workDir, 'concat_list.txt');
    fs.writeFileSync(
      listPath,
      clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'),
    );

    const silentTrackPath = path.join(workDir, 'silent_track.mp4');
    await run('ffmpeg', [
      '-y',
      '-f', 'concat', '-safe', '0',
      '-i', listPath,
      '-c', 'copy',
      silentTrackPath,
    ]);

    // Mux the full narration audio onto the assembled silent video — this
    // is the ONLY audio track in the output.
    await run('ffmpeg', [
      '-y',
      '-i', silentTrackPath,
      '-i', audioPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-t', targetDuration.toFixed(3),
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-shortest',
      outputPath,
    ]);

    return outputPath;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
