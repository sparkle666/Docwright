# DocWright (vid2docs)

Turn a screen recording into polished, step-by-step documentation — transcript, matched screenshots, and all — in minutes.

## How it works

1. Upload a video (MP4, MOV, WebM)
2. DocWright extracts audio → transcribes with Whisper → writes structured steps with GPT-4 → extracts key frames via ffmpeg scene detection → matches the best screenshot to each step with GPT-4 Vision
3. Edit the result in the browser, then export as Markdown, HTML, PDF, or DOCX
4. Optionally, open the **AI voice-over** page for a project (linked from the project page header) to synthesize the transcript with an OpenAI audio model — per-segment, so timing stays aligned to the original pauses and pacing — and replace the video's audio track with it.

**Roadmap:** a future "talking head" mode will pair the AI voice-over with a synced presenter face, so the speaker visually appears to be the one narrating. The voice-generation pipeline already keeps audio generation as its own step before muxing, specifically so that stage can be inserted later without reworking it.

---

## Requirements

| Dependency | Purpose |
|---|---|
| Node.js ≥ 20 | Server and client |
| ffmpeg + ffprobe | Audio extraction and frame capture |
| OpenAI API key | Whisper, GPT-4o, GPT-4o Vision |
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

## Environment variables

Copy `server/.env.example` to `server/.env`. All variables are documented in that file.

Key variables:

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | — | **Required.** Your OpenAI API key |
| `PORT` | `4000` | Server port |
| `MAX_UPLOAD_MB` | `1024` | Max video upload size in MB |
| `TEXT_MODEL` | `gpt-4o` | GPT model for step writing |
| `VISION_MODEL` | `gpt-4o` | GPT model for screenshot selection |
| `TTS_MODEL` | `gpt-audio-1.5` | Audio model for the AI voice-over feature (needs audio in/out access) |
| `TTS_VOICE` | `alloy` | Default voice for the AI voice-over feature |
| `FFMPEG_TIMEOUT_SECONDS` | `600` | Per-process timeout for ffmpeg calls |
| `RATE_LIMIT_MAX` | `20` | Max upload/process requests per IP per window |
| `WEBHOOK_URL` | — | Optional URL to POST on project complete/fail |

---

## API reference

### Projects

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects` | List all projects |
| `POST` | `/api/projects` | Create project + upload video (`multipart/form-data`: `title`, `docType`, `video`) |
| `GET` | `/api/projects/:id` | Get a single project |
| `DELETE` | `/api/projects/:id` | Delete project and all storage files |
| `POST` | `/api/projects/:id/process` | Enqueue the AI pipeline |
| `GET` | `/api/projects/:id/status` | Poll pipeline status |
| `GET` | `/api/projects/:id/doc` | Full assembled doc (meta + steps + frames) |
| `GET` | `/api/projects/:id/transcript` | Raw Whisper transcript |
| `GET` | `/api/projects/:id/cost` | Token usage and cost estimate |

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

### Voice (AI voice-over)

Replaces the project's video audio with an AI-generated voice reading the
transcript, fitted to the original timing (silence where pauses were,
mild pitch-preserved speed-up if a clip runs long). **Overwrites the
project's video file in place** — a one-time backup is kept automatically
and can be restored.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/voices` | List available voices/models |
| `POST` | `/api/projects/:id/voice` | Generate an AI voice-over (`{ voice?, model? }`) |
| `GET` | `/api/projects/:id/voice/status` | Poll generation status |
| `POST` | `/api/projects/:id/voice/restore` | Restore the original (pre-AI-voice) audio |

Requires a transcript — run `/api/projects/:id/process` first.

### Export

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/projects/:id/export/markdown` | Download `.md` |
| `GET` | `/api/projects/:id/export/html` | Download `.html` |
| `GET` | `/api/projects/:id/export/pdf` | Download `.pdf` |
| `GET` | `/api/projects/:id/export/docx` | Download `.docx` |

### Webhooks

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/webhooks` | List registered webhooks |
| `POST` | `/api/webhooks` | Register a webhook (`{ url, secret? }`) |
| `DELETE` | `/api/webhooks/:id` | Remove a webhook |

### Misc

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Server health check (ffmpeg, DB, storage) |
| `GET` | `/api/doc-types` | List available documentation type presets |

---

## Webhooks

Register a URL to be notified when a project finishes processing:

```bash
curl -X POST http://localhost:4000/api/webhooks \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://your-service.com/hooks/docwright", "secret": "optional-shared-secret" }'
```

DocWright sends a `POST` request with:

```json
{
  "event": "project.complete",
  "projectId": "abc123",
  "timestamp": "2024-01-15T12:34:56.789Z"
}
```

Events: `project.complete`, `project.failed`

The optional `secret` is sent as the `X-DocWright-Secret` header so you can verify the source.

You can also set a single webhook via the `WEBHOOK_URL` env variable (no registration needed).

---

## Troubleshooting

**`ffmpeg: command not found`**  
Install ffmpeg and make sure it's on your PATH. Verify with `ffmpeg -version`.

**PDF export fails on Linux**  
Puppeteer needs Chrome dependencies. On Ubuntu/Debian:
```bash
apt install -y chromium-browser libgbm-dev libasound2
```
Or install the full set: `npx puppeteer browsers install chrome`

**`SQLITE_READONLY` error**  
The `server/storage/` directory isn't writable. Check permissions: `chmod -R 755 server/storage`

**OpenAI quota / rate limit errors showing as pipeline failures**  
Check `project.error_message` via `GET /api/projects/:id/status`. The error message includes the underlying OpenAI error string. Verify your API key has sufficient quota at platform.openai.com.

**Large video times out**  
Increase `FFMPEG_TIMEOUT_SECONDS` in your `.env`. Default is 600s (10 minutes). For 1-hour videos, set it to `3600`.

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
