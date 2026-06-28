# Contributing to DocWright

## Running the project locally

See README.md → Quick start.

## Running tests

```bash
cd server
npm install
npm test            # run all tests once
npm run test:watch  # re-run on file changes
```

Tests use Jest with ES module support (the `--experimental-vm-modules` flag).  
All tests live in `server/tests/`. They use in-memory SQLite and mocked external calls — no real OpenAI or ffmpeg calls are made.

## Linting

```bash
cd server
npm run lint
```

We use ESLint with a flat config (`eslint.config.js`). The same rules apply to both `src/` and `tests/`.

---

## Architecture

```
server/src/
├── index.js              Entry point — Express setup, rate limiting, health check
├── db/
│   ├── database.js       SQLite connection + schema init
│   └── repository.js     All DB read/write functions (pure data layer, no HTTP)
├── jobs/
│   ├── queue.js          In-process FIFO job queue (swap for BullMQ for multi-server)
│   └── pipeline.js       Full AI pipeline orchestrator
├── routes/
│   ├── projects.js       Project + step CRUD, pipeline control, cost endpoint
│   ├── export.js         Markdown / HTML / PDF / DOCX download routes
│   └── webhooks.js       Webhook registration routes
├── services/
│   ├── ffmpegService.js          Audio extraction, frame extraction, duration probe
│   ├── whisperService.js         OpenAI Whisper transcription
│   ├── docGenerationService.js   GPT-4 transcript → structured steps
│   ├── visionSelectionService.js GPT-4 Vision → best frame per step
│   ├── webhookService.js         Fires registered webhooks
│   ├── openaiClient.js           OpenAI client singleton
│   ├── docTypePresets.js         System prompts per doc type
│   └── exporters/
│       ├── markdownExporter.js
│       ├── htmlExporter.js
│       ├── pdfExporter.js
│       └── docxExporter.js
└── utils/
    └── uploadMiddleware.js       Multer config (MIME check, size limit)
```

### Key design principles

- **repository.js is the only layer that touches the database.** Routes and services import from it; they never import `db` directly.
- **pipeline.js is stateless between runs.** `resetProjectData()` is called at the start of every run, making re-processing fully idempotent.
- **External calls are always mocked in tests.** No test makes a real HTTP request or spawns a real process.
- **Errors in pipeline steps surface via `project.error_message`**, not HTTP errors, since the pipeline runs asynchronously.

---

## Adding a new documentation type

1. Open `server/src/services/docTypePresets.js`
2. Add a new entry to the `DOC_TYPES` object:

```js
export const DOC_TYPES = {
  // ... existing types ...
  release_notes: {
    label: 'Release notes',
    systemPrompt: `You are writing release notes for a software product.
Focus on: what changed, why it matters, and any migration steps required.
Use present tense. Group changes by type: Features, Bug fixes, Breaking changes.`,
  },
};
```

3. Add the description string to `client/src/pages/NewProjectPage.jsx` in the `DOC_TYPE_DESCRIPTIONS` object.

That's it — the new type will appear in the project creation form automatically.

---

## Adding a new export format

1. Create `server/src/services/exporters/myFormatExporter.js` and export a `buildMyFormat(bundle)` function.
2. Add a route in `server/src/routes/export.js` following the pattern of existing routes.
3. Add a download button in `client/src/pages/ProjectPage.jsx`.

The `bundle` object passed to exporters has shape:
```js
{
  project,            // projects row
  meta,               // doc_meta row
  steps,              // doc_steps rows (ordered)
  framesById,         // { [frameId]: frames row }
  screenshotUrlResolver, // (frame) => string (data URI or URL)
}
```

---

## Database migrations

The schema in `database.js` uses `CREATE TABLE IF NOT EXISTS`, so adding new tables is safe on existing databases. When **modifying** an existing table, you'll need to add migration logic. A simple approach for self-hosted use:

```js
// In database.js, after initSchema():
try {
  db.exec(`ALTER TABLE projects ADD COLUMN new_field TEXT`);
} catch {
  // Column already exists — safe to ignore
}
```

For a more formal migration system, consider [`better-sqlite3-migrate`](https://github.com/nicolo-ribaudo/better-sqlite3-migrate) or similar.
