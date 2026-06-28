import { formatTimestamp } from '../whisperService.js';

/**
 * Builds a full Markdown document from a project, its meta, steps, and frames.
 * screenshotUrlResolver(frameId) => string (path or URL to embed) lets the
 * caller decide whether to embed relative file paths, absolute URLs, or
 * base64 data URIs depending on export context.
 */
export function buildMarkdown({ project, meta, steps, framesById, screenshotUrlResolver }) {
  const lines = [];

  lines.push(`# ${project.title}`);
  lines.push('');

  if (meta?.summary) {
    lines.push(meta.summary);
    lines.push('');
  }

  if (meta?.audience) {
    lines.push(`**Audience:** ${meta.audience}`);
  }
  if (meta?.prerequisites) {
    lines.push(`**Prerequisites:** ${meta.prerequisites}`);
  }
  if (meta?.audience || meta?.prerequisites) {
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  steps.forEach((step, idx) => {
    lines.push(`## ${idx + 1}. ${step.title}`);
    lines.push('');

    if (step.start_seconds != null) {
      lines.push(`_Timestamp: ${formatTimestamp(step.start_seconds)}${step.end_seconds != null ? ' – ' + formatTimestamp(step.end_seconds) : ''}_`);
      lines.push('');
    }

    lines.push(step.body_markdown);
    lines.push('');

    const frame = step.screenshot_frame_id ? framesById[step.screenshot_frame_id] : null;
    if (frame) {
      const url = screenshotUrlResolver(frame);
      lines.push(`![Screenshot for step ${idx + 1}](${url})`);
      lines.push('');
    }
  });

  return lines.join('\n');
}
