import path from 'path';
import fs from 'fs';
import {
  setProjectStatus,
  updateProject,
  saveTranscript,
  getTranscript,
  insertFrame,
  insertStep,
  resetProjectData,
  upsertDocMeta,
  listFrames,
  clearStepsForProject,
  logUsage,
} from '../db/repository.js';
import {
  extractAudio, getVideoDuration, extractSceneChangeFrames, extractIntervalFrames,
  extractFrameAtTimestamp,
} from '../services/ffmpegService.js';
import { filterBlurryFrames } from '../services/sharpnessFilter.js';
import { transcribeAudio, segmentsToTimestampedText } from '../services/whisperService.js';
import { generateStructuredDoc } from '../services/docGenerationService.js';
import { selectBestFrameForStep, findCandidateFrames } from '../services/visionSelectionService.js';
import { fireWebhooks } from '../services/webhookService.js';

const STORAGE_ROOT = path.join(process.cwd(), 'storage');

function projectPaths(projectId) {
  return {
    audioPath: path.join(STORAGE_ROOT, 'audio', `${projectId}.wav`),
    framesDir: path.join(STORAGE_ROOT, 'frames', projectId),
  };
}

/**
 * Runs the full pipeline for a project that already has a video uploaded.
 * Designed to be called from a background job runner (see jobs/queue.js).
 * Calling this on a project that already has data is safe — resetProjectData()
 * is called first to wipe any previous run's artifacts.
 */
export async function processProject(projectId, project, options = {}) {
  const {
    whisperModel = process.env.WHISPER_MODEL || 'whisper-1',
    textModel = process.env.TEXT_MODEL || 'gpt-5.5',
    visionModel = process.env.VISION_MODEL || 'gpt-4o',
    sceneThreshold = parseFloat(process.env.SCENE_CHANGE_THRESHOLD || '0.12'),
    maxCandidatesPerStep = parseInt(process.env.MAX_CANDIDATE_FRAMES_PER_STEP || '6', 10),
    frameIntervalSeconds = parseFloat(process.env.FRAME_INTERVAL_SECONDS || '3'),
    sharpnessThreshold = parseFloat(process.env.SHARPNESS_THRESHOLD || '150'),
  } = options;

  const { audioPath, framesDir } = projectPaths(projectId);

  try {
    // 0. Clean slate — wipe any data from a previous run
    resetProjectData(projectId);

    // 1. Probe duration
    setProjectStatus(projectId, 'extracting_audio');
    const duration = await getVideoDuration(project.video_path);
    updateProject(projectId, { duration_seconds: duration });

    // 2. Extract audio
    await extractAudio(project.video_path, audioPath);
    updateProject(projectId, { audio_path: audioPath });

    // 3. Transcribe with Whisper
    setProjectStatus(projectId, 'transcribing');
    const transcription = await transcribeAudio(audioPath, whisperModel);
    saveTranscript(projectId, { rawJson: transcription.raw, fullText: transcription.fullText });

    // Log Whisper usage (duration-based — approximated as 1 "input token" per second)
    if (duration) {
      logUsage(projectId, {
        service: 'whisper',
        model: whisperModel,
        inputTokens: Math.ceil(duration),
        outputTokens: 0,
      });
    }

    // 4. Extract candidate frames: scene-change detection PLUS fixed-interval
    //    sampling, then drop blurry/motion-blurred frames with a Laplacian
    //    variance check before any of them reach GPT Vision. This fixes the
    //    most common cause of mediocre screenshots — picking from a pool that
    //    already contains blurry transition frames, mid-click cursors, and
    //    partially rendered UI — without spending any extra API calls.
    setProjectStatus(projectId, 'extracting_frames');

    // Clean up any leftover frame files from previous runs
    if (fs.existsSync(framesDir)) {
      fs.rmSync(framesDir, { recursive: true, force: true });
    }

    const [sceneFrames, intervalFrames] = await Promise.all([
      extractSceneChangeFrames(project.video_path, framesDir, sceneThreshold),
      extractIntervalFrames(project.video_path, framesDir, frameIntervalSeconds),
    ]);

    setProjectStatus(projectId, 'filtering_frames');
    const candidateFrames = [
      ...sceneFrames.map((f) => ({ ...f, source: 'scene' })),
      ...intervalFrames.map((f) => ({ ...f, source: 'interval' })),
    ];
    const sharpFrames = await filterBlurryFrames(candidateFrames, sharpnessThreshold);

    for (const f of sharpFrames) {
      insertFrame(projectId, {
        timestampSeconds: f.timestampSeconds,
        filePath: f.filePath,
        source: f.source,
        changeScore: f.changeScore,
        sharpness: f.sharpness,
      });
    }

    // 5. Generate structured doc (steps with time ranges) via GPT, then
    //    pick a screenshot for each step from the sharp candidate pool.
    const transcript = getTranscript(projectId);
    const timestampedText = segmentsToTimestampedText(transcript.raw_json.segments || []);
    await generateDocAndScreenshots(projectId, project, {
      timestampedText, textModel, visionModel, maxCandidatesPerStep, framesDir,
    });

    setProjectStatus(projectId, 'complete');
    await fireWebhooks({ event: 'project.complete', projectId });
  } catch (err) {
    console.error(`Pipeline failed for project ${projectId}:`, err);
    setProjectStatus(projectId, 'failed', err.message);
    await fireWebhooks({ event: 'project.failed', projectId, error: err.message });
    throw err;
  }
}

