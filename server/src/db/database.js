import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', '..', 'storage', 'app.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      doc_type TEXT NOT NULL DEFAULT 'step_by_step',
      status TEXT NOT NULL DEFAULT 'created',
      video_path TEXT,
      audio_path TEXT,
      duration_seconds REAL,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS transcripts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      raw_json TEXT NOT NULL,
      full_text TEXT NOT NULL,
      is_edited INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS frames (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      timestamp_seconds REAL NOT NULL,
      file_path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'auto',
      change_score REAL,
      sharpness REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS doc_steps (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      step_order INTEGER NOT NULL,
      title TEXT NOT NULL,
      body_markdown TEXT NOT NULL,
      start_seconds REAL,
      end_seconds REAL,
      screenshot_frame_id TEXT REFERENCES frames(id) ON DELETE SET NULL,
      screenshot_rationale TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS doc_meta (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      summary TEXT,
      prerequisites TEXT,
      audience TEXT
    );

    -- Tracks OpenAI token usage per pipeline call for cost visibility
    CREATE TABLE IF NOT EXISTS usage_log (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      service TEXT NOT NULL,         -- 'whisper' | 'text' | 'vision'
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Keeps previous versions of step content for undo/restore
    CREATE TABLE IF NOT EXISTS doc_step_history (
      id TEXT PRIMARY KEY,
      step_id TEXT NOT NULL REFERENCES doc_steps(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body_markdown TEXT NOT NULL,
      saved_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Registered webhook URLs for pipeline completion notifications
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      secret TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_frames_project ON frames(project_id);
    CREATE INDEX IF NOT EXISTS idx_steps_project ON doc_steps(project_id);
    CREATE INDEX IF NOT EXISTS idx_usage_project ON usage_log(project_id);
    CREATE INDEX IF NOT EXISTS idx_step_history_step ON doc_step_history(step_id);
  `);

  migrateColumns();
}

/**
 * Lightweight migration for columns added after a database file already
 * existed — CREATE TABLE IF NOT EXISTS won't retrofit columns onto an
 * existing table, so we check pragma table_info and ALTER TABLE if missing.
 */
function migrateColumns() {
  const hasColumn = (table, column) =>
    db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);

  if (!hasColumn('frames', 'sharpness')) {
    db.exec(`ALTER TABLE frames ADD COLUMN sharpness REAL`);
  }
  if (!hasColumn('transcripts', 'is_edited')) {
    db.exec(`ALTER TABLE transcripts ADD COLUMN is_edited INTEGER NOT NULL DEFAULT 0`);
  }

  // AI voice-over feature: replaces the project's audio track with
  // TTS-generated speech built from the transcript. These columns track
  // the state of that (separate, on-demand) job and point at a backup of
  // the original video so it can be restored even though the working
  // video file is overwritten in place.
  if (!hasColumn('projects', 'voice_status')) {
    db.exec(`ALTER TABLE projects ADD COLUMN voice_status TEXT`);
  }
  if (!hasColumn('projects', 'voice_error')) {
    db.exec(`ALTER TABLE projects ADD COLUMN voice_error TEXT`);
  }
  if (!hasColumn('projects', 'voice_name')) {
    db.exec(`ALTER TABLE projects ADD COLUMN voice_name TEXT`);
  }
  if (!hasColumn('projects', 'voice_model')) {
    db.exec(`ALTER TABLE projects ADD COLUMN voice_model TEXT`);
  }
  if (!hasColumn('projects', 'original_video_backup_path')) {
    db.exec(`ALTER TABLE projects ADD COLUMN original_video_backup_path TEXT`);
  }
  if (!hasColumn('projects', 'voice_generated_at')) {
    db.exec(`ALTER TABLE projects ADD COLUMN voice_generated_at TEXT`);
  }
}

initSchema();
