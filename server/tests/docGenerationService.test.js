/**
 * Unit tests for docGenerationService.js — mocks the OpenAI client.
 */

import { jest } from '@jest/globals';

const mockCreate = jest.fn();

jest.unstable_mockModule('../src/services/openaiClient.js', () => ({
  getOpenAIClient: () => ({
    chat: { completions: { create: mockCreate } },
  }),
}));

jest.unstable_mockModule('../src/db/repository.js', () => ({
  logUsage: jest.fn(),
}));

const { generateStructuredDoc } = await import('../src/services/docGenerationService.js');

function makeValidResponse(overrides = {}) {
  return {
    choices: [{ message: { content: JSON.stringify({
      summary: 'A test summary',
      audience: 'Developers',
      prerequisites: 'None',
      steps: [
        { title: 'Step one', body_markdown: 'Do **this**', start_seconds: 0, end_seconds: 10 },
        { title: 'Step two', body_markdown: 'Then do **that**', start_seconds: 10, end_seconds: 20 },
      ],
      ...overrides,
    }) } }],
    usage: { prompt_tokens: 500, completion_tokens: 100 },
  };
}

describe('generateStructuredDoc', () => {
  beforeEach(() => mockCreate.mockReset());

  test('parses a valid GPT response into structured steps', async () => {
    mockCreate.mockResolvedValueOnce(makeValidResponse());
    const result = await generateStructuredDoc({
      timestampedText: '[00:00] Hello world',
      docType: 'step_by_step',
      title: 'Test video',
    });
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].title).toBe('Step one');
    expect(result.summary).toBe('A test summary');
  });

  test('normalizes missing step fields gracefully', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({
        summary: '',
        audience: '',
        prerequisites: '',
        steps: [{ title: '', body_markdown: null, start_seconds: 'not-a-number', end_seconds: null }],
      }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });
    const result = await generateStructuredDoc({
      timestampedText: '[00:00] Hello',
      docType: 'step_by_step',
      title: 'Test',
    });
    expect(result.steps[0].title).toBe('Step 1');
    expect(result.steps[0].body_markdown).toBe('');
    expect(result.steps[0].start_seconds).toBeNull();
  });

  test('does not send temperature to the OpenAI API', async () => {
    mockCreate.mockResolvedValueOnce(makeValidResponse());
    await generateStructuredDoc({
      timestampedText: '[00:00] Hello',
      docType: 'step_by_step',
      title: 'Test',
    });

    const request = mockCreate.mock.calls[0][0];
    expect(request).not.toHaveProperty('temperature');
  });

  test('throws when GPT returns invalid JSON', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'not json at all' } }],
      usage: {},
    });
    await expect(generateStructuredDoc({
      timestampedText: '[00:00] Hi',
      docType: 'step_by_step',
      title: 'Bad',
    })).rejects.toThrow('invalid JSON');
  });

  test('throws when steps array is missing', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ summary: 'ok', steps: 'not-an-array' }) } }],
      usage: {},
    });
    await expect(generateStructuredDoc({
      timestampedText: '[00:00] Hi',
      docType: 'step_by_step',
      title: 'Bad',
    })).rejects.toThrow('"steps" array');
  });
});
