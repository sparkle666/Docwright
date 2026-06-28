import fs from 'fs';
import { getOpenAIClient } from './openaiClient.js';

/**
 * Transcribe an audio file using OpenAI Whisper, returning word/segment-level
 * timestamps so we can later align steps to screenshots.
 */
export async function transcribeAudio(audioPath, model = 'whisper-1') {
  const client = getOpenAIClient();

  const response = await client.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model,
    response_format: 'verbose_json',
    timestamp_granularities: ['segment', 'word'],
  });

  // response includes: text, segments[{ id, start, end, text }], words[{ word, start, end }]
  const fullText = response.text || '';
  const segments = (response.segments || []).map((s) => ({
    id: s.id,
    start: s.start,
    end: s.end,
    text: s.text.trim(),
  }));

  return {
    fullText,
    segments,
    raw: response,
  };
}

/**
 * Formats segments into a flat plain-text transcript with inline timestamps,
 * e.g. "[00:12] Click on the Settings icon..."
 * This is the representation we feed to GPT for step formatting, since GPT
 * needs explicit timestamp anchors to map text to video time.
 */
export function segmentsToTimestampedText(segments) {
  return segments
    .map((s) => `[${formatTimestamp(s.start)}] ${s.text}`)
    .join('\n');
}

export function formatTimestamp(seconds) {
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
