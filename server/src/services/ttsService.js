import { getOpenAIClient } from './openaiClient.js';

/**
 * Curated voice list — these are the voices supported by gpt-4o-mini-tts
 * via the /v1/audio/speech endpoint. Same voice IDs as before so the UI
 * and existing DB values stay compatible.
 */
export const AI_VOICES = [
  { id: 'alloy',   label: 'Alloy — neutral, balanced' },
  { id: 'ash',     label: 'Ash — calm, deep' },
  { id: 'ballad',  label: 'Ballad — smooth, narrative' },
  { id: 'coral',   label: 'Coral — bright, friendly' },
  { id: 'echo',    label: 'Echo — clear, professional' },
  { id: 'fable',   label: 'Fable — expressive, dynamic' },
  { id: 'onyx',    label: 'Onyx — deep, authoritative' },
  { id: 'nova',    label: 'Nova — warm, natural' },
  { id: 'sage',    label: 'Sage — measured, clear' },
  { id: 'shimmer', label: 'Shimmer — light, energetic' },
  { id: 'verse',   label: 'Verse — warm, expressive' },
];

/**
 * gpt-4o-mini-tts is the dedicated TTS model on the /v1/audio/speech
 * endpoint. It uses the same high-quality voices as the gpt-audio family
 * but is a pure text-to-speech converter — it physically cannot go
 * off-script or respond conversationally to the content it's reading.
 */
export const AI_VOICE_MODELS = [
  { id: 'gpt-4o-mini-tts', label: 'GPT-4o Mini TTS (high quality, pure narration)' },
];

export const DEFAULT_VOICE = 'alloy';
export const DEFAULT_MODEL = 'gpt-4o-mini-tts';

/**
 * Strips markdown formatting from text so TTS doesn't read symbols aloud.
 *
 * Handles:
 *   - Headings:        ## Title          → "Title"
 *   - Bold/italic:     **text**, *text*  → "text"
 *   - Inline code:     `code`            → "code"
 *   - Code blocks:     ```…```           → (removed entirely — not speakable)
 *   - Links:           [label](url)      → "label"
 *   - Images:          ![alt](url)       → (removed)
 *   - Blockquotes:     > text            → "text"
 *   - Unordered lists: - item / * item   → "item" (bullet stripped)
 *   - Ordered lists:   1. item           → "item" (number stripped)
 *   - HR:              ---               → (removed)
 *   - HTML tags:       <br>, <b>…        → (removed)
 *   - Extra whitespace                   → collapsed to single spaces
 */
export function stripMarkdownForTTS(text) {
  if (!text) return '';
  return text
    // Fenced code blocks (``` or ~~~) — drop the whole block, not speakable
    .replace(/^```[\s\S]*?```\s*/gm, '')
    .replace(/^~~~[\s\S]*?~~~\s*/gm, '')
    // Headings — keep just the heading text
    .replace(/^#{1,6}\s+/gm, '')
    // Bold + italic combined: ***text*** or ___text___
    .replace(/\*{3}(.+?)\*{3}/g, '$1')
    .replace(/_{3}(.+?)_{3}/g, '$1')
    // Bold: **text** or __text__
    .replace(/\*{2}(.+?)\*{2}/g, '$1')
    .replace(/_{2}(.+?)_{2}/g, '$1')
    // Italic: *text* or _text_
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    // Inline code: `code`
    .replace(/`(.+?)`/g, '$1')
    // Images: ![alt](url) — drop entirely
    .replace(/!\[.*?\]\(.*?\)/g, '')
    // Links: [label](url) — keep label only
    .replace(/\[(.+?)\]\(.*?\)/g, '$1')
    // Blockquotes: strip leading >
    .replace(/^>\s+/gm, '')
    // Unordered list bullets: leading -, *, + (with optional spaces)
    .replace(/^\s*[-*+]\s+/gm, '')
    // Ordered list numbers: leading "1. ", "12. " etc.
    .replace(/^\s*\d+\.\s+/gm, '')
    // Horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // HTML tags
    .replace(/<[^>]+>/g, '')
    // Collapse multiple blank lines into one
    .replace(/\n{3,}/g, '\n\n')
    // Collapse multiple spaces
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Synthesizes text into spoken audio using OpenAI's dedicated
 * /v1/audio/speech endpoint with gpt-4o-mini-tts.
 *
 * Unlike the chat completions audio modality (gpt-audio-1.5), this endpoint
 * is a pure TTS converter — it reads exactly what it's given and cannot
 * respond conversationally to the content, go off-script, or refuse to read
 * something because it "looks like a question".
 *
 * Returns a WAV buffer plus a synthetic usage object shaped the same way
 * as the chat completions usage so the caller's logUsage() call is unchanged.
 */
export async function synthesizeSegmentAudio({ text, voice = DEFAULT_VOICE, model = DEFAULT_MODEL }) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    throw new Error('synthesizeSegmentAudio: text is empty');
  }

  const client = getOpenAIClient();

  // The speech endpoint returns the raw audio bytes directly (not base64
  // wrapped in a chat message), so we call arrayBuffer() on the response.
  const response = await client.audio.speech.create({
    model,
    voice,
    input: trimmed,
    response_format: 'wav',
  });

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Estimate token counts for cost tracking — the speech endpoint doesn't
  // return usage metadata, so we approximate from character count (OpenAI
  // bills TTS per character, ~4 chars ≈ 1 token as a rough proxy).
  const estimatedInputTokens = Math.ceil(trimmed.length / 4);

  return {
    buffer,
    usage: {
      prompt_tokens: estimatedInputTokens,
      completion_tokens: 0,
      total_tokens: estimatedInputTokens,
    },
  };
}