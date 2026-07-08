import express from 'express';
import path from 'path';
import fs from 'fs';
import {
  createProject, getProject, listProjects, updateProject, deleteProject,
  listFrames, listSteps, updateStep, deleteStep, reorderSteps, insertStep,
  getDocMeta, getTranscript, insertFrame, getFrame,
  getProjectUsage, estimateProjectCost, listStepHistory, getStepHistoryEntry,
  resetProjectData, updateTranscriptSegments,
} from '../db/repository.js';
import { upload } from '../utils/uploadMiddleware.js';
import { enqueueJob, queueLength, cancelQueuedJob, isJobQueued } from '../jobs/queue.js';
import { processProject, regenerateDoc } from '../jobs/pipeline.js';
import { generateAiVoiceResumable, restoreOriginalVideo } from '../jobs/voicePipeline.js';
import { generateTalkingHeadResumable, restoreTalkingHeadVideo } from '../jobs/talkingHeadPipeline.js';
import { extractFrameAtTimestamp } from '../services/ffmpegService.js';
import { AI_VOICES, AI_VOICE_MODELS, DEFAULT_VOICE, DEFAULT_MODEL } from '../services/ttsService.js';
import { DOC_TYPES } from '../services/docTypePresets.js';
import { buildNarrationScript } from '../services/narrationScriptService.js';
import { parseProgress, requestProcessControl } from '../services/generationControlService.js';

export const projectsRouter = express.Router();

// ─── Doc type presets ─────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/doc-types:
 *   get:
 *     summary: List available documentation types
 *     description: Returns the set of doc-type presets that control how GPT structures the output (step-by-step guide, SOP, help center article, etc.).
 *     tags: [Models]
 *     responses:
 *       200:
 *         description: List of doc types
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 types:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       key:   { type: string, example: step_by_step }
 *                       label: { type: string, example: Step-by-step guide }
 *             example:
 *               types:
 *                 - key: step_by_step
 *                   label: Step-by-step guide
 *                 - key: sop
 *                   label: Standard operating procedure
 *                 - key: help_center
 *                   label: Help center article
 *                 - key: knowledge_base
 *                   label: Knowledge base article
 */
projectsRouter.get('/doc-types', (req, res) => {
  const types = Object.entries(DOC_TYPES).map(([key, val]) => ({
    key,
    label: val.label,
    flowing: Boolean(val.flowing),
    availableInDocs: Boolean(val.availableInDocs),
  }));
  res.json({ types });
});

// ─── Available models ──────────────────────────────────────────────────────────

