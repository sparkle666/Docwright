import { db } from './database.js';
import { nanoid } from 'nanoid';

// ─── Projects ────────────────────────────────────────────────────────────────

export function createProject({ title, docType }) {
  const id = nanoid();
  db.prepare(`
    INSERT INTO projects (id, title, doc_type, status)
    VALUES (?, ?, ?, 'created')
  `).run(id, title, docType);
  return getProject(id);
}

export function getProject(id) {
  return db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id);
}

export function listProjects() {
  return db.prepare(`SELECT * FROM projects ORDER BY created_at DESC`).all();
}

export function updateProject(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return getProject(id);
  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => fields[k]);
  db.prepare(`
    UPDATE projects SET ${setClause}, updated_at = datetime('now') WHERE id = ?
  `).run(...values, id);
  return getProject(id);
}

export function deleteProject(id) {
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
}

export function setProjectStatus(id, status, errorMessage = null) {
  return updateProject(id, { status, error_message: errorMessage });
}

// ─── Transcripts ─────────────────────────────────────────────────────────────

export function saveTranscript(projectId, { rawJson, fullText }) {
  const id = nanoid();
  // Remove any existing transcript before inserting (idempotent re-runs)
  db.prepare(`DELETE FROM transcripts WHERE project_id = ?`).run(projectId);
  db.prepare(`
    INSERT INTO transcripts (id, project_id, raw_json, full_text)
    VALUES (?, ?, ?, ?)
  `).run(id, projectId, JSON.stringify(rawJson), fullText);
  return getTranscript(projectId);
}

export function getTranscript(projectId) {
  const row = db.prepare(`
    SELECT * FROM transcripts WHERE project_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(projectId);
  if (!row) return null;
  return { ...row, raw_json: JSON.parse(row.raw_json) };
}

/**
 * Apply user edits to the transcript's segments (e.g. fixing a mis-transcribed
 * product name or UI label) without touching word-level data or re-running
 * Whisper. Segments are matched by `id`; unmatched segments are left as-is.
 * full_text is rebuilt by joining the (possibly edited) segment texts so it
 * stays consistent with what doc generation will actually see.
 *
 * @param {string} projectId
 * @param {Array<{id: number|string, text: string}>} editedSegments
 */
export function updateTranscriptSegments(projectId, editedSegments) {
  const transcript = getTranscript(projectId);
  if (!transcript) return null;

  const editsById = new Map(editedSegments.map((s) => [String(s.id), s.text]));

  const segments = (transcript.raw_json.segments || []).map((seg) => {
    const editedText = editsById.get(String(seg.id));
    return editedText !== undefined ? { ...seg, text: editedText } : seg;
  });

  const rawJson = { ...transcript.raw_json, segments };
  const fullText = segments.map((s) => s.text).join(' ').trim();

  db.prepare(`
    UPDATE transcripts SET raw_json = ?, full_text = ?, is_edited = 1 WHERE id = ?
  `).run(JSON.stringify(rawJson), fullText, transcript.id);

  return getTranscript(projectId);
}

// ─── Frames ──────────────────────────────────────────────────────────────────

export function insertFrame(projectId, { timestampSeconds, filePath, source = 'auto', changeScore = null, sharpness = null }) {
  const id = nanoid();
  db.prepare(`
    INSERT INTO frames (id, project_id, timestamp_seconds, file_path, source, change_score, sharpness)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, projectId, timestampSeconds, filePath, source, changeScore, sharpness);
  return getFrame(id);
}

export function getFrame(id) {
  return db.prepare(`SELECT * FROM frames WHERE id = ?`).get(id);
}

export function listFrames(projectId) {
  return db.prepare(`
    SELECT * FROM frames WHERE project_id = ? ORDER BY timestamp_seconds ASC
  `).all(projectId);
}

export function deleteFrame(id) {
  db.prepare(`DELETE FROM frames WHERE id = ?`).run(id);
}

export function deleteFramesByProject(projectId) {
  db.prepare(`DELETE FROM frames WHERE project_id = ?`).run(projectId);
}

// ─── Doc Steps ───────────────────────────────────────────────────────────────

