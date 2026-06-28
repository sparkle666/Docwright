/**
 * Unit tests for visionSelectionService.js — mocks OpenAI and fs.
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

// Mock fs so we don't need real image files
jest.unstable_mockModule('fs', () => ({
  default: { readFileSync: jest.fn(() => Buffer.from('fake-image-bytes')) },
  readFileSync: jest.fn(() => Buffer.from('fake-image-bytes')),
}));

const { selectBestFrameForStep, findCandidateFrames } =
  await import('../src/services/visionSelectionService.js');

const step = { title: 'Click the button', body_markdown: 'Click **Submit**', start_seconds: 5, end_seconds: 15 };

const candidates = [
  { id: 'frame-a', timestampSeconds: 6,  filePath: '/tmp/a.jpg' },
  { id: 'frame-b', timestampSeconds: 10, filePath: '/tmp/b.jpg' },
  { id: 'frame-c', timestampSeconds: 14, filePath: '/tmp/c.jpg' },
];

describe('selectBestFrameForStep', () => {
  beforeEach(() => mockCreate.mockReset());

  test('returns null with empty candidates', async () => {
    const r = await selectBestFrameForStep({ step, candidates: [] });
    expect(r.chosenFrameId).toBeNull();
  });

  test('returns the only candidate without calling GPT', async () => {
    const r = await selectBestFrameForStep({ step, candidates: [candidates[0]] });
    expect(r.chosenFrameId).toBe('frame-a');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('picks the GPT-chosen candidate by index', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ chosen_index: 1, rationale: 'Best frame' }) } }],
      usage: { prompt_tokens: 200, completion_tokens: 10 },
    });
    const r = await selectBestFrameForStep({ step, candidates });
    expect(r.chosenFrameId).toBe('frame-b');
    expect(r.rationale).toBe('Best frame');
  });

  test('does not send temperature to the OpenAI API', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ chosen_index: 1, rationale: 'Best frame' }) } }],
      usage: { prompt_tokens: 200, completion_tokens: 10 },
    });

    await selectBestFrameForStep({ step, candidates });

    const request = mockCreate.mock.calls[0][0];
    expect(request).not.toHaveProperty('temperature');
  });

  test('returns null when GPT says chosen_index is -1', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ chosen_index: -1, rationale: 'All blurry' }) } }],
      usage: {},
    });
    const r = await selectBestFrameForStep({ step, candidates });
    expect(r.chosenFrameId).toBeNull();
  });

  test('falls back to midpoint candidate when GPT returns invalid JSON', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'oops not json' } }],
      usage: {},
    });
    const r = await selectBestFrameForStep({ step, candidates });
    expect(r.chosenFrameId).toBe(candidates[Math.floor(candidates.length / 2)].id);
  });
});

describe('findCandidateFrames', () => {
  const allFrames = [
    { id: 'f1', timestamp_seconds: 2,  file_path: '/a.jpg' },
    { id: 'f2', timestamp_seconds: 8,  file_path: '/b.jpg' },
    { id: 'f3', timestamp_seconds: 12, file_path: '/c.jpg' },
    { id: 'f4', timestamp_seconds: 50, file_path: '/d.jpg' },
  ];

  test('returns frames within the padded time window', () => {
    const s = { start_seconds: 7, end_seconds: 13 };
    const r = findCandidateFrames(allFrames, s, 2);
    const ids = r.map((f) => f.id);
    expect(ids).toContain('f2');
    expect(ids).toContain('f3');
    expect(ids).not.toContain('f4');
  });

  test('widens search window when no frames found initially', () => {
    const s = { start_seconds: 30, end_seconds: 35 };
    const r = findCandidateFrames(allFrames, s, 2);
    // Should eventually find f4 at 50s by widening padding
    expect(r.length).toBeGreaterThan(0);
  });
});
