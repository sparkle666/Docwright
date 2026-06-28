import path from 'path';
import fs from 'fs';
import { updateProject, getTranscript, logUsage } from '../db/repository.js';
import {
  getAudioDuration, convertToStandardWav, generateSilence, speedUpAudio,
  concatAudioFiles, muxAudioIntoVideo,
} from '../services/ffmpegService.js';
import { synthesizeSegmentAudio, DEFAULT_VOICE, DEFAULT_MODEL } from '../services/ttsService.js';

const STORAGE_ROOT = path.join(process.cwd(), 'storage');

// How much we're willing to speed up a single TTS clip (pitch-preserved)
// to make it fit its slot before giving up and accepting timeline drift
// instead. Above this, a sped-up voice starts sounding unnatural.
const MAX_SPEEDUP_FACTOR = 1.6;
// Don't bother stretching a clip that's only marginally over its slot.
const OVERFLOW_TOLERANCE = 1.05;
// Don't insert a silence gap shorter than this — not audible, not worth a file.
const MIN_GAP_SECONDS = 0.03;

/**
 * Generates a full AI voice-over for a project and replaces its video's
 * audio track IN PLACE (the working video_path is overwritten with the
 * muxed result). A one-time backup of the pre-AI-voice video is kept at
 * original_video_backup_path so restoreOriginalVideo() can undo this.
 *
 * Reuses the project's existing transcript — no re-upload or re-transcription
 * needed. Designed to be run via the job queue, same pattern as
 * processProject() / regenerateDoc() in pipeline.js.
 *
 * Approach (see ffmpegService.js for the primitives):
 *   1. Synthesize each transcript segment's text into its own speech clip.
 *   2. Walk segments in order, tracking a "cursor" position in the new
 *      timeline. Before each clip, insert silence to cover any gap between
 *      the cursor and the segment's original start time. If a clip runs
 *      longer than its original slot, speed it up (pitch-preserved, capped)
 *      rather than overlapping the next segment's speech.
 *   3. Concatenate everything into one track, pad to the full video length.
 *   4. Mux that track over the original video's picture (video stream
 *      untouched) and overwrite the project's video file.
 */
export async function generateAiVoice(projectId, project, options = {}) {
  const { voice = DEFAULT_VOICE, model = DEFAULT_MODEL } = options;
  const workDir = path.join(STORAGE_ROOT, 'voice_tmp', projectId);

  try {
    updateProject(projectId, {
      voice_status: 'generating', voice_error: null, voice_name: voice, voice_model: model,
    });

    const transcript = getTranscript(projectId);
    if (!transcript) {
      throw new Error('No transcript available — run the documentation pipeline first.');
    }
    const segments = (transcript.raw_json.segments || []).filter((s) => (s.text || '').trim());
    if (segments.length === 0) {
      throw new Error('Transcript has no spoken segments to synthesize.');
    }

    fs.mkdirSync(workDir, { recursive: true });

    // 1. Synthesize + normalize each segment, measuring real clip duration.
    const parts = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const text = seg.text.trim();

      const { buffer, usage } = await synthesizeSegmentAudio({ text, voice, model });
      const rawPath = path.join(workDir, `seg_${i}_raw.wav`);
      fs.writeFileSync(rawPath, buffer);

      const normPath = path.join(workDir, `seg_${i}_norm.wav`);
      await convertToStandardWav(rawPath, normPath);
      const duration = await getAudioDuration(normPath);

      parts.push({ index: i, start: seg.start, end: seg.end, filePath: normPath, duration });

      logUsage(projectId, {
        service: 'tts',
        model,
        inputTokens: usage?.prompt_tokens ?? Math.ceil(text.split(/\s+/).length * 1.3),
        outputTokens: usage?.completion_tokens_details?.audio_tokens
          ?? usage?.completion_tokens
          ?? Math.ceil(duration * 20),
      });
    }

    updateProject(projectId, { voice_status: 'stitching' });

    // 2. Walk segments in timeline order, inserting silence gaps and
    //    speeding up overlong clips so the result tracks the original
    //    pacing as closely as possible without distorting the voice.
    const sequence = [];
    let cursor = 0;

    for (const part of parts) {
      const gap = part.start - cursor;
      if (gap > MIN_GAP_SECONDS) {
        const silPath = path.join(workDir, `sil_${part.index}.wav`);
        await generateSilence(gap, silPath);
        sequence.push(silPath);
        cursor += gap;
      }

      const slotDuration = Math.max(part.end - part.start, 0.05);
      let clipPath = part.filePath;
      let clipDuration = part.duration;

      if (clipDuration > slotDuration * OVERFLOW_TOLERANCE) {
        const neededFactor = Math.min(clipDuration / slotDuration, MAX_SPEEDUP_FACTOR);
        if (neededFactor > 1.02) {
          const fastPath = path.join(workDir, `seg_${part.index}_fast.wav`);
          await speedUpAudio(clipPath, fastPath, neededFactor);
          clipPath = fastPath;
          clipDuration = await getAudioDuration(fastPath);
        }
        // If still over (factor was capped), we accept the drift — the
        // next segment's gap calculation will simply come out as 0 instead
        // of negative, and the timeline self-corrects from there.
      }

      sequence.push(clipPath);
      cursor += clipDuration;
    }

    // 3. Pad the tail so the track matches the full video length.
    const videoDuration = project.duration_seconds || cursor;
    if (videoDuration > cursor + MIN_GAP_SECONDS) {
      const tailPath = path.join(workDir, 'sil_tail.wav');
      await generateSilence(videoDuration - cursor, tailPath);
      sequence.push(tailPath);
    }

    const stitchedAudioPath = path.join(workDir, 'stitched.wav');
    await concatAudioFiles(sequence, stitchedAudioPath);

    // 4. Back up the original video on the FIRST voice generation only, so
    //    re-running with a different voice always starts from the untouched
    //    source rather than compounding onto a previous AI-voice render.
    updateProject(projectId, { voice_status: 'muxing' });
    let backupPath = project.original_video_backup_path;
    if (!backupPath || !fs.existsSync(backupPath)) {
      const ext = path.extname(project.video_path) || '.mp4';
      backupPath = path.join(STORAGE_ROOT, 'originals', `${projectId}${ext}`);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.copyFileSync(project.video_path, backupPath);
    }

    // 5. Mux onto the backed-up original picture (not the current working
    //    file) so the source video is always clean.
    const muxedPath = path.join(workDir, `final${path.extname(project.video_path) || '.mp4'}`);
    await muxAudioIntoVideo(backupPath, stitchedAudioPath, muxedPath);

    // 6. Replace the project's video in place.
    fs.copyFileSync(muxedPath, project.video_path);

    updateProject(projectId, {
      voice_status: 'complete',
      original_video_backup_path: backupPath,
      voice_generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`AI voice generation failed for project ${projectId}:`, err);
    updateProject(projectId, { voice_status: 'failed', voice_error: err.message });
    throw err;
  } finally {
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Restores the project's video to its pre-AI-voice state from the backup
 * taken before the first voice generation. Available any time after at
 * least one successful generateAiVoice() run.
 */
export async function restoreOriginalVideo(projectId, project) {
  if (!project.original_video_backup_path || !fs.existsSync(project.original_video_backup_path)) {
    throw new Error('No original video backup available to restore.');
  }
  fs.copyFileSync(project.original_video_backup_path, project.video_path);
  updateProject(projectId, {
    voice_status: null, voice_error: null, voice_name: null, voice_model: null, voice_generated_at: null,
  });
}
