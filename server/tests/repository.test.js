/**
 * Unit tests for db/repository.js using an in-memory SQLite database.
 * Run with: npm test
 */

import { jest } from '@jest/globals';

// ── Inject an in-memory DB before any module loads ──────────────────────────
// We mock the database module so repository.js uses `:memory:` instead of
// writing a real file to disk.
const mockDb = await (async () => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
})();

jest.unstable_mockModule('../src/db/database.js', () => ({
  db: mockDb,
  initSchema: () => {},
}));

// ── Now import the real modules (they will pick up the mocked db) ────────────
const {
  createProject, getProject, listProjects, updateProject, deleteProject,
  setProjectStatus, saveTranscript, getTranscript, updateTranscriptSegments,
  insertFrame, getFrame, listFrames, deleteFramesByProject,
  insertStep, getStep, listSteps, updateStep, deleteStep, reorderSteps,
  clearStepsForProject, listStepHistory,
  upsertDocMeta, getDocMeta,
  logUsage, getProjectUsage, estimateProjectCost,
  registerWebhook, listWebhooks, deleteWebhook,
  resetProjectData,
} = await import('../src/db/repository.js');

// ── Bootstrap schema in the in-memory DB ─────────────────────────────────────
// (We can't call initSchema from the mock, so run the SQL directly)
mockDb.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, doc_type TEXT NOT NULL DEFAULT 'step_by_step',
    status TEXT NOT NULL DEFAULT 'created', video_path TEXT, audio_path TEXT,
    duration_seconds REAL, error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS transcripts (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    raw_json TEXT NOT NULL, full_text TEXT NOT NULL, is_edited INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS frames (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    timestamp_seconds REAL NOT NULL, file_path TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'auto', change_score REAL, sharpness REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS doc_steps (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    step_order INTEGER NOT NULL, title TEXT NOT NULL, body_markdown TEXT NOT NULL,
    start_seconds REAL, end_seconds REAL,
    screenshot_frame_id TEXT REFERENCES frames(id) ON DELETE SET NULL,
    screenshot_rationale TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS doc_meta (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    summary TEXT, prerequisites TEXT, audience TEXT
  );
  CREATE TABLE IF NOT EXISTS usage_log (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    service TEXT NOT NULL, model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS doc_step_history (
    id TEXT PRIMARY KEY, step_id TEXT NOT NULL REFERENCES doc_steps(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL, body_markdown TEXT NOT NULL,
    saved_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, secret TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ─── Helper ───────────────────────────────────────────────────────────────────
function makeProject(overrides = {}) {
  return createProject({ title: 'Test Project', docType: 'step_by_step', ...overrides });
}

// ─── Projects ─────────────────────────────────────────────────────────────────
describe('Projects', () => {
  test('createProject returns a project with correct fields', () => {
    const p = makeProject({ title: 'My video', docType: 'sop' });
    expect(p.id).toBeTruthy();
    expect(p.title).toBe('My video');
    expect(p.doc_type).toBe('sop');
    expect(p.status).toBe('created');
  });

  test('getProject returns null for unknown id', () => {
    expect(getProject('does-not-exist')).toBeUndefined();
  });

  test('listProjects includes newly created project', () => {
    const p = makeProject();
    const all = listProjects();
    expect(all.some((x) => x.id === p.id)).toBe(true);
  });

  test('updateProject changes fields', () => {
    const p = makeProject();
    const updated = updateProject(p.id, { status: 'transcribing', duration_seconds: 42.5 });
    expect(updated.status).toBe('transcribing');
    expect(updated.duration_seconds).toBe(42.5);
  });

  test('setProjectStatus sets status and error_message', () => {
    const p = makeProject();
    setProjectStatus(p.id, 'failed', 'ffmpeg died');
    const fetched = getProject(p.id);
    expect(fetched.status).toBe('failed');
    expect(fetched.error_message).toBe('ffmpeg died');
  });

  test('deleteProject removes project', () => {
    const p = makeProject();
    deleteProject(p.id);
    expect(getProject(p.id)).toBeUndefined();
  });
});

// ─── Transcripts ──────────────────────────────────────────────────────────────
describe('Transcripts', () => {
  test('saveTranscript and getTranscript round-trip', () => {
    const p = makeProject();
    const raw = { segments: [{ start: 0, text: 'hello' }] };
    saveTranscript(p.id, { rawJson: raw, fullText: 'hello' });
    const t = getTranscript(p.id);
    expect(t.full_text).toBe('hello');
    expect(t.raw_json.segments[0].text).toBe('hello');
  });

  test('saveTranscript is idempotent (re-run replaces old transcript)', () => {
    const p = makeProject();
    saveTranscript(p.id, { rawJson: {}, fullText: 'first' });
    saveTranscript(p.id, { rawJson: {}, fullText: 'second' });
    const t = getTranscript(p.id);
    expect(t.full_text).toBe('second');
  });

  test('getTranscript returns null for project with no transcript', () => {
    const p = makeProject();
    expect(getTranscript(p.id)).toBeNull();
  });

  test('updateTranscriptSegments edits matched segments by id and rebuilds full_text', () => {
    const p = makeProject();
    const raw = {
      segments: [
        { id: 0, start: 0, end: 2, text: 'Click the Acme Dashbord icon' },
        { id: 1, start: 2, end: 5, text: 'Then open settings' },
      ],
    };
    saveTranscript(p.id, { rawJson: raw, fullText: 'Click the Acme Dashbord icon Then open settings' });

    const updated = updateTranscriptSegments(p.id, [{ id: 0, text: 'Click the Acme Dashboard icon' }]);

    expect(updated.raw_json.segments[0].text).toBe('Click the Acme Dashboard icon');
    // Untouched segment and its timestamps are preserved
    expect(updated.raw_json.segments[1].text).toBe('Then open settings');
    expect(updated.raw_json.segments[1].start).toBe(2);
    expect(updated.full_text).toBe('Click the Acme Dashboard icon Then open settings');
    expect(updated.is_edited).toBe(1);
  });

  test('updateTranscriptSegments returns null when no transcript exists', () => {
    const p = makeProject();
    expect(updateTranscriptSegments(p.id, [{ id: 0, text: 'x' }])).toBeNull();
  });
});

// ─── Frames ───────────────────────────────────────────────────────────────────
describe('Frames', () => {
  test('insertFrame and getFrame work', () => {
    const p = makeProject();
    const f = insertFrame(p.id, { timestampSeconds: 12.5, filePath: '/tmp/f.jpg' });
    expect(f.id).toBeTruthy();
    expect(f.timestamp_seconds).toBe(12.5);
    const fetched = getFrame(f.id);
    expect(fetched.file_path).toBe('/tmp/f.jpg');
  });

  test('listFrames returns frames ordered by timestamp', () => {
    const p = makeProject();
    insertFrame(p.id, { timestampSeconds: 20, filePath: '/a.jpg' });
    insertFrame(p.id, { timestampSeconds: 5,  filePath: '/b.jpg' });
    const frames = listFrames(p.id);
    expect(frames[0].timestamp_seconds).toBe(5);
    expect(frames[1].timestamp_seconds).toBe(20);
  });

  test('deleteFramesByProject removes all project frames', () => {
    const p = makeProject();
    insertFrame(p.id, { timestampSeconds: 1, filePath: '/x.jpg' });
    insertFrame(p.id, { timestampSeconds: 2, filePath: '/y.jpg' });
    deleteFramesByProject(p.id);
    expect(listFrames(p.id)).toHaveLength(0);
  });
});

// ─── Doc Steps ────────────────────────────────────────────────────────────────
describe('Doc Steps', () => {
  test('insertStep and getStep work', () => {
    const p = makeProject();
    const s = insertStep(p.id, { stepOrder: 0, title: 'Open app', bodyMarkdown: '**Click** the icon.', startSeconds: 0, endSeconds: 5 });
    expect(s.title).toBe('Open app');
    expect(getStep(s.id).body_markdown).toBe('**Click** the icon.');
  });

  test('listSteps returns steps in order', () => {
    const p = makeProject();
    insertStep(p.id, { stepOrder: 1, title: 'Step B', bodyMarkdown: '' });
    insertStep(p.id, { stepOrder: 0, title: 'Step A', bodyMarkdown: '' });
    const steps = listSteps(p.id);
    expect(steps[0].title).toBe('Step A');
    expect(steps[1].title).toBe('Step B');
  });

  test('updateStep saves a history snapshot', () => {
    const p = makeProject();
    const s = insertStep(p.id, { stepOrder: 0, title: 'Original', bodyMarkdown: 'old body' });
    updateStep(s.id, { title: 'Updated' });
    const history = listStepHistory(s.id);
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].title).toBe('Original');
  });

  test('reorderSteps updates step_order values', () => {
    const p = makeProject();
    const a = insertStep(p.id, { stepOrder: 0, title: 'A', bodyMarkdown: '' });
    const b = insertStep(p.id, { stepOrder: 1, title: 'B', bodyMarkdown: '' });
    reorderSteps(p.id, [b.id, a.id]);
    const steps = listSteps(p.id);
    expect(steps[0].title).toBe('B');
    expect(steps[1].title).toBe('A');
  });

  test('deleteStep removes step', () => {
    const p = makeProject();
    const s = insertStep(p.id, { stepOrder: 0, title: 'Bye', bodyMarkdown: '' });
    deleteStep(s.id);
    expect(getStep(s.id)).toBeUndefined();
  });

  test('clearStepsForProject removes all steps', () => {
    const p = makeProject();
    insertStep(p.id, { stepOrder: 0, title: 'X', bodyMarkdown: '' });
    insertStep(p.id, { stepOrder: 1, title: 'Y', bodyMarkdown: '' });
    clearStepsForProject(p.id);
    expect(listSteps(p.id)).toHaveLength(0);
  });
});

// ─── Doc Meta ─────────────────────────────────────────────────────────────────
describe('Doc Meta', () => {
  test('upsertDocMeta and getDocMeta round-trip', () => {
    const p = makeProject();
    upsertDocMeta(p.id, { summary: 'A summary', prerequisites: 'None', audience: 'Developers' });
    const m = getDocMeta(p.id);
    expect(m.summary).toBe('A summary');
    expect(m.audience).toBe('Developers');
  });

  test('upsertDocMeta overwrites on re-run', () => {
    const p = makeProject();
    upsertDocMeta(p.id, { summary: 'First', prerequisites: '', audience: '' });
    upsertDocMeta(p.id, { summary: 'Second', prerequisites: '', audience: '' });
    expect(getDocMeta(p.id).summary).toBe('Second');
  });
});

// ─── Usage Log ────────────────────────────────────────────────────────────────
describe('Usage Log', () => {
  test('logUsage and getProjectUsage work', () => {
    const p = makeProject();
    logUsage(p.id, { service: 'text', model: 'gpt-4o', inputTokens: 1000, outputTokens: 200 });
    const rows = getProjectUsage(p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBe(1000);
  });

  test('estimateProjectCost calculates a non-negative total', () => {
    const p = makeProject();
    logUsage(p.id, { service: 'text', model: 'gpt-4o', inputTokens: 5000, outputTokens: 500 });
    const { total_usd } = estimateProjectCost(p.id);
    expect(total_usd).toBeGreaterThan(0);
  });
});

// ─── Webhooks ─────────────────────────────────────────────────────────────────
describe('Webhooks', () => {
  test('registerWebhook and listWebhooks work', () => {
    registerWebhook({ url: 'https://example.com/hook', secret: 'abc' });
    const hooks = listWebhooks();
    expect(hooks.some((h) => h.url === 'https://example.com/hook')).toBe(true);
  });

  test('registerWebhook is idempotent (upserts on duplicate URL)', () => {
    registerWebhook({ url: 'https://dupe.example.com/hook', secret: 'v1' });
    registerWebhook({ url: 'https://dupe.example.com/hook', secret: 'v2' });
    const hooks = listWebhooks().filter((h) => h.url === 'https://dupe.example.com/hook');
    expect(hooks).toHaveLength(1);
    expect(hooks[0].secret).toBe('v2');
  });

  test('deleteWebhook removes it', () => {
    const w = registerWebhook({ url: 'https://delete.example.com/hook' });
    deleteWebhook(w.id);
    expect(listWebhooks().some((h) => h.id === w.id)).toBe(false);
  });
});

// ─── Reset ────────────────────────────────────────────────────────────────────
describe('resetProjectData', () => {
  test('wipes all derived data but keeps project row and video_path', () => {
    const p = makeProject();
    updateProject(p.id, { video_path: '/some/video.mp4', status: 'complete' });
    saveTranscript(p.id, { rawJson: {}, fullText: 'hello' });
    insertFrame(p.id, { timestampSeconds: 1, filePath: '/f.jpg' });
    insertStep(p.id, { stepOrder: 0, title: 'S', bodyMarkdown: '' });
    upsertDocMeta(p.id, { summary: 'S', prerequisites: '', audience: '' });
    logUsage(p.id, { service: 'text', model: 'gpt-4o', inputTokens: 100, outputTokens: 10 });

    resetProjectData(p.id);

    const reset = getProject(p.id);
    expect(reset.status).toBe('uploaded');
    expect(reset.video_path).toBe('/some/video.mp4'); // preserved
    expect(getTranscript(p.id)).toBeNull();
    expect(listFrames(p.id)).toHaveLength(0);
    expect(listSteps(p.id)).toHaveLength(0);
    expect(getDocMeta(p.id)).toBeUndefined();
    expect(getProjectUsage(p.id)).toHaveLength(0);
  });
});
