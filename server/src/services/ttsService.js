import { getOpenAIClient } from './openaiClient.js';

/**
 * Curated voice list for OpenAI's audio-capable chat models (gpt-audio family).
 * Exposed via GET /api/voices so the UI can render a picker without
 * hardcoding the list client-side.
 */
export const AI_VOICES = [
  { id: 'alloy', label: 'Alloy — neutral, balanced' },
  { id: 'verse', label: 'Verse — warm, expressive' },
  { id: 'ash', label: 'Ash — calm, deep' },
  { id: 'ballad', label: 'Ballad — smooth, narrative' },
  { id: 'coral', label: 'Coral — bright, friendly' },
  { id: 'sage', label: 'Sage — measured, clear' },
  { id: 'shimmer', label: 'Shimmer — light, energetic' },
  { id: 'marin', label: 'Marin — natural, conversational' },
  { id: 'cedar', label: 'Cedar — grounded, confident' },
];

export const AI_VOICE_MODELS = [
  { id: 'gpt-audio-1.5', label: 'GPT Audio 1.5 (best quality, audio in/out)' },
];

const DEFAULT_VOICE = 'alloy';
const DEFAULT_MODEL = 'gpt-audio-1.5';

/**
 * Synthesizes one transcript segment's text into spoken audio via the
 * Chat Completions audio modality. The system prompt pins the model to
 * pure narration — read exactly what's given, nothing added — since the
 * "prompt" here is the transcript itself, not an instruction to riff on.
 *
 * Returns the raw audio bytes (WAV) plus whatever usage info the API
 * reports, so the caller can log real token counts when available.
 */
export async function synthesizeSegmentAudio({ text, voice = DEFAULT_VOICE, model = DEFAULT_MODEL }) {
  const trimmed = (text || '').trim();
  if (!trimmed) {
    throw new Error('synthesizeSegmentAudio: text is empty');
  }

  const client = getOpenAIClient();

  const response = await client.chat.completions.create({
    model,
    modalities: ['text', 'audio'],
    audio: { voice, format: 'wav' },
    messages: [
      {
        role: 'system',
        content:
          'You are a text-to-speech narration engine, not a conversational assistant. ' +
          'Read the user\'s message aloud exactly as written, in a clear, natural speaking voice. ' +
          'Do not add, remove, paraphrase, answer, or comment on anything in the message — ' +
          'your entire output must be audio of that exact text being spoken, nothing else.',
      },
      { role: 'user', content: trimmed },
    ],
  });

  const message = response.choices?.[0]?.message;
  const audioPayload = message?.audio;
  if (!audioPayload?.data) {
    throw new Error('No audio returned from the model for this segment.');
  }

  return {
    buffer: Buffer.from(audioPayload.data, 'base64'),
    usage: response.usage || null,
  };
}

export { DEFAULT_VOICE, DEFAULT_MODEL };