/**
 * Re-runs only the doc-generation and screenshot-matching stages using the
 * project's existing transcript and already-extracted frames — no re-upload,
 * re-transcription, or re-extraction needed. Intended for the
 * "edit transcript → regenerate doc" flow: if Whisper mis-heard a product
 * name or technical term, fixing the transcript text and regenerating here
 * corrects every step that mentions it, instead of patching steps one by one
 * after the fact.
 */
export async function regenerateDoc(projectId, project, options = {}) {
  const {
    textModel = process.env.TEXT_MODEL || 'gpt-5.5',
    visionModel = process.env.VISION_MODEL || 'gpt-4o',
    maxCandidatesPerStep = parseInt(process.env.MAX_CANDIDATE_FRAMES_PER_STEP || '6', 10),
  } = options;

  const { framesDir } = projectPaths(projectId);

  try {
    const transcript = getTranscript(projectId);
    if (!transcript) {
      throw new Error('No transcript available — run the full pipeline first.');
    }

    setProjectStatus(projectId, 'writing_doc');
    const timestampedText = segmentsToTimestampedText(transcript.raw_json.segments || []);

    clearStepsForProject(projectId);

    await generateDocAndScreenshots(projectId, project, {
      timestampedText, textModel, visionModel, maxCandidatesPerStep, framesDir,
    });

    setProjectStatus(projectId, 'complete');
    await fireWebhooks({ event: 'project.complete', projectId });
  } catch (err) {
    console.error(`Doc regeneration failed for project ${projectId}:`, err);
    setProjectStatus(projectId, 'failed', err.message);
    await fireWebhooks({ event: 'project.failed', projectId, error: err.message });
    throw err;
  }
}

/**
 * Shared by both the full pipeline and regenerateDoc(): turns a timestamped
 * transcript into structured steps via GPT, then picks the best screenshot
 * for each step from the project's frame pool via GPT Vision (extracting a
 * midpoint fallback frame if no candidates fall in range).
 */
async function generateDocAndScreenshots(projectId, project, opts) {
  const { timestampedText, textModel, visionModel, maxCandidatesPerStep, framesDir } = opts;

  setProjectStatus(projectId, 'writing_doc');
  const structured = await generateStructuredDoc({
    timestampedText,
    docType: project.doc_type,
    textModel,
    title: project.title,
    projectId,
  });
  upsertDocMeta(projectId, {
    summary: structured.summary,
    prerequisites: structured.prerequisites,
    audience: structured.audience,
  });

  setProjectStatus(projectId, 'matching_screenshots');
  let allFrames = listFrames(projectId);

  for (let i = 0; i < structured.steps.length; i++) {
    const step = structured.steps[i];
    let candidates = findCandidateFrames(allFrames, step, 2).slice(0, maxCandidatesPerStep);

    if (candidates.length === 0) {
      const mid = ((step.start_seconds ?? 0) + (step.end_seconds ?? step.start_seconds ?? 0)) / 2;
      const fallbackPath = path.join(framesDir, `fallback_step${i}_${Date.now()}.jpg`);
      try {
        await extractFrameAtTimestamp(project.video_path, mid, fallbackPath);
        const newFrame = insertFrame(projectId, {
          timestampSeconds: mid,
          filePath: fallbackPath,
          source: 'fallback_midpoint',
        });
        allFrames = listFrames(projectId);
        candidates = [{ id: newFrame.id, timestampSeconds: mid, filePath: fallbackPath }];
      } catch {
        // Proceed without a screenshot for this step if extraction fails.
      }
    }

    const selection = await selectBestFrameForStep({ step, candidates, visionModel, projectId });

    insertStep(projectId, {
      stepOrder: i,
      title: step.title,
      bodyMarkdown: step.body_markdown,
      startSeconds: step.start_seconds,
      endSeconds: step.end_seconds,
      screenshotFrameId: selection.chosenFrameId,
      screenshotRationale: selection.rationale,
    });
  }
}
