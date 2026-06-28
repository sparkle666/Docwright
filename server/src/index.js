import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import { projectsRouter } from './routes/projects.js';
import { exportRouter } from './routes/export.js';
import { webhooksRouter } from './routes/webhooks.js';
import { swaggerSpec } from './swagger.js';
import { checkFfmpegAvailable } from './services/ffmpegService.js';
import { db } from './db/database.js';
import './db/database.js'; // ensures schema is initialized on boot

const app = express();
const PORT = process.env.PORT || 4000;

// ─── Body parsing ─────────────────────────────────────────────────────────────

const maxBodyMb = parseInt(process.env.MAX_UPLOAD_MB || '1024', 10);
app.use(cors());
app.use(express.json({ limit: `${maxBodyMb}mb` }));

// ─── Rate limiting ────────────────────────────────────────────────────────────

const rateLimitMax = parseInt(process.env.RATE_LIMIT_MAX || '20', 10);
const rateLimitWindowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MINUTES || '60', 10) * 60 * 1000;

if (rateLimitMax > 0) {
  const uploadLimiter = rateLimit({
    windowMs: rateLimitWindowMs,
    max: rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: `Too many requests — max ${rateLimitMax} per ${process.env.RATE_LIMIT_WINDOW_MINUTES || 60} minutes per IP.` },
  });
  app.use('/api/projects', uploadLimiter);
}

// ─── API Docs (Swagger UI) ────────────────────────────────────────────────────
// Interactive docs at http://localhost:4000/api/docs
// Raw OpenAPI JSON at http://localhost:4000/api/docs.json

app.get('/api/docs.json', (req, res) => res.json(swaggerSpec));
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'DocWright API',
  swaggerOptions: {
    docExpansion: 'list',      // expand tag groups but collapse individual ops
    filter: true,              // show search/filter bar
    tryItOutEnabled: true,     // enable "Try it out" by default
  },
}));

// ─── Health check ─────────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/health:
 *   get:
 *     summary: Health check
 *     description: |
 *       Returns the live status of each server dependency. Use this to
 *       verify your `.env` is configured correctly before processing a video.
 *
 *       Returns HTTP 200 when all checks pass; HTTP 503 if any check fails.
 *     tags: [System]
 *     responses:
 *       200:
 *         description: All systems operational
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:           { type: boolean, example: true }
 *                 hasOpenAIKey: { type: boolean, example: true, description: "Whether OPENAI_API_KEY is set" }
 *                 ffmpeg:       { type: boolean, example: true, description: "Whether ffmpeg is on PATH" }
 *                 database:     { type: boolean, example: true, description: "Whether SQLite is reachable" }
 *                 storage:      { type: boolean, example: true, description: "Whether the storage directory is writable" }
 *                 models:
 *                   type: object
 *                   description: Active model names (from env or defaults)
 *                   properties:
 *                     whisper: { type: string, example: whisper-1 }
 *                     text:    { type: string, example: gpt-4.5-preview }
 *                     vision:  { type: string, example: gpt-4o }
 *             example:
 *               ok: true
 *               hasOpenAIKey: true
 *               ffmpeg: true
 *               database: true
 *               storage: true
 *               models:
 *                 whisper: whisper-1
 *                 text: gpt-4.5-preview
 *                 vision: gpt-4o
 *       503:
 *         description: One or more checks failed — see individual fields
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *             example:
 *               ok: false
 *               hasOpenAIKey: false
 *               ffmpeg: true
 *               database: true
 *               storage: true
 */
app.get('/api/health', async (req, res) => {
  const checks = {
    ok: true,
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    ffmpeg: null,
    database: null,
    storage: null,
    models: {
      whisper: process.env.WHISPER_MODEL || 'whisper-1',
      text: process.env.TEXT_MODEL || 'gpt-5.5',
      vision: process.env.VISION_MODEL || 'gpt-4o',
    },
  };

  try {
    checks.ffmpeg = await checkFfmpegAvailable();
  } catch {
    checks.ffmpeg = false;
    checks.ok = false;
  }

  try {
    db.prepare('SELECT 1').get();
    checks.database = true;
  } catch {
    checks.database = false;
    checks.ok = false;
  }

  try {
    const { mkdirSync, writeFileSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const testPath = join(process.cwd(), 'storage', '.healthcheck');
    mkdirSync(join(process.cwd(), 'storage'), { recursive: true });
    writeFileSync(testPath, '1');
    rmSync(testPath);
    checks.storage = true;
  } catch {
    checks.storage = false;
    checks.ok = false;
  }

  res.status(checks.ok ? 200 : 503).json(checks);
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/api', projectsRouter);
app.use('/api', exportRouter);
app.use('/api', webhooksRouter);

// ─── Centralized error handler ────────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`DocWright server listening on http://localhost:${PORT}`);
  console.log(`API docs available at http://localhost:${PORT}/api/docs`);
  if (!process.env.OPENAI_API_KEY) {
    console.warn('WARNING: OPENAI_API_KEY is not set. Copy .env.example to .env before processing videos.');
  }
});
