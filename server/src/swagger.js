import swaggerJsdoc from 'swagger-jsdoc';

/**
 * OpenAPI 3.0 specification for the DocWright API.
 * Route annotations live as JSDoc comments in each routes/*.js file.
 * This module builds the spec object; index.js mounts the UI.
 */
const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'DocWright API',
      version: '1.0.0',
      description: `
**DocWright** converts screen recordings into structured, step-by-step documentation using OpenAI Whisper (transcription), GPT-4 (doc writing), and GPT-4 Vision (screenshot matching).

### Typical workflow
1. \`POST /api/projects\` — upload a screen recording
2. \`POST /api/projects/:id/process\` — kick off the AI pipeline
3. Poll \`GET /api/projects/:id/status\` until \`status === "complete"\`
4. \`GET /api/projects/:id/doc\` — fetch the generated steps
5. \`GET /api/projects/:id/export/pdf\` (or \`docx\` / \`markdown\` / \`html\`) — download the finished document

### Rate limiting
By default, project endpoints are limited to **20 requests per 60 minutes** per IP.
Configure with \`RATE_LIMIT_MAX\` and \`RATE_LIMIT_WINDOW_MINUTES\` in \`.env\`.

### Authentication
No authentication is required by default (designed for local / internal use).
Add your own middleware if you expose this server publicly.
      `,
      contact: {
        name: 'DocWright',
      },
    },
    servers: [
      { url: 'http://localhost:4000', description: 'Local development server' },
    ],
    tags: [
      { name: 'Projects', description: 'Create and manage documentation projects' },
      { name: 'Pipeline', description: 'Start and monitor the AI processing pipeline' },
      { name: 'Documents', description: 'Read and edit the generated documentation' },
      { name: 'Steps', description: 'CRUD operations on individual doc steps' },
      { name: 'Screenshots', description: 'Capture and serve frame screenshots' },
      { name: 'Voice', description: 'AI voice-over generation from the transcript' },
      { name: 'Exports', description: 'Download finished documents in various formats' },
      { name: 'Webhooks', description: 'Register URLs to be notified on pipeline events' },
      { name: 'Models', description: 'Available AI models and configuration' },
      { name: 'System', description: 'Health checks and server info' },
    ],
    components: {
      schemas: {
        // ── Core models ────────────────────────────────────────────────────────
        Project: {
          type: 'object',
          properties: {
            id:               { type: 'string', example: 'proj_abc123' },
            title:            { type: 'string', example: 'How to invite a teammate' },
            doc_type:         { type: 'string', example: 'step_by_step', enum: ['step_by_step', 'sop', 'help_center', 'knowledge_base'] },
            status:           { type: 'string', example: 'complete', enum: ['uploaded', 'queued', 'extracting_audio', 'transcribing', 'writing_doc', 'extracting_frames', 'matching_screenshots', 'complete', 'failed'] },
            video_path:       { type: 'string', nullable: true, example: 'storage/uploads/proj_abc123.mp4' },
            audio_path:       { type: 'string', nullable: true },
            duration_seconds: { type: 'number', nullable: true, example: 142.5 },
            error_message:    { type: 'string', nullable: true },
            created_at:       { type: 'string', format: 'date-time' },
            updated_at:       { type: 'string', format: 'date-time' },
          },
        },
        DocMeta: {
          type: 'object',
          properties: {
            summary:       { type: 'string', example: 'This guide walks through inviting a new teammate to your workspace.' },
            audience:      { type: 'string', example: 'Workspace admins' },
            prerequisites: { type: 'string', example: 'You must have admin permissions.' },
          },
        },
        Step: {
          type: 'object',
          properties: {
            id:                   { type: 'string', example: 'step_xyz789' },
            project_id:           { type: 'string', example: 'proj_abc123' },
            step_order:           { type: 'integer', example: 0 },
            title:                { type: 'string', example: 'Open the Members settings' },
            body_markdown:        { type: 'string', example: 'Click **Settings** in the left sidebar, then select **Members**.' },
            start_seconds:        { type: 'number', nullable: true, example: 4.2 },
            end_seconds:          { type: 'number', nullable: true, example: 18.7 },
            screenshot_frame_id:  { type: 'string', nullable: true, example: 'frame_001' },
            screenshot_rationale: { type: 'string', nullable: true },
            created_at:           { type: 'string', format: 'date-time' },
          },
        },
        Frame: {
          type: 'object',
          properties: {
            id:                { type: 'string', example: 'frame_001' },
            project_id:        { type: 'string', example: 'proj_abc123' },
            timestamp_seconds: { type: 'number', example: 11.4 },
            file_path:         { type: 'string', example: 'storage/frames/proj_abc123/frame_011.jpg' },
            source:            { type: 'string', enum: ['auto', 'manual', 'fallback_midpoint'], example: 'auto' },
            change_score:      { type: 'number', nullable: true, example: 0.34 },
          },
        },
        Transcript: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            full_text:  { type: 'string', example: 'Welcome to this tutorial. Today we will...' },
            raw_json:   { type: 'string', description: 'Raw Whisper JSON response (serialized)' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        Webhook: {
          type: 'object',
          properties: {
            id:         { type: 'string', example: 'wh_111aaa' },
            url:        { type: 'string', example: 'https://hooks.example.com/docwright' },
            secret:     { type: 'string', nullable: true, description: 'HMAC-SHA256 signing secret. Present in responses only as a masked hint.' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        StepHistoryEntry: {
          type: 'object',
          properties: {
            id:           { type: 'string' },
            step_id:      { type: 'string' },
            title:        { type: 'string' },
            body_markdown:{ type: 'string' },
            saved_at:     { type: 'string', format: 'date-time' },
          },
        },
        ModelInfo: {
          type: 'object',
          properties: {
            id:    { type: 'string', example: 'gpt-4.5-preview' },
            label: { type: 'string', example: 'GPT-4.5 Preview (best quality)' },
          },
        },
        UsageRecord: {
          type: 'object',
          properties: {
            service:       { type: 'string', enum: ['whisper', 'text', 'vision'], example: 'text' },
            model:         { type: 'string', example: 'gpt-4.5-preview' },
            input_tokens:  { type: 'integer', example: 3200 },
            output_tokens: { type: 'integer', example: 850 },
          },
        },
        CostEstimate: {
          type: 'object',
          properties: {
            whisper_usd: { type: 'number', example: 0.014 },
            text_usd:    { type: 'number', example: 0.21 },
            vision_usd:  { type: 'number', example: 0.08 },
            total_usd:   { type: 'number', example: 0.304 },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string', example: 'Project not found' },
          },
        },
      },
    },
  },
  // Scan all route files for @openapi JSDoc annotations
  apis: ['./src/routes/*.js', './src/index.js'],
};

export const swaggerSpec = swaggerJsdoc(options);
