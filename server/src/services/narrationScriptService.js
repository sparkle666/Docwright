import { getDocTypePreset } from './docTypePresets.js';
import { stripMarkdownForTTS } from './ttsService.js';

export function buildNarrationScript({ docType, steps = [], docMeta = {} }) {
  const preset = getDocTypePreset(docType);
  const flowing = Boolean(preset.flowing);
  const includeSpokenFraming = flowing && preset.spokenIntroOutro !== false;

  const spokenLines = [];
  const introText = stripMarkdownForTTS(docMeta?.intro_narration || '').trim();
  const outroText = stripMarkdownForTTS(docMeta?.outro_narration || '').trim();

  if (includeSpokenFraming && introText) {
    spokenLines.push({
      type: 'intro',
      key: 'intro',
      label: 'Intro',
      text: introText,
      startSeconds: 0,
      endSeconds: null,
    });
  }

  const timedSteps = steps
    .filter((step) => {
      const hasTime = typeof step.start_seconds === 'number' && typeof step.end_seconds === 'number';
      const hasText = (step.title || '').trim() || (step.body_markdown || '').trim();
      return hasTime && hasText;
    })
    .map((step, index) => {
      const titleText = stripMarkdownForTTS(step.title || '').trim();
      const bodyText = stripMarkdownForTTS(step.body_markdown || '').trim();

      let text = '';
      if (flowing) {
        text = bodyText || titleText;
      } else {
        const parts = [];
        if (titleText) parts.push(`Step ${index + 1}. ${titleText}.`);
        if (bodyText) parts.push(bodyText);
        text = parts.join(' ').trim();
      }

      return {
        type: 'step',
        key: `step_${String(index).padStart(4, '0')}`,
        label: titleText || `Step ${index + 1}`,
        text,
        startSeconds: step.start_seconds,
        endSeconds: step.end_seconds,
        title: step.title || '',
        bodyMarkdown: step.body_markdown || '',
        stepIndex: index,
      };
    })
    .filter((line) => line.text);

  spokenLines.push(...timedSteps);

  if (includeSpokenFraming && outroText) {
    spokenLines.push({
      type: 'outro',
      key: 'outro',
      label: 'Outro',
      text: outroText,
      startSeconds: null,
      endSeconds: null,
    });
  }

  return {
    preset,
    flowing,
    includeSpokenFraming,
    spokenLines,
    totalSpeechSegments: spokenLines.length,
    fullText: spokenLines.map((line) => line.text).join('\n'),
  };
}

