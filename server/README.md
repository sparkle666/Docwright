# DocWright (vid2docs)

Turn a screen recording into polished, step-by-step documentation — transcript, matched screenshots, and all — in minutes.

## How it works

1. Upload a video (MP4, MOV, WebM)
2. DocWright extracts audio → transcribes with Whisper → writes structured steps with GPT → extracts key frames via ffmpeg scene detection → matches the best screenshot to each step with GPT Vision
3. Edit the result in the browser, then export as Markdown, HTML, PDF, or DOCX

---

## Requirements

| Dependency | Purpose |
|---|---|
| Node.js ≥ 20 | Server and client |
| ffmpeg + ffprobe | Audio extraction and frame capture |
| OpenAI API key | Whisper, GPT text + vision |
| Puppeteer (auto-installed) | PDF export |

Install ffmpeg on macOS: `brew install ffmpeg`  
On Ubuntu/Debian: `apt install ffmpeg`

---

## Quick start

```bash
# 1. Clone and install
git clone https://github.com/your-org/docwright
cd docwright

# 2. Start the server
cd server
npm install
cp .env.example .env
# → edit .env and add your OPENAI_API_KEY
npm run dev

# 3. Start the client (separate terminal)
cd ../client
npm install
npm run dev
```

Open http://localhost:5173 in your browser.

---

## API documentation

Interactive API docs (Swagger UI) are served automatically at:

```
http://localhost:4000/api/docs
```

The raw OpenAPI 3.0 spec (JSON) is available at:

```
http://localhost:4000/api/docs.json
```

You can import the JSON spec into Postman, Insomnia, or any OpenAPI-compatible tool.

---

## Environment variables

Copy `server/.env.example` to `server/.env`. All variables are documented in that file.

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | — | **Required.** Your OpenAI API key |
| `PORT` | `4000` | Server port |
| `SERVER_BASE_URL` | `http://localhost:4000` | Base URL embedded in Markdown/PDF image links |
| `MAX_UPLOAD_MB` | `1024` | Max video upload size in MB |
| `TEXT_MODEL` | `gpt-4.5-preview` | GPT model for step writing (overrides UI selection) |
| `VISION_MODEL` | `gpt-4o` | GPT model for screenshot selection (overrides UI selection) |
| `WHISPER_MODEL` | `whisper-1` | Whisper model for transcription |
| `FFMPEG_TIMEOUT_SECONDS` | `600` | Per-process timeout for ffmpeg calls |
| `RATE_LIMIT_MAX` | `20` | Max requests per IP per window |
| `RATE_LIMIT_WINDOW_MINUTES` | `60` | Rate limit window in minutes |
| `WEBHOOK_URL` | — | Optional single webhook URL (no registration needed) |

### Model selection

By default, the UI's **Settings** page lets users choose which OpenAI models to use for each new project. Setting `TEXT_MODEL` or `VISION_MODEL` in `.env` overrides the UI selection for all users on that server instance.

---

## API quick reference

For full request/response schemas and a live "Try it out" console, see `/api/docs`.

### Projects

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects` | List all projects |
| `POST` | `/api/projects` | Create project + upload video (`multipart/form-data`: `title`, `docType`, `video`) |
| `GET` | `/api/projects/:id` | Get a single project |
| `DELETE` | `/api/projects/:id` | Delete project and all storage files |
| `GET` | `/api/projects/:id/video` | Stream the original video (supports Range requests) |
| `GET` | `/api/projects/:id/cost` | Token usage and cost estimate |

### Pipeline

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/projects/:id/process` | Enqueue the AI pipeline. Accepts `{ textModel?, visionModel? }` |
| `GET` | `/api/projects/:id/status` | Poll pipeline status |
| `POST` | `/api/projects/:id/regenerate-doc` | Re-run only doc generation + screenshot matching using the existing transcript and frames (no re-upload/re-transcription). Use after editing the transcript. |

### Documents

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects/:id/doc` | Full assembled doc (meta + steps + frames) |
| `GET` | `/api/projects/:id/transcript` | Raw Whisper transcript |
| `PATCH` | `/api/projects/:id/transcript` | Edit transcript segment text (`{ segments: [{ id, text }] }`), preserving timestamps |

### Steps

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/projects/:id/steps` | Add a new step |
| `PATCH` | `/api/projects/:id/steps/:stepId` | Edit a step |
| `DELETE` | `/api/projects/:id/steps/:stepId` | Delete a step |
| `POST` | `/api/projects/:id/steps/reorder` | Reorder steps (`{ orderedIds: [...] }`) |
| `GET` | `/api/projects/:id/steps/:stepId/history` | Version history for a step |
| `POST` | `/api/projects/:id/steps/:stepId/restore/:historyId` | Restore a previous version |
| `POST` | `/api/projects/:id/steps/:stepId/capture-frame` | Capture a frame at `{ timestampSeconds }` |

