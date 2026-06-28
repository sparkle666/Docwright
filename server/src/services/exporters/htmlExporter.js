import { marked } from 'marked';
import { formatTimestamp } from '../whisperService.js';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Builds a standalone, styled HTML document for the project.
 * screenshotUrlResolver(frame) => string (data URI or file URL to embed)
 */
export function buildHtml({ project, meta, steps, framesById, screenshotUrlResolver }) {
  const stepsHtml = steps.map((step, idx) => {
    const frame = step.screenshot_frame_id ? framesById[step.screenshot_frame_id] : null;
    const imgTag = frame
      ? `<img class="step-screenshot" src="${screenshotUrlResolver(frame)}" alt="Screenshot for step ${idx + 1}" />`
      : '';
    const timeTag = step.start_seconds != null
      ? `<div class="step-timestamp">Timestamp: ${formatTimestamp(step.start_seconds)}${step.end_seconds != null ? ' – ' + formatTimestamp(step.end_seconds) : ''}</div>`
      : '';

    return `
      <section class="step">
        <h2>${idx + 1}. ${escapeHtml(step.title)}</h2>
        ${timeTag}
        <div class="step-body">${marked.parse(step.body_markdown || '')}</div>
        ${imgTag}
      </section>
    `;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(project.title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; line-height: 1.6; }
  h1 { font-size: 2rem; margin-bottom: 0.25rem; }
  .doc-meta { color: #555; margin-bottom: 2rem; }
  .doc-meta div { margin-bottom: 4px; }
  .step { margin-bottom: 2.5rem; border-top: 1px solid #e5e5e5; padding-top: 1.5rem; }
  .step h2 { font-size: 1.3rem; margin-bottom: 0.25rem; }
  .step-timestamp { font-size: 0.85rem; color: #888; margin-bottom: 0.75rem; font-style: italic; }
  .step-screenshot { max-width: 100%; border: 1px solid #ddd; border-radius: 6px; margin-top: 1rem; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
  .step-body p { margin: 0.5rem 0; }
  code { background: #f4f4f4; padding: 2px 5px; border-radius: 3px; font-size: 0.9em; }
</style>
</head>
<body>
  <h1>${escapeHtml(project.title)}</h1>
  <div class="doc-meta">
    ${meta?.summary ? `<p>${escapeHtml(meta.summary)}</p>` : ''}
    ${meta?.audience ? `<div><strong>Audience:</strong> ${escapeHtml(meta.audience)}</div>` : ''}
    ${meta?.prerequisites ? `<div><strong>Prerequisites:</strong> ${escapeHtml(meta.prerequisites)}</div>` : ''}
  </div>
  ${stepsHtml}
</body>
</html>`;
}
