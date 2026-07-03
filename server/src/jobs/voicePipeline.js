import path from 'path';
import fs from 'fs';
import { updateProject, listSteps, getDocMeta, logUsage } from '../db/repository.js';
import {
  getAudioDuration, convertToStandardWav, generateSilence, speedUpAudio,
  concatAudioFiles, muxAudioIntoVideo,
} from '../services/ffmpegService.js';
import { synthesizeSegmentAudio, stripMarkdownForTTS, DEFAULT_VOICE, DEFAULT_MODEL } from '../services/ttsService.js';
import { getDocTypePreset } from '../services/docTypePresets.js';

const STORAGE_ROOT = path.join(process.cwd(), 'storage');

// How much we're willing to speed up a single TTS clip (pitch-preserved)
// to make it fit its slot before giving up and accepting timeline drift
// instead. Above this, a sped-up voice starts sounding unnatural.
const MAX_SPEEDUP_FACTOR = 1.6;
// Don't bother stretching a clip that's only marginally over its slot.
const OVERFLOW_TOLERANCE = 1.05;
// Don't insert a silence gap shorter than this — not audible, not worth a file.
const MIN_GAP_SECONDS = 0.03;
// How many seconds to delay the narration after a step's timestamp.
// Whisper timestamps reflect when the *speaker's voice* began, but the
// screen action often appears slightly later (especially when clicking links
// with network lag). This offset lets the visual catch up before the AI
// voice starts describing it. Tune this value if audio still leads the screen.
const NARRATION_START_OFFSET = 2.0;
// A short breath before the closing line, so the outro doesn't slam
// into the end of the last step's narration.
const OUTRO_LEAD_PAUSE_SECONDS = 0.6;

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
 *   1. Load the project's generated doc steps (title + body_markdown), strip
 *      markdown formatting so TTS reads clean prose, then synthesize each
 *      step into its own speech clip. Steps carry start_seconds/end_seconds
 *      timestamps derived from the transcript, so the narration lands at the
 *      right moment in the video — exactly like a walkthrough voice-over.
 *   2. Walk steps in chronological order, tracking a "cursor" position in
 *      the new timeline. Before each clip insert silence to cover any gap
 *      from the cursor to the step's start_seconds. If a clip overruns its
 *      slot, speed it up (pitch-preserved, capped) rather than overlapping
 *      the next step's narration.
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

    // Load the AI-generated documentation steps for this project.
    // Each step has: title, body_markdown, start_seconds, end_seconds.
    const rawSteps = listSteps(projectId);
    const steps = rawSteps.filter((s) => {
      const hasTime = typeof s.start_seconds === 'number' && typeof s.end_seconds === 'number';
      const hasText = (s.title || '').trim() || (s.body_markdown || '').trim();
      return hasTime && hasText;
    });

    if (steps.length === 0) {
      throw new Error(
        'No documentation steps with timestamps found — generate the documentation first.',
      );
    }

    // Whether this project's doc-type preset wants continuous, natural
    // narration (e.g. the walkthrough-voiceover presets) rather than a
    // read-aloud numbered list. Presets opt into this via `flowing: true`
    // in docTypePresets.js.
    const preset = getDocTypePreset(project.doc_type);
    const flowing = Boolean(preset.flowing);

    // Build the narration text for each step, with all markdown stripped
    // so the TTS never reads out asterisks or backticks.
    //
    // For "flowing" presets we deliberately do NOT prepend "Step N. Title." —
    // that prefix was being stitched on unconditionally for every doc type,
    // which is why walkthrough-voiceover output still sounded like a
    // numbered checklist even though its system prompt asks for continuous
    // prose. Flowing narration speaks the generated body text as-is.
    function buildStepNarration(step, index) {
      const titleText = stripMarkdownForTTS(step.title || '').trim();
      const bodyText = stripMarkdownForTTS(step.body_markdown || '').trim();

      if (flowing) {
        return bodyText || titleText;
      }

      const parts = [];
      if (titleText) parts.push(`Step ${index + 1}. ${titleText}.`);
      if (bodyText) parts.push(bodyText);
      return parts.join(' ');
    }

    fs.mkdirSync(workDir, { recursive: true });

    // 0. Optional spoken intro/outro for "flowing" (walkthrough voiceover)
    //    doc types. Without these the narration used to launch straight
    //    into the first click with zero framing. Both lines are generated
    //    alongside the rest of the doc by generateStructuredDoc() and
    //    stored in doc_meta — here we just synthesize + measure them.
    let introClip = null;
    let outroClip = null;
    if (flowing) {
      const docMeta = getDocMeta(projectId);
      const introText = stripMarkdownForTTS(docMeta?.intro_narration || '').trim();
      const outroText = stripMarkdownForTTS(docMeta?.outro_narration || '').trim();

      if (introText) {
        const { buffer, usage } = await synthesizeSegmentAudio({ text: introText, voice, model });
        const rawPath = path.join(workDir, 'intro_raw.wav');
        fs.writeFileSync(rawPath, buffer);
        const normPath = path.join(workDir, 'intro_norm.wav');
        await convertToStandardWav(rawPath, normPath);
        const duration = await getAudioDuration(normPath);
        introClip = { filePath: normPath, duration };
        logUsage(projectId, {
          service: 'tts',
          model,
          inputTokens: usage?.prompt_tokens ?? Math.ceil(introText.split(/\s+/).length * 1.3),
          outputTokens: Math.ceil(duration * 20),
        });
      }

      if (outroText) {
        const { buffer, usage } = await synthesizeSegmentAudio({ text: outroText, voice, model });
        const rawPath = path.join(workDir, 'outro_raw.wav');
        fs.writeFileSync(rawPath, buffer);
        const normPath = path.join(workDir, 'outro_norm.wav');
        await convertToStandardWav(rawPath, normPath);
        const duration = await getAudioDuration(normPath);
        outroClip = { filePath: normPath, duration };
        logUsage(projectId, {
          service: 'tts',
          model,
          inputTokens: usage?.prompt_tokens ?? Math.ceil(outroText.split(/\s+/).length * 1.3),
          outputTokens: Math.ceil(duration * 20),
        });
      }
    }

    // 1. Synthesize + normalize each step's narration, measuring real clip duration.
    const parts = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const text = buildStepNarration(step, i);
      if (!text) continue; // skip if stripping left nothing

      const { buffer, usage } = await synthesizeSegmentAudio({ text, voice, model });
      const rawPath = path.join(workDir, `step_${i}_raw.wav`);
      fs.writeFileSync(rawPath, buffer);

      const normPath = path.join(workDir, `step_${i}_norm.wav`);
      await convertToStandardWav(rawPath, normPath);
      const duration = await getAudioDuration(normPath);

      parts.push({
        index: i,
        start: step.start_seconds,
        end: step.end_seconds,
        filePath: normPath,
        duration,
      });

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

    // 2. Walk segments in timeline order, inserting silence gaps to land
    //    each clip at its step's timestamp. No slot-fitting/speedup is
    //    applied — clips play at natural TTS pacing and any overrun just
    //    shows up as a smaller (or zero) gap before the next clip.
    const sequence = [];
    let cursor = 0;

    // Intro plays at the very start of the timeline, before any of the
    // step-timestamp gap logic kicks in. If it happens to run longer than
    // the first step's target start, we simply accept that drift (same
    // philosophy as the overflow handling below) rather than truncating it.
    if (introClip) {
      sequence.push(introClip.filePath);
      cursor += introClip.duration;
    }

    for (const part of parts) {
      const targetStart = Math.max(0, part.start + NARRATION_START_OFFSET);
      const gap = targetStart - cursor;

      if (gap > MIN_GAP_SECONDS) {
        const silPath = path.join(workDir, `sil_${part.index}.wav`);
        await generateSilence(gap, silPath);
        sequence.push(silPath);
        cursor += gap;
      }

      // Just play the clip at natural speed — no slot enforcement, no speedup
      sequence.push(part.filePath);
      cursor += part.duration;
    }

    // Outro plays right after the last step, with a brief breath before it
    // so it doesn't slam into the end of the final line.
    if (outroClip) {
      const silPath = path.join(workDir, 'sil_outro.wav');
      await generateSilence(OUTRO_LEAD_PAUSE_SECONDS, silPath);
      sequence.push(silPath);
      cursor += OUTRO_LEAD_PAUSE_SECONDS;

      sequence.push(outroClip.filePath);
      cursor += outroClip.duration;
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