### Screenshots

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects/:id/frames` | List all extracted frames |
| `GET` | `/api/frames/:frameId/image` | Serve a frame's JPEG bytes |

### Export

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects/:id/export/markdown` | Download `.md` (screenshots as server URLs) |
| `GET` | `/api/projects/:id/export/html` | Download `.html` (screenshots embedded as base64) |
| `GET` | `/api/projects/:id/export/pdf` | Download `.pdf` (Puppeteer-rendered) |
| `GET` | `/api/projects/:id/export/docx` | Download `.docx` (screenshots embedded) |

### Webhooks

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/webhooks` | List registered webhooks |
| `POST` | `/api/webhooks` | Register a webhook (`{ url, secret? }`) |
| `DELETE` | `/api/webhooks/:id` | Remove a webhook |

### System / config

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check (OpenAI key, ffmpeg, DB, storage) |
| `GET` | `/api/doc-types` | List documentation type presets |
| `GET` | `/api/models` | List available AI models, ordered best-first |
| `GET` | `/api/docs` | Interactive Swagger UI |
| `GET` | `/api/docs.json` | Raw OpenAPI 3.0 spec |

---

## Webhooks

Register a URL to be notified when a project finishes processing:

```bash
curl -X POST http://localhost:4000/api/webhooks \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://your-service.com/hooks/docwright", "secret": "optional-shared-secret" }'
```

DocWright POSTs to your endpoint with:

```json
{
  "event": "project.complete",
  "projectId": "proj_abc123",
  "timestamp": "2024-01-15T12:34:56.789Z"
}
```

Events: `project.complete`, `project.failed`

If you supply a `secret`, each request includes an `X-DocWright-Signature` header with an HMAC-SHA256 hex digest of the body. Verify it:

```js
const crypto = require('crypto');
const sig = req.headers['x-docwright-signature'];
const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
```

---

## Typical integration workflow

```bash
# 1. Upload a video
curl -X POST http://localhost:4000/api/projects \
  -F "title=How to invite a teammate" \
  -F "docType=step_by_step" \
  -F "video=@/path/to/recording.mp4"
# → { "project": { "id": "proj_abc123", "status": "uploaded", ... } }

# 2. Start the pipeline (optionally choose your model)
curl -X POST http://localhost:4000/api/projects/proj_abc123/process \
  -H "Content-Type: application/json" \
  -d '{ "textModel": "gpt-4.5-preview", "visionModel": "gpt-4o" }'
# → { "ok": true, "status": "queued" }

# 3. Poll until complete
curl http://localhost:4000/api/projects/proj_abc123/status
# → { "status": "complete", "errorMessage": null }

# 4. Fetch the generated doc
curl http://localhost:4000/api/projects/proj_abc123/doc

# 5. Download as PDF
curl -O -J http://localhost:4000/api/projects/proj_abc123/export/pdf
```

---

## Troubleshooting

**`ffmpeg: command not found`**  
Install ffmpeg and make sure it's on your PATH. Verify with `ffmpeg -version`.

**PDF export fails on Linux**  
Puppeteer needs Chrome dependencies. On Ubuntu/Debian:
```bash
apt install -y chromium-browser libgbm-dev libasound2
```
Or: `npx puppeteer browsers install chrome`

**Images broken in Markdown / PDF exports**  
Make sure `SERVER_BASE_URL` in `.env` is set to the URL where the server is reachable from the client. The default `http://localhost:4000` only works when both server and viewer are on the same machine.

**`SQLITE_READONLY` error**  
The `server/storage/` directory isn't writable. Check permissions: `chmod -R 755 server/storage`

**OpenAI quota / rate limit errors**  
Check `errorMessage` via `GET /api/projects/:id/status`. Verify your API key has sufficient quota at platform.openai.com.

**Large video times out**  
Increase `FFMPEG_TIMEOUT_SECONDS` in your `.env`. Default is 600 s (10 min). For 1-hour videos, set it to `3600`.

---

## Deployment

### Docker

```bash
cd server
docker build -t docwright-server .
docker run -p 4000:4000 --env-file .env -v $(pwd)/storage:/app/storage docwright-server
```

### Nginx (reverse proxy)

```nginx
client_max_body_size 2G;   # must be ≥ your MAX_UPLOAD_MB

location /api/ {
  proxy_pass http://localhost:4000;
  proxy_read_timeout 900;   # longer than your longest pipeline run
  proxy_request_buffering off;
}
```

### systemd

```ini
[Unit]
Description=DocWright server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/docwright/server
ExecStart=/usr/bin/node src/index.js
Restart=always
EnvironmentFile=/opt/docwright/server/.env

[Install]
WantedBy=multi-user.target
```

---

## License

MIT