export function insertStep(projectId, step) {
  const id = nanoid();
  db.prepare(`
    INSERT INTO doc_steps
      (id, project_id, step_order, title, body_markdown, start_seconds, end_seconds, screenshot_frame_id, screenshot_rationale)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, projectId, step.stepOrder, step.title, step.bodyMarkdown,
    step.startSeconds ?? null, step.endSeconds ?? null,
    step.screenshotFrameId ?? null, step.screenshotRationale ?? null,
  );
  return getStep(id);
}

export function getStep(id) {
  return db.prepare(`SELECT * FROM doc_steps WHERE id = ?`).get(id);
}

export function listSteps(projectId) {
  return db.prepare(`
    SELECT * FROM doc_steps WHERE project_id = ? ORDER BY step_order ASC
  `).all(projectId);
}

export function updateStep(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return getStep(id);

  // Before updating, snapshot the current state into history
  const current = getStep(id);
  if (current && (fields.title !== undefined || fields.body_markdown !== undefined)) {
    snapshotStepHistory(current);
  }

  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => fields[k]);
  db.prepare(`
    UPDATE doc_steps SET ${setClause}, updated_at = datetime('now') WHERE id = ?
  `).run(...values, id);
  return getStep(id);
}

export function deleteStep(id) {
  db.prepare(`DELETE FROM doc_steps WHERE id = ?`).run(id);
}

export function reorderSteps(projectId, orderedIds) {
  const stmt = db.prepare(`UPDATE doc_steps SET step_order = ? WHERE id = ? AND project_id = ?`);
  const txn = db.transaction((ids) => {
    ids.forEach((stepId, index) => stmt.run(index, stepId, projectId));
  });
  txn(orderedIds);
  return listSteps(projectId);
}

export function clearStepsForProject(projectId) {
  db.prepare(`DELETE FROM doc_steps WHERE project_id = ?`).run(projectId);
}

// ─── Doc Step History ────────────────────────────────────────────────────────

function snapshotStepHistory(step) {
  db.prepare(`
    INSERT INTO doc_step_history (id, step_id, project_id, title, body_markdown)
    VALUES (?, ?, ?, ?, ?)
  `).run(nanoid(), step.id, step.project_id, step.title, step.body_markdown);
}

export function listStepHistory(stepId) {
  return db.prepare(`
    SELECT * FROM doc_step_history WHERE step_id = ? ORDER BY saved_at DESC LIMIT 20
  `).all(stepId);
}

export function getStepHistoryEntry(historyId) {
  return db.prepare(`SELECT * FROM doc_step_history WHERE id = ?`).get(historyId);
}

// ─── Doc Meta ────────────────────────────────────────────────────────────────

export function upsertDocMeta(projectId, { summary, prerequisites, audience }) {
  db.prepare(`
    INSERT INTO doc_meta (project_id, summary, prerequisites, audience)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      summary = excluded.summary,
      prerequisites = excluded.prerequisites,
      audience = excluded.audience
  `).run(projectId, summary, prerequisites, audience);
  return getDocMeta(projectId);
}

export function getDocMeta(projectId) {
  return db.prepare(`SELECT * FROM doc_meta WHERE project_id = ?`).get(projectId);
}

// ─── Usage Log (cost tracking) ───────────────────────────────────────────────

export function logUsage(projectId, { service, model, inputTokens = 0, outputTokens = 0 }) {
  db.prepare(`
    INSERT INTO usage_log (id, project_id, service, model, input_tokens, output_tokens)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(nanoid(), projectId, service, model, inputTokens, outputTokens);
}

export function getProjectUsage(projectId) {
  return db.prepare(`
    SELECT * FROM usage_log WHERE project_id = ? ORDER BY created_at ASC
  `).all(projectId);
}

/**
 * Rough cost estimate based on current OpenAI pricing (dollars).
 * These are approximations — always check openai.com/pricing for up-to-date rates.
 */
const COST_PER_1K = {
  'whisper-1':     { input: 0.006, output: 0 },       // per minute, not tokens — handled separately
  'gpt-5.5':       { input: 0.005, output: 0.030 },   // GPT-5.5 pricing
  'gpt-5.4':       { input: 0.0025, output: 0.015 },  // GPT-5.4 pricing
  'gpt-5.4-mini':  { input: 0.00075, output: 0.0045 }, // GPT-5.4 mini pricing
  'gpt-4o':        { input: 0.005, output: 0.015 },
  'gpt-4o-mini':   { input: 0.00015, output: 0.0006 },
  // gpt-audio-1.5: text tokens at the standard text rate, audio (output)
  // tokens at $64/1M — this is what voice-over generation logs against.
  'gpt-audio-1.5': { input: 0.0025, output: 0.064 },
};

export function estimateProjectCost(projectId) {
  const rows = getProjectUsage(projectId);
  let totalUsd = 0;
  const breakdown = rows.map((row) => {
    const rates = COST_PER_1K[row.model] ?? { input: 0, output: 0 };
    const cost = (row.input_tokens / 1000) * rates.input +
                 (row.output_tokens / 1000) * rates.output;
    totalUsd += cost;
    return { ...row, estimated_cost_usd: cost };
  });
  return { breakdown, total_usd: totalUsd };
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export function registerWebhook({ url, secret = null }) {
  const id = nanoid();
  db.prepare(`
    INSERT INTO webhooks (id, url, secret) VALUES (?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET secret = excluded.secret
  `).run(id, url, secret);
  return db.prepare(`SELECT * FROM webhooks WHERE url = ?`).get(url);
}

export function listWebhooks() {
  return db.prepare(`SELECT * FROM webhooks ORDER BY created_at ASC`).all();
}

export function deleteWebhook(id) {
  db.prepare(`DELETE FROM webhooks WHERE id = ?`).run(id);
}

// ─── Project reset (idempotent re-run) ────────────────────────────────────────

/**
 * Wipes all derived data for a project so the pipeline can re-run cleanly.
 * Does NOT delete the project row or the uploaded video.
 */
export function resetProjectData(projectId) {
  db.transaction(() => {
    db.prepare(`DELETE FROM doc_step_history WHERE project_id = ?`).run(projectId);
    db.prepare(`DELETE FROM doc_steps WHERE project_id = ?`).run(projectId);
    db.prepare(`DELETE FROM frames WHERE project_id = ?`).run(projectId);
    db.prepare(`DELETE FROM transcripts WHERE project_id = ?`).run(projectId);
    db.prepare(`DELETE FROM doc_meta WHERE project_id = ?`).run(projectId);
    db.prepare(`DELETE FROM usage_log WHERE project_id = ?`).run(projectId);
    db.prepare(`
      UPDATE projects SET status = 'uploaded', error_message = NULL, audio_path = NULL,
      updated_at = datetime('now') WHERE id = ?
    `).run(projectId);
  })();
}