const TEXT_MODELS = [
  { id: 'gpt-5.5', label: 'GPT-5.5 (newest, most powerful)' },
  { id: 'gpt-5.4', label: 'GPT-5.4 (affordable coding & professional work)' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini (fast, low-cost)' },
  { id: 'gpt-4.5-preview', label: 'GPT-4.5 Preview (best quality)' },
  { id: 'o3', label: 'o3 (reasoning, slower)' },
  { id: 'o4-mini', label: 'o4-mini (fast reasoning)' },
  { id: 'gpt-4o', label: 'GPT-4o' },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini (fastest, cheapest)' },
  { id: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
];

const VISION_MODELS = [
  { id: 'gpt-5.5', label: 'GPT-5.5 (newest, most powerful)' },
  { id: 'gpt-5.4', label: 'GPT-5.4 (affordable coding & professional work)' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini (fast, low-cost)' },
  { id: 'gpt-4.5-preview', label: 'GPT-4.5 Preview (best quality)' },
  { id: 'gpt-4o', label: 'GPT-4o' },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini (fastest, cheapest)' },
  { id: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
];

/**
 * @openapi
 * /api/models:
 *   get:
 *     summary: List available AI models
 *     description: |
 *       Returns ordered lists of OpenAI models available for doc writing (text)
 *       and screenshot matching (vision), plus the current server-side defaults.
 *
 *       Models are listed best-first. The UI uses this endpoint to populate
 *       the model dropdowns in Settings. When `TEXT_MODEL` / `VISION_MODEL`
 *       are set in `.env`, those values win over any UI selection.
 *     tags: [Models]
 *     responses:
 *       200:
 *         description: Available models and server defaults
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 text:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/ModelInfo' }
 *                 vision:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/ModelInfo' }
 *                 defaults:
 *                   type: object
 *                   properties:
 *                     text:   { type: string, example: gpt-4.5-preview }
 *                     vision: { type: string, example: gpt-4o }
 *             example:
 *               text:
 *                 - id: gpt-4.5-preview
 *                   label: GPT-4.5 Preview (best quality)
 *                 - id: gpt-4o
 *                   label: GPT-4o
 *               vision:
 *                 - id: gpt-4.5-preview
 *                   label: GPT-4.5 Preview (best quality)
 *                 - id: gpt-4o
 *                   label: GPT-4o
 *               defaults:
 *                 text: gpt-4.5-preview
 *                 vision: gpt-4o
 */
projectsRouter.get('/models', (req, res) => {
  res.json({
    text: TEXT_MODELS,
    vision: VISION_MODELS,
    defaults: {
      text: process.env.TEXT_MODEL || 'gpt-5.5',
      vision: process.env.VISION_MODEL || 'gpt-4o',
    },
  });
});

// ─── Projects CRUD ───────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/projects:
 *   post:
 *     summary: Create a project and upload a video
 *     description: |
 *       Uploads a screen recording and creates a new project record.
 *       The video is stored on disk; processing does **not** start automatically —
 *       call `POST /api/projects/:id/process` next.
 *
 *       Request must be `multipart/form-data`. The video field name must be `video`.
 *     tags: [Projects]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [title, video]
 *             properties:
 *               title:
 *                 type: string
 *                 description: Human-readable title for the generated documentation
 *                 example: How to invite a teammate
 *               docType:
 *                 type: string
 *                 description: Documentation style preset (defaults to step_by_step)
 *                 enum: [step_by_step, sop, help_center, knowledge_base, talking_head_compact]
 *                 example: step_by_step
 *               video:
 *                 type: string
 *                 format: binary
 *                 description: Screen recording file (MP4, MOV, WebM, MKV)
 *     responses:
 *       201:
 *         description: Project created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 project: { $ref: '#/components/schemas/Project' }
 *             example:
 *               project:
 *                 id: proj_abc123
 *                 title: How to invite a teammate
 *                 doc_type: step_by_step
 *                 status: uploaded
 *                 duration_seconds: null
 *                 created_at: "2024-01-15T10:30:00.000Z"
 *       400:
 *         description: Missing title or video file
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: video file is required (field name "video") }
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
projectsRouter.post('/projects', upload.single('video'), (req, res) => {
  try {
    const { title, docType } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
    if (!req.file) return res.status(400).json({ error: 'video file is required (field name "video")' });

    const project = createProject({ title: title.trim(), docType: docType || 'step_by_step' });
    updateProject(project.id, { video_path: req.file.path, status: 'uploaded' });

    res.status(201).json({ project: getProject(project.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @openapi
 * /api/projects:
 *   get:
 *     summary: List all projects
 *     description: Returns all projects ordered by creation date (newest first), along with the current processing queue length.
 *     tags: [Projects]
 *     responses:
 *       200:
 *         description: Project list and queue length
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 projects:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Project' }
 *                 queueLength:
 *                   type: integer
 *                   description: Number of projects currently waiting in the processing queue
 *                   example: 2
 *             example:
 *               projects:
 *                 - id: proj_abc123
 *                   title: How to invite a teammate
 *                   status: complete
 *                   created_at: "2024-01-15T10:30:00.000Z"
 *               queueLength: 0
 */
projectsRouter.get('/projects', (req, res) => {
  res.json({ projects: listProjects(), queueLength: queueLength() });
});

/**
 * @openapi
 * /api/projects/{id}:
 *   get:
 *     summary: Get a single project
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: proj_abc123
 *     responses:
 *       200:
 *         description: Project record
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 project: { $ref: '#/components/schemas/Project' }
 *       404:
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
projectsRouter.get('/projects/:id', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({ project });
});

/**
 * @openapi
 * /api/projects/{id}:
 *   delete:
 *     summary: Delete a project
 *     description: |
 *       Permanently deletes the project and all associated data: the uploaded video,
 *       extracted audio, frame screenshots, steps, transcript, and usage records.
 *       **This action cannot be undone.**
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: proj_abc123
 *     responses:
 *       200:
 *         description: Project deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, example: true }
 *       404:
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
projectsRouter.delete('/projects/:id', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const storageRoot = path.join(process.cwd(), 'storage');
  const audioPath = path.join(storageRoot, 'audio', `${project.id}.wav`);
  const framesDir = path.join(storageRoot, 'frames', project.id);
  const voiceTmpDir = path.join(storageRoot, 'voice_tmp', project.id);

  if (fs.existsSync(audioPath)) fs.rmSync(audioPath, { force: true });
  if (fs.existsSync(framesDir)) fs.rmSync(framesDir, { recursive: true, force: true });
  if (fs.existsSync(voiceTmpDir)) fs.rmSync(voiceTmpDir, { recursive: true, force: true });
  if (project.original_video_backup_path && fs.existsSync(project.original_video_backup_path)) {
    fs.rmSync(project.original_video_backup_path, { force: true });
  }
  if (project.video_path && fs.existsSync(project.video_path)) {
    fs.rmSync(project.video_path, { force: true });
  }

  deleteProject(project.id);
  res.json({ ok: true });
});

// ─── Pipeline control ────────────────────────────────────────────────────────

const PROCESSING_STATUSES = new Set([
  'extracting_audio', 'transcribing', 'writing_doc', 'extracting_frames', 'filtering_frames', 'matching_screenshots',
]);

/**
 * @openapi
 * /api/projects/{id}/process:
 *   post:
 *     summary: Start the AI processing pipeline
 *     description: |
 *       Enqueues the project for processing. The pipeline runs these stages in order:
 *
 *       1. **extracting_audio** — ffmpeg strips audio to WAV
 *       2. **transcribing** — Whisper transcribes with word-level timestamps
 *       3. **writing_doc** — GPT turns the transcript into structured steps
 *       4. **extracting_frames** — ffmpeg detects scene changes and extracts candidate screenshots
 *       5. **matching_screenshots** — GPT Vision picks the best screenshot for each step
 *
 *       Poll `GET /api/projects/:id/status` to follow progress.
 *       Re-running a project that already has data wipes the previous run first.
 *
 *       **Model override:** pass `textModel` and/or `visionModel` to use a specific
 *       OpenAI model for this run. If omitted, the server falls back to `TEXT_MODEL` /
 *       `VISION_MODEL` env vars, then to the built-in defaults (`gpt-4.5-preview` / `gpt-4o`).
 *     tags: [Pipeline]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: proj_abc123
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               textModel:
 *                 type: string
 *                 description: OpenAI model to use for documentation writing
 *                 example: gpt-4.5-preview
 *               visionModel:
 *                 type: string
 *                 description: OpenAI model to use for screenshot matching (must support vision)
 *                 example: gpt-4o
 *           example:
 *             textModel: gpt-4.5-preview
 *             visionModel: gpt-4o
 *     responses:
 *       200:
 *         description: Pipeline queued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:     { type: boolean, example: true }
 *                 status: { type: string, example: queued }
 *       400:
 *         description: Project has no uploaded video
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       404:
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       409:
 *         description: Project is already processing
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: Project is already processing }
 */
projectsRouter.post('/projects/:id/process', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.video_path) return res.status(400).json({ error: 'Project has no uploaded video' });
  if (PROCESSING_STATUSES.has(project.status)) {
    return res.status(409).json({ error: 'Project is already processing' });
  }

  const textModel = req.body?.textModel || process.env.TEXT_MODEL || 'gpt-4.5-preview';
  const visionModel = req.body?.visionModel || process.env.VISION_MODEL || 'gpt-4o';

  enqueueJob(() => processProject(project.id, project, { textModel, visionModel }));
  res.json({ ok: true, status: 'queued' });
});

/**
 * @openapi
 * /api/projects/{id}/status:
 *   get:
 *     summary: Poll pipeline status
 *     description: |
 *       Lightweight endpoint for polling. Returns the current pipeline stage and,
 *       if the pipeline failed, the error message.
 *
 *       **Possible status values:**
 *       | Value | Meaning |
 *       |---|---|
 *       | `uploaded` | Video uploaded, processing not started |
 *       | `queued` | Waiting in the job queue |
 *       | `extracting_audio` | ffmpeg stripping audio |
 *       | `transcribing` | Whisper running |
 *       | `writing_doc` | GPT writing steps |
 *       | `extracting_frames` | ffmpeg scene-change extraction |
 *       | `matching_screenshots` | GPT Vision selecting screenshots |
 *       | `complete` | Pipeline finished successfully |
 *       | `failed` | Pipeline failed — see `errorMessage` |
 *
 *       Recommended polling interval: 2–5 seconds.
 *     tags: [Pipeline]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: proj_abc123
 *     responses:
 *       200:
 *         description: Current status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:       { type: string, example: matching_screenshots }
 *                 errorMessage: { type: string, nullable: true }
 *             example:
 *               status: complete
 *               errorMessage: null
 *       404:
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
projectsRouter.get('/projects/:id/status', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({ status: project.status, errorMessage: project.error_message });
});

// ─── Doc assembly ─────────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/projects/{id}/doc:
 *   get:
 *     summary: Get the full generated document
 *     description: Returns the project, metadata (summary, audience, prerequisites), all steps, and all extracted frames. This is the primary endpoint for rendering the doc in the UI.
 *     tags: [Documents]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: proj_abc123
 *     responses:
 *       200:
 *         description: Full document bundle
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 project: { $ref: '#/components/schemas/Project' }
 *                 meta:    { $ref: '#/components/schemas/DocMeta' }
 *                 steps:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Step' }
 *                 frames:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Frame' }
 *       404:
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
projectsRouter.get('/projects/:id/doc', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const meta = getDocMeta(project.id);
  const steps = listSteps(project.id);
  const frames = listFrames(project.id);

  res.json({ project, meta, steps, frames });
});

/**
 * @openapi
 * /api/projects/{id}/assets:
 *   get:
 *     summary: Get every asset generated for a project
 *     description: |
 *       A single "everything" bundle for a project — the source video, the
 *       extracted audio track, the Whisper transcript, the generated
 *       documentation (metadata + steps), every matched screenshot frame,
 *       AI voice-over status, available export formats, and cost/usage
 *       totals. Intended for an asset browser view (e.g. what's shown when
 *       a user clicks into a project from the dashboard) so the whole
 *       history of what the pipeline produced is visible in one place,
 *       rather than piecing it together from several endpoints.
 *
 *       Media fields (`video`, `audio`) report `available` plus a `url` to
 *       stream/download the file — they don't inline the bytes.
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: proj_abc123
 *     responses:
 *       200:
 *         description: Full asset bundle for the project
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 project: { $ref: '#/components/schemas/Project' }
 *                 meta:    { $ref: '#/components/schemas/DocMeta' }
 *                 steps:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Step' }
 *                 frames:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Frame' }
 *                 transcript:
 *                   type: object
 *                   nullable: true
 *                   description: Null if the project hasn't been transcribed yet.
 *                 media:
 *                   type: object
 *                   properties:
 *                     video:
 *                       type: object
 *                       properties:
 *                         available: { type: boolean }
 *                         url: { type: string, nullable: true }
 *                         durationSeconds: { type: number, nullable: true }
 *                     audio:
 *                       type: object
 *                       properties:
 *                         available: { type: boolean }
 *                         url: { type: string, nullable: true }
 *                     originalVideoBackup:
 *                       type: object
 *                       properties:
 *                         available: { type: boolean }
 *                         url: { type: string, nullable: true }
 *                 voice:
 *                   type: object
 *                   description: State of the on-demand AI voice-over feature, if ever run for this project.
 *                 exports:
 *                   type: object
 *                   description: Download URLs for every supported export format.
 *                 cost:
 *                   type: object
 *                   properties:
 *                     total_usd: { type: number }
 *                     breakdown: { type: array }
 *       404:
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
projectsRouter.get('/projects/:id/assets', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const meta = getDocMeta(project.id);
  const steps = listSteps(project.id);
  const frames = listFrames(project.id).map((frame) => ({
    ...frame,
    url: `/api/frames/${frame.id}/image`,
  }));
  const transcript = getTranscript(project.id);
  const cost = estimateProjectCost(project.id);

  const hasVideo = Boolean(project.video_path && fs.existsSync(project.video_path));
  const hasAudio = Boolean(project.audio_path && fs.existsSync(project.audio_path));
  const hasBackup = Boolean(
    project.original_video_backup_path && fs.existsSync(project.original_video_backup_path)
  );

  res.json({
    project,
    meta,
    steps,
    frames,
    transcript,
    media: {
      video: {
        available: hasVideo,
        url: hasVideo ? `/api/projects/${project.id}/video` : null,
        durationSeconds: project.duration_seconds,
      },
      audio: {
        available: hasAudio,
        url: hasAudio ? `/api/projects/${project.id}/audio` : null,
      },
      originalVideoBackup: {
        available: hasBackup,
        // Not exposed as a streamable URL today — the restore endpoint below
        // swaps it back into place rather than serving it directly.
        note: hasBackup ? 'Restorable via POST /projects/:id/voice/restore' : null,
      },
    },
    voice: {
      status: project.voice_status || null,
      voiceName: project.voice_name || null,
      voiceModel: project.voice_model || null,
      generatedAt: project.voice_generated_at || null,
      error: project.voice_error || null,
    },
    exports: {
      markdown: `/api/projects/${project.id}/export/markdown`,
      html: `/api/projects/${project.id}/export/html`,
      pdf: `/api/projects/${project.id}/export/pdf`,
      docx: `/api/projects/${project.id}/export/docx`,
    },
    cost,
  });
});

/**
 * @openapi
 * /api/projects/{id}/transcript:
 *   get:
 *     summary: Get the raw Whisper transcript
 *     description: Returns the full transcript including the raw Whisper JSON (segments, words, and confidence scores) and a plain-text version.
 *     tags: [Documents]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: proj_abc123
 *     responses:
 *       200:
 *         description: Transcript data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 transcript: { $ref: '#/components/schemas/Transcript' }
 *       404:
 *         description: No transcript yet (project not processed)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: No transcript yet }
 */
projectsRouter.get('/projects/:id/transcript', (req, res) => {
  const transcript = getTranscript(req.params.id);
  if (!transcript) return res.status(404).json({ error: 'No transcript yet' });
  res.json({ transcript });
});

/**
 * @openapi
 * /api/projects/{id}/transcript:
 *   patch:
 *     summary: Edit transcript segment text
 *     description: |
 *       Corrects mis-transcribed words (e.g. a product name, UI label, or
 *       technical term Whisper misheard) without re-running Whisper. Segment
 *       timestamps are preserved — only `text` is updated, matched by segment
 *       `id`. This only changes the stored transcript; call
 *       `POST /projects/:id/regenerate-doc` afterward to propagate the fix
 *       into the generated steps.
 *     tags: [Documents]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               segments:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     id: { type: integer, example: 4 }
 *                     text: { type: string, example: "Click the Acme Dashboard icon" }
 *             example:
 *               segments:
 *                 - id: 4
 *                   text: "Click the Acme Dashboard icon"
 *     responses:
 *       200:
 *         description: Updated transcript
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 transcript: { $ref: '#/components/schemas/Transcript' }
 *       400:
 *         description: Missing or invalid segments array
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       404:
 *         description: No transcript yet for this project
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
projectsRouter.patch('/projects/:id/transcript', (req, res) => {
  const { segments } = req.body || {};
  if (!Array.isArray(segments) || segments.length === 0) {
    return res.status(400).json({ error: 'segments must be a non-empty array of { id, text }' });
  }

  const existing = getTranscript(req.params.id);
  if (!existing) return res.status(404).json({ error: 'No transcript yet' });

  const transcript = updateTranscriptSegments(req.params.id, segments);
  res.json({ transcript });
});

/**
 * @openapi
 * /api/projects/{id}/regenerate-doc:
 *   post:
 *     summary: Regenerate the doc from the (possibly edited) transcript
 *     description: |
 *       Re-runs only the doc-generation and screenshot-matching stages —
 *       **no** re-upload, re-transcription, or frame re-extraction. Use this
 *       after editing the transcript (`PATCH /projects/:id/transcript`) so a
 *       corrected product name, UI label, or technical term propagates into
 *       every step that mentions it, rather than patching steps one by one.
 *
 *       Existing steps are replaced; the transcript and previously extracted
 *       frames are reused as-is. Poll `GET /projects/:id/status` to follow
 *       progress (`writing_doc` → `matching_screenshots` → `complete`).
 *     tags: [Pipeline]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               textModel: { type: string, example: gpt-5.5 }
 *               visionModel: { type: string, example: gpt-4o }
 *     responses:
 *       200:
 *         description: Regeneration queued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 status: { type: string, example: queued }
 *       400:
 *         description: No transcript available yet
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       404:
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       409:
 *         description: Project is already processing
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
projectsRouter.post('/projects/:id/regenerate-doc', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (PROCESSING_STATUSES.has(project.status)) {
    return res.status(409).json({ error: 'Project is already processing' });
  }
  const transcript = getTranscript(project.id);
  if (!transcript) return res.status(400).json({ error: 'No transcript available — run the full pipeline first' });

  const textModel = req.body?.textModel || process.env.TEXT_MODEL || 'gpt-5.5';
  const visionModel = req.body?.visionModel || process.env.VISION_MODEL || 'gpt-4o';

  enqueueJob(() => regenerateDoc(project.id, project, { textModel, visionModel }));
  res.json({ ok: true, status: 'queued' });
});

// ─── Video / audio streaming ────────────────────────────────────────────────

const VIDEO_CONTENT_TYPES = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska' };
const AUDIO_CONTENT_TYPES = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg' };

/**
 * Streams a file on disk with HTTP Range support, shared by the video and
 * audio endpoints so both players can scrub without downloading the whole
 * file up front.
 */
function streamMediaFile(req, res, filePath, contentType) {
  const { size: fileSize } = fs.statSync(filePath);
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const match = /bytes=(\d+)-(\d*)/.exec(range);
  if (!match) return res.status(416).end();

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
  if (Number.isNaN(start) || start >= fileSize || end >= fileSize) {
    res.status(416).setHeader('Content-Range', `bytes */${fileSize}`);
    return res.end();
  }

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': contentType,
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

/**
 * @openapi
 * /api/projects/{id}/video:
 *   get:
 *     summary: Stream the original video
 *     description: |
 *       Supports HTTP Range requests so the browser `<video>` element can scrub
 *       to arbitrary positions without downloading the whole file.
 *       Used by the in-app video panel to let you seek through the recording
 *       alongside the generated steps.
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: proj_abc123
 *       - in: header
 *         name: Range
 *         schema: { type: string }
 *         description: HTTP range header for partial content requests
 *         example: "bytes=0-1048575"
 *     responses:
 *       200:
 *         description: Full video stream
 *         content:
 *           video/mp4: {}
 *       206:
 *         description: Partial video content (range request)
 *         content:
 *           video/mp4: {}
 *       404:
 *         description: Project or video file not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       416:
 *         description: Range not satisfiable
 */
projectsRouter.get('/projects/:id/video', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.video_path || !fs.existsSync(project.video_path)) {
    return res.status(404).json({ error: 'No video file for this project' });
  }
  const contentType = VIDEO_CONTENT_TYPES[path.extname(project.video_path).toLowerCase()] || 'video/mp4';
  streamMediaFile(req, res, project.video_path, contentType);
});

/**
 * @openapi
 * /api/projects/{id}/audio:
 *   get:
 *     summary: Stream the extracted audio track
 *     description: |
 *       Serves the raw audio (`.wav`) extracted from the source video during
 *       the pipeline's `extracting_audio` stage — the same file that was sent
 *       to Whisper for transcription. Supports HTTP Range requests for
 *       scrubbing, same as the video endpoint.
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: proj_abc123
 *       - in: header
 *         name: Range
 *         schema: { type: string }
 *         description: HTTP range header for partial content requests
 *         example: "bytes=0-1048575"
 *     responses:
 *       200:
 *         description: Full audio stream
 *         content:
 *           audio/wav: {}
 *       206:
 *         description: Partial audio content (range request)
 *         content:
 *           audio/wav: {}
 *       404:
 *         description: Project or audio file not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       416:
 *         description: Range not satisfiable
 */
projectsRouter.get('/projects/:id/audio', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.audio_path || !fs.existsSync(project.audio_path)) {
    return res.status(404).json({ error: 'No audio file for this project' });
  }
  const contentType = AUDIO_CONTENT_TYPES[path.extname(project.audio_path).toLowerCase()] || 'audio/wav';
  streamMediaFile(req, res, project.audio_path, contentType);
});

// ─── AI voice-over ─────────────────────────────────────────────────────────

const VOICE_PROCESSING_STATUSES = new Set(['queued', 'generating', 'stitching', 'muxing']);
const TALKING_HEAD_PROCESSING_STATUSES = new Set(['queued', 'generating', 'stitching', 'rendering', 'compositing']);
const RESUMABLE_PROCESS_STATUSES = new Set(['paused', 'stopped', 'failed']);

function buildPreview(projectId, docType) {
  const steps = listSteps(projectId);
  const docMeta = getDocMeta(projectId);
  const script = buildNarrationScript({ docType, steps, docMeta });
  return {
    totalSpeechSegments: script.totalSpeechSegments,
    fullText: script.fullText,
    lines: script.spokenLines.map((line, index) => ({
      index,
      type: line.type,
      label: line.label,
      text: line.text,
      startSeconds: line.startSeconds ?? null,
      endSeconds: line.endSeconds ?? null,
    })),
  };
}

/**
 * @openapi
 * /api/voices:
 *   get:
 *     summary: List available AI voices and TTS models
 *     description: Returns the voice options for the AI voice-over feature, the audio model(s) that support them, and server-side defaults.
 *     tags: [Models]
 *     responses:
 *       200:
 *         description: Voice and model options
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 voices:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, example: alloy }
 *                       label: { type: string, example: "Alloy — neutral, balanced" }
 *                 models:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, example: gpt-audio-1.5 }
 *                       label: { type: string }
 *                 defaults:
 *                   type: object
 *                   properties:
 *                     voice: { type: string, example: alloy }
 *                     model: { type: string, example: gpt-audio-1.5 }
 */
projectsRouter.get('/voices', (req, res) => {
  res.json({
    voices: AI_VOICES,
    models: AI_VOICE_MODELS,
    defaults: {
      voice: process.env.TTS_VOICE || DEFAULT_VOICE,
      model: process.env.TTS_MODEL || DEFAULT_MODEL,
    },
  });
});

/**
 * @openapi
 * /api/projects/{id}/voice:
 *   post:
 *     summary: Generate an AI voice-over and replace the video's audio
 *     description: |
 *       Builds a new speech track from the project's transcript using the
 *       selected OpenAI voice/model, fits it to the original timing (silence
 *       gaps where pauses were, mild pitch-preserved speed-up if a clip runs
 *       long), and overwrites the project's video file with the result.
 *
 *       This OVERWRITES the working video in place. A one-time backup of the
 *       pre-AI-voice video is kept automatically, so it can be reverted with
 *       `POST /api/projects/:id/voice/restore`.
 *
 *       Requires a transcript — run `POST /api/projects/:id/process` first.
 *       Poll `GET /api/projects/:id/voice/status` to follow progress.
 *     tags: [Voice]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               voice: { type: string, example: alloy }
 *               model: { type: string, example: gpt-audio-1.5 }
 *     responses:
 *       200:
 *         description: Voice-over generation queued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, example: true }
 *                 status: { type: string, example: queued }
 *       400:
 *         description: No transcript available yet
 *       404:
 *         description: Project not found
 *       409:
 *         description: Voice generation already in progress
 */
projectsRouter.post('/projects/:id/voice', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (VOICE_PROCESSING_STATUSES.has(project.voice_status)) {
    return res.status(409).json({ error: 'Voice generation already in progress' });
  }

  // Voice-over now narrates the AI-generated documentation steps (not the raw
  // transcript), so we need at least one step with timestamps to proceed.
  const steps = listSteps(project.id);
  const readySteps = steps.filter(
    (s) => typeof s.start_seconds === 'number' && typeof s.end_seconds === 'number'
      && ((s.title || '').trim() || (s.body_markdown || '').trim()),
  );
  if (readySteps.length === 0) {
    return res.status(400).json({
      error: 'No documentation steps found — generate the documentation first, then come back to create the voice-over.',
    });
  }

  const voice = req.body?.voice || process.env.TTS_VOICE || DEFAULT_VOICE;
  const model = req.body?.model || process.env.TTS_MODEL || DEFAULT_MODEL;
  const resume = RESUMABLE_PROCESS_STATUSES.has(project.voice_status || '');

  updateProject(project.id, {
    voice_status: 'queued',
    voice_error: null,
    voice_name: voice,
    voice_model: model,
    voice_control_action: null,
  });
  enqueueJob(`voice:${project.id}`, () => generateAiVoiceResumable(project.id, getProject(project.id), { voice, model, resume }));
  res.json({ ok: true, status: 'queued', resume });
});

/**
 * @openapi
 * /api/projects/{id}/voice/status:
 *   get:
 *     summary: Poll AI voice-over generation status
 *     description: |
 *       **Possible voiceStatus values:** `null` (never run) | `generating`
 *       (synthesizing segments) | `stitching` (fitting clips to the timeline)
 *       | `muxing` (combining with video) | `complete` | `failed`.
 *     tags: [Voice]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Current voice generation status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 voiceStatus: { type: string, nullable: true, example: complete }
 *                 voiceError: { type: string, nullable: true }
 *                 voiceName: { type: string, nullable: true, example: alloy }
 *                 voiceModel: { type: string, nullable: true, example: gpt-audio-1.5 }
 *                 voiceGeneratedAt: { type: string, nullable: true }
 *                 canRestore: { type: boolean }
 *       404:
 *         description: Project not found
 */
projectsRouter.get('/projects/:id/voice/status', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const progress = parseProgress(project.voice_progress_json);
  const preview = buildPreview(project.id, project.doc_type);
  const hasUnfinishedGeneration = Boolean(
    progress && project.voice_status && project.voice_status !== 'complete',
  );
  res.json({
    voiceStatus: project.voice_status,
    voiceError: project.voice_error,
    voiceName: project.voice_name,
    voiceModel: project.voice_model,
    voiceGeneratedAt: project.voice_generated_at,
    canRestore: Boolean(project.original_video_backup_path && fs.existsSync(project.original_video_backup_path)),
    progress,
    preview,
    hasUnfinishedGeneration,
    isQueued: isJobQueued(`voice:${project.id}`),
  });
});

projectsRouter.post('/projects/:id/voice/control', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const action = req.body?.action;
  if (!['pause', 'stop', 'resume'].includes(action)) {
    return res.status(400).json({ error: 'action must be one of: pause, stop, resume' });
  }

  if (action === 'resume') {
    if (VOICE_PROCESSING_STATUSES.has(project.voice_status)) {
      return res.status(409).json({ error: 'Voice generation is already active' });
    }
    const voice = project.voice_name || process.env.TTS_VOICE || DEFAULT_VOICE;
    const model = project.voice_model || process.env.TTS_MODEL || DEFAULT_MODEL;
    updateProject(project.id, {
      voice_status: 'queued',
      voice_error: null,
      voice_control_action: null,
    });
    enqueueJob(`voice:${project.id}`, () => generateAiVoiceResumable(project.id, getProject(project.id), {
      voice,
      model,
      resume: true,
    }));
    return res.json({ ok: true, status: 'queued', action: 'resume' });
  }

  if (project.voice_status === 'queued' && cancelQueuedJob(`voice:${project.id}`)) {
    updateProject(project.id, {
      voice_status: action === 'pause' ? 'paused' : 'stopped',
      voice_control_action: null,
      voice_error: null,
    });
    return res.json({ ok: true, status: action === 'pause' ? 'paused' : 'stopped', action });
  }

  if (!VOICE_PROCESSING_STATUSES.has(project.voice_status)) {
    return res.status(409).json({ error: 'Voice generation is not currently active' });
  }

  requestProcessControl(project.id, 'voice', action);
  res.json({ ok: true, status: project.voice_status, action });
});

/**
 * @openapi
 * /api/projects/{id}/voice/restore:
 *   post:
 *     summary: Restore the video's original (pre-AI-voice) audio
 *     description: Reverts the project's video file to the backup taken before the first AI voice-over generation.
 *     tags: [Voice]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Original video restored
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 project: { $ref: '#/components/schemas/Project' }
 *       400:
 *         description: No backup available to restore
 *       404:
 *         description: Project not found
 */
projectsRouter.post('/projects/:id/voice/restore', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (VOICE_PROCESSING_STATUSES.has(project.voice_status)) {
      return res.status(409).json({ error: 'Voice generation already in progress' });
    }
    await restoreOriginalVideo(project.id, project);
    res.json({ project: getProject(project.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Cost / usage ─────────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/projects/{id}/cost:
 *   get:
 *     summary: Get token usage and cost estimate
 *     description: |
 *       Returns per-service token usage recorded during the pipeline run,
 *       a cost estimate in USD, and (for unprocessed projects with a known
 *       duration) a pre-run cost estimate.
 *
 *       Costs are estimates based on public OpenAI pricing and may not
 *       reflect your exact billed amount.
 *     tags: [Projects]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: proj_abc123
 *     responses:
 *       200:
 *         description: Usage and cost data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 usage:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/UsageRecord' }
 *                 estimate:
 *                   $ref: '#/components/schemas/CostEstimate'
 *                 pre_run_estimate:
 *                   nullable: true
 *                   type: object
 *                   description: Only present for uploaded-but-not-yet-processed projects
 *                   properties:
 *                     whisper_usd: { type: number }
 *                     text_usd:    { type: number }
 *                     note:        { type: string }
 *             example:
 *               usage:
 *                 - service: whisper
 *                   model: whisper-1
 *                   input_tokens: 143
 *                   output_tokens: 0
 *                 - service: text
 *                   model: gpt-4.5-preview
 *                   input_tokens: 3100
 *                   output_tokens: 820
 *               estimate:
 *                 whisper_usd: 0.014
 *                 text_usd: 0.22
 *                 vision_usd: 0.09
 *                 total_usd: 0.324
 *               pre_run_estimate: null
 *       404:
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
projectsRouter.get('/projects/:id/cost', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const estimate = estimateProjectCost(project.id);
  const usage = getProjectUsage(project.id);

  let preRunEstimate = null;
  if (project.duration_seconds && project.status === 'uploaded') {
    const minutes = project.duration_seconds / 60;
    preRunEstimate = {
      whisper_usd: minutes * 0.006,
      text_usd: (project.duration_seconds / 30) * 0.05,
      note: 'Pre-run estimate only. Actual cost depends on video content.',
    };
  }

  res.json({ usage, estimate, pre_run_estimate: preRunEstimate });
});

// ─── Step editing ─────────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/projects/{id}/steps/{stepId}:
 *   patch:
 *     summary: Update a step
 *     description: |
 *       Edits one or more fields on a step. Only the fields you include are
 *       updated; omitted fields are left unchanged.
 *
 *       Editable fields: `title`, `body_markdown`, `start_seconds`,
 *       `end_seconds`, `screenshot_frame_id`.
 *
 *       The previous version is automatically saved to step history before
 *       the update is applied, so you can restore it with
 *       `POST /api/projects/:id/steps/:stepId/restore/:historyId`.
 *     tags: [Steps]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: proj_abc123
 *       - in: path
 *         name: stepId
 *         required: true
 *         schema: { type: string }
 *         example: step_xyz789
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:               { type: string, example: Open the Members settings }
 *               body_markdown:       { type: string, example: Click **Settings** then **Members**. }
 *               start_seconds:       { type: number, example: 4.2 }
 *               end_seconds:         { type: number, example: 18.7 }
 *               screenshot_frame_id: { type: string, nullable: true, example: frame_001 }
 *     responses:
 *       200:
 *         description: Updated step
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 step: { $ref: '#/components/schemas/Step' }
 */
projectsRouter.patch('/projects/:id/steps/:stepId', (req, res) => {
  const allowed = ['title', 'body_markdown', 'start_seconds', 'end_seconds', 'screenshot_frame_id'];
  const fields = {};
  for (const key of allowed) {
    if (key in req.body) fields[key] = req.body[key];
  }
  const updated = updateStep(req.params.stepId, fields);
  res.json({ step: updated });
});

/**
 * @openapi
 * /api/projects/{id}/steps/{stepId}:
 *   delete:
 *     summary: Delete a step
 *     tags: [Steps]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: stepId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Step deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, example: true }
 */
projectsRouter.delete('/projects/:id/steps/:stepId', (req, res) => {
  deleteStep(req.params.stepId);
  res.json({ ok: true });
});

/**
 * @openapi
 * /api/projects/{id}/steps:
 *   post:
 *     summary: Add a new step
 *     description: Inserts a new step at the end of the project's step list.
 *     tags: [Steps]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: proj_abc123
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:               { type: string, example: Confirm the invitation email }
 *               body_markdown:       { type: string }
 *               start_seconds:       { type: number, nullable: true }
 *               end_seconds:         { type: number, nullable: true }
 *               screenshot_frame_id: { type: string, nullable: true }
 *     responses:
 *       201:
 *         description: Step created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 step: { $ref: '#/components/schemas/Step' }
 */
projectsRouter.post('/projects/:id/steps', (req, res) => {
  const steps = listSteps(req.params.id);
  const newStep = insertStep(req.params.id, {
    stepOrder: steps.length,
    title: req.body.title || 'New step',
    bodyMarkdown: req.body.body_markdown || '',
    startSeconds: req.body.start_seconds ?? null,
    endSeconds: req.body.end_seconds ?? null,
    screenshotFrameId: req.body.screenshot_frame_id ?? null,
  });
  res.status(201).json({ step: newStep });
});

/**
 * @openapi
 * /api/projects/{id}/steps/reorder:
 *   post:
 *     summary: Reorder steps
 *     description: Reorders all steps in a project. You must provide the complete ordered list of step IDs.
 *     tags: [Steps]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: proj_abc123
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [orderedIds]
 *             properties:
 *               orderedIds:
 *                 type: array
 *                 items: { type: string }
 *                 description: All step IDs in the desired order
 *                 example: [step_c, step_a, step_b]
 *     responses:
 *       200:
 *         description: Steps in new order
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 steps:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Step' }
 *       400:
 *         description: orderedIds must be an array
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
projectsRouter.post('/projects/:id/steps/reorder', (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds must be an array' });
  const steps = reorderSteps(req.params.id, orderedIds);
  res.json({ steps });
});

// ─── Step version history ─────────────────────────────────────────────────────

/**
 * @openapi
 * /api/projects/{id}/steps/{stepId}/history:
 *   get:
 *     summary: Get step edit history
 *     description: Returns all saved versions of a step, newest first. Each edit to a step automatically creates a history entry before the change is applied.
 *     tags: [Steps]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: stepId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: History entries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 history:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/StepHistoryEntry' }
 */
projectsRouter.get('/projects/:id/steps/:stepId/history', (req, res) => {
  const history = listStepHistory(req.params.stepId);
  res.json({ history });
});

/**
 * @openapi
 * /api/projects/{id}/steps/{stepId}/restore/{historyId}:
 *   post:
 *     summary: Restore a step to a previous version
 *     description: Overwrites the step's `title` and `body_markdown` with the values from the specified history entry. The restored content itself creates a new history entry.
 *     tags: [Steps]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: stepId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: historyId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Step restored
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 step: { $ref: '#/components/schemas/Step' }
 *       404:
 *         description: History entry not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
projectsRouter.post('/projects/:id/steps/:stepId/restore/:historyId', (req, res) => {
  const entry = getStepHistoryEntry(req.params.historyId);
  if (!entry || entry.step_id !== req.params.stepId) {
    return res.status(404).json({ error: 'History entry not found' });
  }
  const updated = updateStep(req.params.stepId, {
    title: entry.title,
    body_markdown: entry.body_markdown,
  });
  res.json({ step: updated });
});

// ─── Screenshot capture ───────────────────────────────────────────────────────

/**
 * @openapi
 * /api/projects/{id}/steps/{stepId}/capture-frame:
 *   post:
 *     summary: Manually capture a screenshot for a step
 *     description: |
 *       Extracts a single frame from the video at the given timestamp,
 *       saves it to disk, creates a Frame record, and assigns it to the step.
 *       Use this to replace an auto-selected screenshot with one you've
 *       chosen by scrubbing through the video player.
 *     tags: [Screenshots]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: proj_abc123
 *       - in: path
 *         name: stepId
 *         required: true
 *         schema: { type: string }
 *         example: step_xyz789
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [timestampSeconds]
 *             properties:
 *               timestampSeconds:
 *                 type: number
 *                 description: Position in the video (seconds) to extract the frame from
 *                 example: 11.4
 *     responses:
 *       200:
 *         description: Frame captured and assigned to the step
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 frame: { $ref: '#/components/schemas/Frame' }
 *                 step:  { $ref: '#/components/schemas/Step' }
 *       400:
 *         description: timestampSeconds is required
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       404:
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       500:
 *         description: ffmpeg extraction failed
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
projectsRouter.post('/projects/:id/steps/:stepId/capture-frame', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { timestampSeconds } = req.body;
    if (typeof timestampSeconds !== 'number') {
      return res.status(400).json({ error: 'timestampSeconds (number) is required' });
    }

    const framesDir = path.join(process.cwd(), 'storage', 'frames', project.id);
    fs.mkdirSync(framesDir, { recursive: true });
    const outputPath = path.join(framesDir, `manual_${Date.now()}.jpg`);

    await extractFrameAtTimestamp(project.video_path, timestampSeconds, outputPath);
    const frame = insertFrame(project.id, { timestampSeconds, filePath: outputPath, source: 'manual' });
    const step = updateStep(req.params.stepId, { screenshot_frame_id: frame.id });

    res.json({ frame, step });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @openapi
 * /api/projects/{id}/frames:
 *   get:
 *     summary: List all extracted frames for a project
 *     description: Returns every frame extracted during the pipeline (scene-change detection) plus any manually captured frames, ordered by timestamp.
 *     tags: [Screenshots]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: proj_abc123
 *     responses:
 *       200:
 *         description: Frame list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 frames:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Frame' }
 */
projectsRouter.get('/projects/:id/frames', (req, res) => {
  res.json({ frames: listFrames(req.params.id) });
});

/**
 * @openapi
 * /api/frames/{frameId}/image:
 *   get:
 *     summary: Serve a frame's JPEG image
 *     description: |
 *       Returns the raw JPEG bytes for a single frame. This URL is used
 *       in generated Markdown and PDF exports so screenshots render
 *       correctly in any viewer that can reach the server.
 *     tags: [Screenshots]
 *     parameters:
 *       - in: path
 *         name: frameId
 *         required: true
 *         schema: { type: string }
 *         example: frame_001
 *     responses:
 *       200:
 *         description: JPEG image bytes
 *         content:
 *           image/jpeg: {}
 *       404:
 *         description: Frame not found or file missing on disk
 */
projectsRouter.get('/frames/:frameId/image', (req, res) => {
  const frame = getFrame(req.params.frameId);
  if (!frame || !fs.existsSync(frame.file_path)) return res.status(404).end();
  res.sendFile(frame.file_path);
});

// ─── Talking-head presenter ───────────────────────────────────────────────────

projectsRouter.post('/projects/:id/talking-head', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (TALKING_HEAD_PROCESSING_STATUSES.has(project.talking_head_status)) {
      return res.status(409).json({ error: 'Talking-head generation already in progress' });
    }

    const voice = req.body?.voice || project.voice_name || process.env.TTS_VOICE || DEFAULT_VOICE;
    const model = req.body?.model || project.voice_model || process.env.TTS_MODEL || DEFAULT_MODEL;
    const resume = RESUMABLE_PROCESS_STATUSES.has(project.talking_head_status || '');

    updateProject(project.id, {
      talking_head_status: 'queued',
      talking_head_error: null,
      talking_head_control_action: null,
      voice_name: voice,
      voice_model: model,
    });
    enqueueJob(`talking-head:${project.id}`, () => generateTalkingHeadResumable(project.id, getProject(project.id), {
      voice,
      model,
      resume,
    }));
    res.json({ ok: true, message: 'Talking-head generation enqueued', resume });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.get('/projects/:id/talking-head/status', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const canRestore = Boolean(
    project.talking_head_backup_path &&
    fs.existsSync(project.talking_head_backup_path),
  );

  // Count persisted raw Replicate clips so the client can surface a
  // "N chunk(s) saved" badge without an extra round-trip.
  let savedChunkCount = 0;
  const chunksDir = project.talking_head_chunks_dir;
  if (chunksDir && fs.existsSync(chunksDir)) {
    try {
      savedChunkCount = fs.readdirSync(chunksDir).filter((f) => f.endsWith('.mp4')).length;
    } catch { /* non-fatal */ }
  }

  res.json({
    talkingHeadStatus:      project.talking_head_status || null,
    talkingHeadError:       project.talking_head_error || null,
    talkingHeadGeneratedAt: project.talking_head_generated_at || null,
    talkingHeadVoice:       project.voice_name || null,
    canRestore,
    savedChunkCount,
    chunksDir: chunksDir || null,
    progress: parseProgress(project.talking_head_progress_json),
    preview: buildPreview(project.id, project.doc_type),
    hasUnfinishedGeneration: Boolean(
      parseProgress(project.talking_head_progress_json) &&
      project.talking_head_status &&
      project.talking_head_status !== 'complete',
    ),
    isQueued: isJobQueued(`talking-head:${project.id}`),
  });
});

projectsRouter.post('/projects/:id/talking-head/control', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const action = req.body?.action;
  if (!['pause', 'stop', 'resume'].includes(action)) {
    return res.status(400).json({ error: 'action must be one of: pause, stop, resume' });
  }

  if (action === 'resume') {
    if (TALKING_HEAD_PROCESSING_STATUSES.has(project.talking_head_status)) {
      return res.status(409).json({ error: 'Talking-head generation is already active' });
    }
    const voice = project.voice_name || process.env.TTS_VOICE || DEFAULT_VOICE;
    const model = project.voice_model || process.env.TTS_MODEL || DEFAULT_MODEL;
    updateProject(project.id, {
      talking_head_status: 'queued',
      talking_head_error: null,
      talking_head_control_action: null,
    });
    enqueueJob(`talking-head:${project.id}`, () => generateTalkingHeadResumable(project.id, getProject(project.id), {
      voice,
      model,
      resume: true,
    }));
    return res.json({ ok: true, status: 'queued', action: 'resume' });
  }

  if (project.talking_head_status === 'queued' && cancelQueuedJob(`talking-head:${project.id}`)) {
    updateProject(project.id, {
      talking_head_status: action === 'pause' ? 'paused' : 'stopped',
      talking_head_control_action: null,
      talking_head_error: null,
    });
    return res.json({ ok: true, status: action === 'pause' ? 'paused' : 'stopped', action });
  }

  if (!TALKING_HEAD_PROCESSING_STATUSES.has(project.talking_head_status)) {
    return res.status(409).json({ error: 'Talking-head generation is not currently active' });
  }

  requestProcessControl(project.id, 'talking_head', action);
  res.json({ ok: true, status: project.talking_head_status, action });
});

projectsRouter.post('/projects/:id/talking-head/restore', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (TALKING_HEAD_PROCESSING_STATUSES.has(project.talking_head_status)) {
      return res.status(409).json({ error: 'Cannot restore while generation is in progress' });
    }

    await restoreTalkingHeadVideo(project.id, project);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @openapi
 * /api/projects/{id}/talking-head/chunks:
 *   get:
 *     summary: List saved raw Replicate clips for this project
 *     description: |
 *       Returns metadata for every raw talking-head clip that was persisted
 *       from Replicate during generation. Each entry includes a `downloadUrl`
 *       so you can fetch the clip directly. Clips survive pipeline failures
 *       and workDir cleanup — use them to manually review or re-edit
 *       individual segments without re-paying for generation.
 *     tags: [Talking Head]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of saved chunks
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 chunksDir: { type: string }
 *                 chunks:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       filename:    { type: string }
 *                       sizeBytes:   { type: integer }
 *                       createdAt:   { type: string, format: date-time }
 *                       downloadUrl: { type: string }
 *       404:
 *         description: Project not found or no chunks saved yet
 */
projectsRouter.get('/projects/:id/talking-head/chunks', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const chunksDir = project.talking_head_chunks_dir;
  if (!chunksDir || !fs.existsSync(chunksDir)) {
    return res.json({ chunksDir: chunksDir || null, chunks: [] });
  }

  const entries = fs.readdirSync(chunksDir)
    .filter((f) => f.endsWith('.mp4'))
    .map((filename) => {
      const filePath = path.join(chunksDir, filename);
      const stat = fs.statSync(filePath);
      return {
        filename,
        sizeBytes: stat.size,
        createdAt: stat.birthtime.toISOString(),
        downloadUrl: `/api/projects/${req.params.id}/talking-head/chunks/${encodeURIComponent(filename)}`,
      };
    })
    .sort((a, b) => a.filename.localeCompare(b.filename));

  res.json({ chunksDir, chunks: entries });
});

/**
 * @openapi
 * /api/projects/{id}/talking-head/chunks/{filename}:
 *   get:
 *     summary: Download a single saved raw Replicate clip
 *     tags: [Talking Head]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: filename
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The raw MP4 clip
 *         content:
 *           video/mp4:
 *             schema: { type: string, format: binary }
 *       404:
 *         description: Chunk not found
 */
projectsRouter.get('/projects/:id/talking-head/chunks/:filename', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const chunksDir = project.talking_head_chunks_dir;
  if (!chunksDir) return res.status(404).json({ error: 'No chunks saved for this project' });

  // Sanitise filename: strip any path traversal attempts.
  const safeName = path.basename(req.params.filename);
  const filePath = path.join(chunksDir, safeName);

  if (!filePath.startsWith(chunksDir) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Chunk not found' });
  }

  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.setHeader('Content-Type', 'video/mp4');
  res.sendFile(filePath);
});
