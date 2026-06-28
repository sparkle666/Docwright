import fs from 'fs';
import { getOpenAIClient } from './openaiClient.js';
import { logUsage } from '../db/repository.js';

function imageToDataUrl(filePath) {
  const buf = fs.readFileSync(filePath);
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

/**
 * Given a documentation step and a list of candidate frames, ask GPT-4 Vision
 * to pick the single best frame that visually represents the step.
 *
 * @param {object} opts
 * @param {object} opts.step
 * @param {Array}  opts.candidates  – [{ id, timestampSeconds, filePath }]
 * @param {string} [opts.visionModel]
 * @param {string} [opts.projectId]  – if provided, token usage is logged
 * @returns {{ chosenFrameId: string|null, rationale: string }}
 */
export async function selectBestFrameForStep({ step, candidates, visionModel = 'gpt-4o', projectId }) {
  if (candidates.length === 0) {
    return { chosenFrameId: null, rationale: 'No candidate frames available in this time range.' };
  }

  if (candidates.length === 1) {
    return { chosenFrameId: candidates[0].id, rationale: 'Only one candidate frame available in range.' };
  }

  const client = getOpenAIClient();

  const content = [
    {
      type: 'text',
      text: `You are choosing the single best screenshot to illustrate this documentation step.

Step title: "${step.title}"
Step instructions: "${step.body_markdown}"

Below are ${candidates.length} candidate screenshots, labeled with their index and timestamp. Pick the ONE that best visually represents the action described in the step — prefer frames that clearly show relevant UI, avoid blank/loading/blurry/transitional frames.

Respond ONLY with valid JSON: {"chosen_index": <integer>, "rationale": "<one sentence why>"}
If none of the candidates are suitable at all (e.g. all blank/blurry), respond with {"chosen_index": -1, "rationale": "<why none work>"}`,
    },
  ];

  candidates.forEach((c, idx) => {
    content.push({ type: 'text', text: `Candidate index ${idx}, timestamp ${c.timestampSeconds.toFixed(1)}s:` });
    content.push({ type: 'image_url', image_url: { url: imageToDataUrl(c.filePath) } });
  });

  const completion = await client.chat.completions.create({
    model: visionModel,
    messages: [{ role: 'user', content }],
    response_format: { type: 'json_object' },
  });

  // Log token usage for cost tracking
  if (projectId && completion.usage) {
    logUsage(projectId, {
      service: 'vision',
      model: visionModel,
      inputTokens: completion.usage.prompt_tokens ?? 0,
      outputTokens: completion.usage.completion_tokens ?? 0,
    });
  }

  const raw = completion.choices[0].message.content;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const fallbackIdx = Math.floor(candidates.length / 2);
    return { chosenFrameId: candidates[fallbackIdx].id, rationale: 'Fallback selection (vision response unparsable).' };
  }

  const idx = parsed.chosen_index;
  if (typeof idx !== 'number' || idx < 0 || idx >= candidates.length) {
    return { chosenFrameId: null, rationale: parsed.rationale || 'No suitable frame.' };
  }

  return { chosenFrameId: candidates[idx].id, rationale: parsed.rationale || '' };
}

/**
 * Find candidate frames for a step's time range, with progressive widening.
 */
export function findCandidateFrames(allFrames, step, paddingSeconds = 2) {
  const start = (step.start_seconds ?? step.startSeconds ?? 0) - paddingSeconds;
  const end = (step.end_seconds ?? step.endSeconds ?? start + 1) + paddingSeconds;

  let candidates = allFrames.filter((f) => {
    const t = f.timestamp_seconds ?? f.timestampSeconds;
    return t >= start && t <= end;
  });

  let widenedPadding = paddingSeconds;
  while (candidates.length === 0 && widenedPadding < 30) {
    widenedPadding += 5;
    const widerStart = (step.start_seconds ?? step.startSeconds ?? 0) - widenedPadding;
    const widerEnd = (step.end_seconds ?? step.endSeconds ?? widerStart + 1) + widenedPadding;
    candidates = allFrames.filter((f) => {
      const t = f.timestamp_seconds ?? f.timestampSeconds;
      return t >= widerStart && t <= widerEnd;
    });
  }

  return candidates.map((f) => ({
    id: f.id,
    timestampSeconds: f.timestamp_seconds ?? f.timestampSeconds,
    filePath: f.file_path ?? f.filePath,
  }));
}
