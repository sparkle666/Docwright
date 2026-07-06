import path from 'path';
import fs from 'fs';
import { updateProject, listSteps, getDocMeta, logUsage } from '../db/repository.js';
import {
  getAudioDuration, getVideoDuration, convertToStandardWav, generateSilence,
  concatAudioFiles, overlayTalkingHead, extendVideoWithFreezeFrame,
} from '../services/ffmpegService.js';
import { synthesizeSegmentAudio, stripMarkdownForTTS, DEFAULT_VOICE, DEFAULT_MODEL } from '../services/ttsService.js';
import { generateTalkingHeadVideo } from '../services/talkingHeadService.js';
import { getDocTypePreset } from '../services/docTypePresets.js';

const STORAGE_ROOT = path.join(process.cwd(), 'storage');

// Mirrors the timing constants from voicePipeline.js so narration lands
// at the same position as the voice-over feature — making it easy to
// compare the two side-by-side.
const NARRATION_START_OFFSET = 2.0;
const MIN_GAP_SECONDS = 0.03;
const OUTRO_LEAD_PAUSE_SECONDS = 0.6;
const END_OVERRUN_TOLERANCE_SECONDS = 0.15;
const END_OVERRUN_BUFFER_SECONDS = 0.1;

/**
 * Generates an AI voice-over, produces a talking-head video synced to that
 * audio via the avatar API (per speech segment, with the presenter still
 * image filling silent gaps), and overlays the talking-head bubble in the
 * bottom-right corner of the project video. The result is written over the
 * project's working video_path.
 *
 * Key difference from generateAiVoice(): the TTS audio is NOT muxed
 * directly onto the video — instead it becomes the audio track of the
 * talking-head clip, which is then composited onto the video. There is only
 * ever one audio source in the final output.
 */
