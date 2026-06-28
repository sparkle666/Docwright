import { getOpenAIClient } from './openaiClient.js';
import { getDocTypePreset } from './docTypePresets.js';
import { logUsage } from '../db/repository.js';

const STEP_SCHEMA_INSTRUCTIONS = `
Return ONLY valid JSON (no markdown fences, no commentary) matching this exact shape:

{
  "summary": "1-3 sentence overview of what this documentation covers",
  "audience": "who this doc is written for, e.g. 'End users', 'Internal support agents'",
  "prerequisites": "any prerequisites or empty string if none",
  "steps": [
    {
      "title": "Short imperative step title",
      "body_markdown": "Full step instructions in markdown. Use **bold** for UI element names.",
      "start_seconds": 12.0,
      "end_seconds": 28.5
    }
  ]
}

Rules:
- "start_seconds" and "end_seconds" MUST be numbers derived from the [MM:SS] timestamps in the transcript (converted to seconds).
- Steps must be in chronological order and cover the entire transcript duration with no large unexplained gaps.
- Merge trivial/filler talk into the step it occurs within; do not create a step for throwaway commentary alone.
- Do not invent UI elements or actions not implied by the transcript.
- Aim for steps that are neither too granular (single words) nor too broad (the whole video as one step).
`;

/**
 * Sends the timestamped transcript to GPT and gets back a structured,
 * doc-type-appropriate breakdown into steps with time ranges.
 *
 * @param {object} opts
 * @param {string} opts.timestampedText
 * @param {string} opts.docType
 * @param {string} [opts.textModel]
 * @param {string} opts.title
 * @param {string} [opts.projectId]  – if provided, token usage is logged
 */
export async function generateStructuredDoc({ timestampedText, docType, textModel = 'gpt-4o', title, projectId }) {
  const client = getOpenAIClient();
  const preset = getDocTypePreset(docType);

  const systemPrompt = `${preset.systemPrompt}\n\n${STEP_SCHEMA_INSTRUCTIONS}`;
  const userPrompt = `Video title: "${title}"\n\nTimestamped transcript (format is "[MM:SS] spoken text"):\n\n${timestampedText}\n\nProduce the JSON described in your instructions now.`;

  const completion = await client.chat.completions.create({
    model: textModel,

    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
  });

  // Log token usage for cost tracking
  if (projectId && completion.usage) {
    logUsage(projectId, {
      service: 'text',
      model: textModel,
      inputTokens: completion.usage.prompt_tokens ?? 0,
      outputTokens: completion.usage.completion_tokens ?? 0,
    });
  }

  const raw = completion.choices[0].message.content;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`GPT returned invalid JSON for structured doc: ${err.message}\nRaw: ${raw}`);
  }

  if (!Array.isArray(parsed.steps)) {
    throw new Error('GPT response missing "steps" array');
  }

  // Normalize / sanitize
  parsed.steps = parsed.steps.map((s, idx) => ({
    title: String(s.title || `Step ${idx + 1}`),
    body_markdown: String(s.body_markdown || ''),
    start_seconds: typeof s.start_seconds === 'number' ? s.start_seconds : null,
    end_seconds: typeof s.end_seconds === 'number' ? s.end_seconds : null,
  }));

  return {
    summary: parsed.summary || '',
    audience: parsed.audience || '',
    prerequisites: parsed.prerequisites || '',
    steps: parsed.steps,
  };
}
