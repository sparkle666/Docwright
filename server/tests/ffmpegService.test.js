/**
 * Unit tests for ffmpegService.js — mocks child_process.spawn to verify
 * the correct ffmpeg/ffprobe arguments are built for each scenario.
 */

import { jest } from '@jest/globals';

// ── Mock child_process.spawn ──────────────────────────────────────────────────
const mockSpawn = jest.fn();

jest.unstable_mockModule('child_process', () => ({
  spawn: mockSpawn,
}));

// ── Helper: create a fake spawn process ──────────────────────────────────────
function fakeProcess({ stdout = '', stderr = '', exitCode = 0, error = null } = {}) {
  const proc = {
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
    on: jest.fn(),
    kill: jest.fn(),
  };

  // Schedule event emission asynchronously
  setImmediate(() => {
    if (error) {
      const errCb = proc.on.mock.calls.find(([e]) => e === 'error')?.[1];
      if (errCb) errCb(error);
      return;
    }

    const stdoutCb = proc.stdout.on.mock.calls.find(([e]) => e === 'data')?.[1];
    const stderrCb = proc.stderr.on.mock.calls.find(([e]) => e === 'data')?.[1];
    const closeCb  = proc.on.mock.calls.find(([e]) => e === 'close')?.[1];

    if (stdoutCb && stdout) stdoutCb(Buffer.from(stdout));
    if (stderrCb && stderr) stderrCb(Buffer.from(stderr));
    if (closeCb)  closeCb(exitCode);
  });

  return proc;
}

const { extractAudio, getVideoDuration, extractFrameAtTimestamp, extractIntervalFrames, checkFfmpegAvailable } =
  await import('../src/services/ffmpegService.js');

// ─────────────────────────────────────────────────────────────────────────────

describe('checkFfmpegAvailable', () => {
  test('resolves with version string on success', async () => {
    mockSpawn.mockReturnValueOnce(fakeProcess({ stdout: 'ffmpeg version 6.0 ...\nline2' }));
    const v = await checkFfmpegAvailable();
    expect(v).toBe('ffmpeg version 6.0 ...');
  });

  test('rejects when ffmpeg exits with non-zero', async () => {
    mockSpawn.mockReturnValueOnce(fakeProcess({ exitCode: 1 }));
    await expect(checkFfmpegAvailable()).rejects.toThrow();
  });
});

describe('getVideoDuration', () => {
  test('calls ffprobe with correct arguments and parses duration', async () => {
    mockSpawn.mockReturnValueOnce(fakeProcess({ stdout: '  42.750\n' }));
    const duration = await getVideoDuration('/tmp/video.mp4');
    expect(duration).toBeCloseTo(42.75);

    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe('ffprobe');
    expect(args).toContain('/tmp/video.mp4');
    expect(args).toContain('-show_entries');
    expect(args).toContain('format=duration');
  });

  test('rejects when ffprobe exits with non-zero', async () => {
    mockSpawn.mockReturnValueOnce(fakeProcess({ exitCode: 1, stderr: 'no such file' }));
    await expect(getVideoDuration('/bad/path.mp4')).rejects.toThrow('ffprobe failed');
  });
});

describe('extractAudio', () => {
  test('calls ffmpeg with WAV extraction arguments', async () => {
    mockSpawn.mockReturnValueOnce(fakeProcess());
    await extractAudio('/input/video.mp4', '/output/audio.wav');

    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe('ffmpeg');
    expect(args).toContain('/input/video.mp4');
    expect(args).toContain('/output/audio.wav');
    expect(args).toContain('pcm_s16le');
    expect(args).toContain('16000');
  });

  test('rejects when ffmpeg exits non-zero', async () => {
    mockSpawn.mockReturnValueOnce(fakeProcess({ exitCode: 1, stderr: 'codec error' }));
    await expect(extractAudio('/in.mp4', '/out.wav')).rejects.toThrow();
  });
});

describe('extractFrameAtTimestamp', () => {
  test('calls ffmpeg with correct seek and output arguments', async () => {
    mockSpawn.mockReturnValueOnce(fakeProcess());
    await extractFrameAtTimestamp('/input/video.mp4', 30.5, '/output/frame.jpg');

    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe('ffmpeg');
    expect(args).toContain('30.5');
    expect(args).toContain('/input/video.mp4');
    expect(args).toContain('/output/frame.jpg');
    expect(args).toContain('-frames:v');
    expect(args).toContain('1');
  });
});

describe('extractIntervalFrames', () => {
  test('builds an fps filter from the interval and parses timestamps from showinfo', async () => {
    const os = await import('os');
    const fs = await import('fs');
    const path = await import('path');
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'interval-frames-'));

    // Simulate ffmpeg having written two interval frames before our code reads the dir back.
    mockSpawn.mockReturnValueOnce(fakeProcess({
      stderr:
        '[Parsed_showinfo_1 @ 0x0] n:0 pts_time:0.000000\n' +
        '[Parsed_showinfo_1 @ 0x0] n:1 pts_time:3.000000\n',
    }));

    const writeFakeFrames = () => {
      fs.writeFileSync(path.join(outputDir, 'interval_00001.jpg'), Buffer.from([0xff, 0xd8]));
      fs.writeFileSync(path.join(outputDir, 'interval_00002.jpg'), Buffer.from([0xff, 0xd8]));
    };
    // Write the files synchronously before the awaited spawn promise resolves
    // (the mocked process resolves on setImmediate, same tick as our write).
    writeFakeFrames();

    const frames = await extractIntervalFrames('/input/video.mp4', outputDir, 3);

    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe('ffmpeg');
    expect(args.join(' ')).toContain('fps=1/3');

    expect(frames).toHaveLength(2);
    expect(frames[0].timestampSeconds).toBeCloseTo(0);
    expect(frames[1].timestampSeconds).toBeCloseTo(3);
    expect(frames[0].filePath).toContain('interval_00001.jpg');

    fs.rmSync(outputDir, { recursive: true, force: true });
  });
});