export async function generateTalkingHead(projectId, project, options = {}) {
  const { voice = DEFAULT_VOICE, model = DEFAULT_MODEL } = options;
  const workDir = path.join(STORAGE_ROOT, 'talking_head_tmp', projectId);

  try {
    updateProject(projectId, {
      talking_head_status: 'generating',
      talking_head_error: null,
    });

    // ── 1. Load steps (same filter as voicePipeline) ────────────────────
    const rawSteps = listSteps(projectId);
    const steps = rawSteps.filter((s) => {
      const hasTime = typeof s.start_seconds === 'number' && typeof s.end_seconds === 'number';
      const hasText = (s.title || '').trim() || (s.body_markdown || '').trim();
      return hasTime && hasText;
    });

    if (steps.length === 0) {
      throw new Error('No documentation steps with timestamps — run the pipeline first.');
    }

    const preset = getDocTypePreset(project.doc_type);
    const flowing = Boolean(preset.flowing);

    function buildStepNarration(step, index) {
      const titleText = stripMarkdownForTTS(step.title || '').trim();
      const bodyText = stripMarkdownForTTS(step.body_markdown || '').trim();
      if (flowing) return bodyText || titleText;
      const parts = [];
      if (titleText) parts.push(`Step ${index + 1}. ${titleText}.`);
      if (bodyText) parts.push(bodyText);
      return parts.join(' ');
    }

    fs.mkdirSync(workDir, { recursive: true });

    // ── 2. Optional intro/outro (flowing doc types only) ─────────────────
    let introClip = null;
    let outroClip = null;
    if (flowing) {
      const docMeta = getDocMeta(projectId);
      const introText = stripMarkdownForTTS(docMeta?.intro_narration || '').trim();
      const outroText = stripMarkdownForTTS(docMeta?.outro_narration || '').trim();

      for (const [label, text] of [['intro', introText], ['outro', outroText]]) {
        if (!text) continue;
        const { buffer, usage } = await synthesizeSegmentAudio({ text, voice, model });
        const rawPath = path.join(workDir, `${label}_raw.wav`);
        fs.writeFileSync(rawPath, buffer);
        const normPath = path.join(workDir, `${label}_norm.wav`);
        await convertToStandardWav(rawPath, normPath);
        const duration = await getAudioDuration(normPath);
        const clip = { filePath: normPath, duration };
        if (label === 'intro') introClip = clip;
        else outroClip = clip;
        logUsage(projectId, {
          service: 'tts', model,
          inputTokens: usage?.prompt_tokens ?? Math.ceil(text.split(/\s+/).length * 1.3),
          outputTokens: Math.ceil(duration * 20),
        });
      }
    }

    // ── 3. Synthesize TTS for each step ──────────────────────────────────
    const parts = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const text = buildStepNarration(step, i);
      if (!text) continue;

      const { buffer, usage } = await synthesizeSegmentAudio({ text, voice, model });
      const rawPath = path.join(workDir, `step_${i}_raw.wav`);
      fs.writeFileSync(rawPath, buffer);
      const normPath = path.join(workDir, `step_${i}_norm.wav`);
      await convertToStandardWav(rawPath, normPath);
      const duration = await getAudioDuration(normPath);

      parts.push({ index: i, start: step.start_seconds, filePath: normPath, duration });

      logUsage(projectId, {
        service: 'tts', model,
        inputTokens: usage?.prompt_tokens ?? Math.ceil(text.split(/\s+/).length * 1.3),
        outputTokens: usage?.completion_tokens_details?.audio_tokens
          ?? usage?.completion_tokens
          ?? Math.ceil(duration * 20),
      });
    }

    updateProject(projectId, { talking_head_status: 'stitching' });

    // ── 4. Build the full narration timeline (same logic as voicePipeline), ──
    // but keep each piece tagged as 'speech' or 'silence' so the talking-head
    // stage knows which pieces to animate via the avatar API and which to
    // fill with the static presenter still image.
    const sequence = [];
    let cursor = 0;

    if (introClip) {
      sequence.push({ type: 'speech', filePath: introClip.filePath, duration: introClip.duration });
      cursor += introClip.duration;
    }

    for (const part of parts) {
      const targetStart = Math.max(0, part.start + NARRATION_START_OFFSET);
      const gap = targetStart - cursor;
      if (gap > MIN_GAP_SECONDS) {
        const silPath = path.join(workDir, `sil_${part.index}.wav`);
        await generateSilence(gap, silPath);
        sequence.push({ type: 'silence', filePath: silPath, duration: gap });
        cursor += gap;
      }
      sequence.push({ type: 'speech', filePath: part.filePath, duration: part.duration });
      cursor += part.duration;
    }

    if (outroClip) {
      const silPath = path.join(workDir, 'sil_outro.wav');
      await generateSilence(OUTRO_LEAD_PAUSE_SECONDS, silPath);
      sequence.push({ type: 'silence', filePath: silPath, duration: OUTRO_LEAD_PAUSE_SECONDS });
      cursor += OUTRO_LEAD_PAUSE_SECONDS;
      sequence.push({ type: 'speech', filePath: outroClip.filePath, duration: outroClip.duration });
      cursor += outroClip.duration;
    }

    const videoDuration = project.duration_seconds || cursor;
    if (videoDuration > cursor + MIN_GAP_SECONDS) {
      const tailPath = path.join(workDir, 'sil_tail.wav');
      const tailDuration = videoDuration - cursor;
      await generateSilence(tailDuration, tailPath);
      sequence.push({ type: 'silence', filePath: tailPath, duration: tailDuration });
      cursor = videoDuration;
    }

    const stitchedAudioPath = path.join(workDir, 'narration.wav');
    await concatAudioFiles(sequence.map((s) => s.filePath), stitchedAudioPath);

    const narrationDuration = await getAudioDuration(stitchedAudioPath);

    // ── 5. Generate the talking-head video ───────────────────────────────
    // Speech segments are animated via the avatar API using their own audio
    // as the drive signal; silence segments are filled with a frozen still
    // of the presenter so they don't appear to keep talking with no audio.
    // The full narration audio is muxed in as the single audio track.
    updateProject(projectId, { talking_head_status: 'rendering' });
    const talkingHeadVideoPath = path.join(workDir, 'talking_head.mp4');
    await generateTalkingHeadVideo({
      segments: sequence,
      audioPath: stitchedAudioPath,
      targetDuration: narrationDuration,
      outputPath: talkingHeadVideoPath,
    });

    // ── 6. Back up original (one-time, same as voicePipeline) ───────────
    updateProject(projectId, { talking_head_status: 'compositing' });

    // Use the same backup as the voice feature if it already exists, or
    // create a new one dedicated to the talking-head workflow. This keeps
    // the two features independently restorable.
    let backupPath = project.talking_head_backup_path;
    if (!backupPath || !fs.existsSync(backupPath)) {
      const ext = path.extname(project.video_path) || '.mp4';
      backupPath = path.join(STORAGE_ROOT, 'originals', `${projectId}_th${ext}`);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      // If the voice pipeline has already run, back up the voice-overlaid
      // video so the talking-head can be stacked on top of it.
      fs.copyFileSync(project.video_path, backupPath);
    }

    // ── 7. Extend source video if narration overruns ─────────────────────
    const sourceVideoDuration = await getVideoDuration(backupPath);
    let compositeSource = backupPath;
    let finalDurationSeconds = sourceVideoDuration;

    const overrunSeconds = narrationDuration - sourceVideoDuration;
    if (overrunSeconds > END_OVERRUN_TOLERANCE_SECONDS) {
      const extra = overrunSeconds + END_OVERRUN_BUFFER_SECONDS;
      const extendedPath = path.join(workDir, `extended${path.extname(project.video_path) || '.mp4'}`);
      await extendVideoWithFreezeFrame(backupPath, extra, extendedPath);
      compositeSource = extendedPath;
      finalDurationSeconds = sourceVideoDuration + extra;
    }

    // ── 8. Composite: overlay talking-head bubble on the video ───────────
    const finalPath = path.join(workDir, `composite${path.extname(project.video_path) || '.mp4'}`);
    await overlayTalkingHead(compositeSource, talkingHeadVideoPath, finalPath);

    // ── 9. Replace project video in place ────────────────────────────────
    fs.copyFileSync(finalPath, project.video_path);

    updateProject(projectId, {
      talking_head_status: 'complete',
      talking_head_backup_path: backupPath,
      talking_head_generated_at: new Date().toISOString(),
      duration_seconds: finalDurationSeconds,
    });
  } catch (err) {
    console.error(`Talking-head generation failed for project ${projectId}:`, err);
    updateProject(projectId, { talking_head_status: 'failed', talking_head_error: err.message });
    throw err;
  } finally {
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Restores the project video to the state before talking-head overlay was applied.
 */
export async function restoreTalkingHeadVideo(projectId, project) {
  if (!project.talking_head_backup_path || !fs.existsSync(project.talking_head_backup_path)) {
    throw new Error('No talking-head backup available to restore.');
  }
  fs.copyFileSync(project.talking_head_backup_path, project.video_path);

  const originalDuration = await getVideoDuration(project.talking_head_backup_path).catch(() => project.duration_seconds);

  updateProject(projectId, {
    talking_head_status: null,
    talking_head_error: null,
    talking_head_generated_at: null,
    duration_seconds: originalDuration,
  });
}
