import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client.js';
import StatusPill from '../components/StatusPill.jsx';
import './AssetsPage.css';

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '00:00';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function formatBytesFromSeconds(seconds) {
  if (!Number.isFinite(seconds)) return null;
  return `${Math.round(seconds)}s`;
}

const VOICE_STATUS_LABELS = {
  generating: 'Generating…',
  stitching: 'Stitching audio…',
  muxing: 'Muxing into video…',
  complete: 'Complete',
  failed: 'Failed',
};

const EXPORT_FORMATS = [
  { key: 'markdown', label: 'Markdown (.md)' },
  { key: 'html', label: 'HTML (.html)' },
  { key: 'pdf', label: 'PDF (.pdf)' },
  { key: 'docx', label: 'Word (.docx)' },
];

function AssetSection({ title, subtitle, children, count }) {
  return (
    <section className="asset-section">
      <div className="asset-section-head">
        <h2>{title}{typeof count === 'number' ? <span className="asset-count">{count}</span> : null}</h2>
        {subtitle && <p className="asset-section-sub">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

export default function AssetsPage() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [exportPending, setExportPending] = useState(null);
  const [exportError, setExportError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.getAssets(id)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [id]);

  async function runExport(format) {
    setExportPending(format);
    setExportError(null);
    try {
      await api.downloadExport(id, format);
    } catch (err) {
      setExportError(err.message);
    } finally {
      setExportPending(null);
    }
  }

  if (error) {
    return (
      <div className="assets-page">
        <Link to={`/projects/${id}`} className="back-link">← Back</Link>
        <div className="banner banner-error">{error}</div>
      </div>
    );
  }

  if (!data) {
    return <div className="assets-page"><div className="loading">Loading assets…</div></div>;
  }

  const { project, meta, steps, frames, transcript, media, voice, exports, cost } = data;
  const segments = transcript?.raw_json?.segments || [];

  return (
    <div className="assets-page">
      <Link to={`/projects/${id}`} className="back-link">← Back to {project.title}</Link>

      <div className="assets-header">
        <div>
          <h1>All assets</h1>
          <p className="assets-sub">Everything generated for “{project.title}” — video, audio, transcript, documentation, screenshots, and exports, in one place.</p>
        </div>
        <StatusPill status={project.status} />
      </div>

      {/* ─── Video ─────────────────────────────────────────────── */}
      <AssetSection title="Video" subtitle={media.video.durationSeconds ? `${formatBytesFromSeconds(media.video.durationSeconds)} · source recording` : 'Source recording'}>
        {media.video.available ? (
          <video className="asset-media-player" src={media.video.url} controls preload="metadata" />
        ) : (
          <div className="asset-empty">No video file available for this project.</div>
        )}
      </AssetSection>

      {/* ─── Audio ─────────────────────────────────────────────── */}
      <AssetSection title="Audio" subtitle="Extracted audio track sent to Whisper for transcription">
        {media.audio.available ? (
          <audio className="asset-audio-player" src={media.audio.url} controls preload="metadata" />
        ) : (
          <div className="asset-empty">No extracted audio available yet — this is generated during the “extracting audio” pipeline stage.</div>
        )}
      </AssetSection>

      {/* ─── Transcript ────────────────────────────────────────── */}
      <AssetSection
        title="Transcript"
        count={segments.length || undefined}
        subtitle={transcript ? (transcript.is_edited ? 'Edited by you after Whisper generated it' : 'Raw Whisper output') : 'Not transcribed yet'}
      >
        {transcript ? (
          <>
            <p className="asset-transcript-preview">
              {transcript.full_text?.slice(0, 320)}
              {transcript.full_text?.length > 320 ? '…' : ''}
            </p>
            <Link to={`/projects/${id}/transcript`} className="btn btn-secondary btn-sm">
              Open full transcript →
            </Link>
          </>
        ) : (
          <div className="asset-empty">No transcript available for this project.</div>
        )}
      </AssetSection>

      {/* ─── Documentation ─────────────────────────────────────── */}
      <AssetSection title="Documentation" count={steps.length || undefined} subtitle={meta?.summary || 'Generated step-by-step guide'}>
        {steps.length > 0 ? (
          <ol className="asset-steps-list">
            {steps.map((step) => (
              <li key={step.id} className="asset-step-item">
                <span className="asset-step-time">
                  {step.start_seconds != null ? formatTime(step.start_seconds) : '—'}
                </span>
                <span className="asset-step-title">{step.title}</span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="asset-empty">No documentation steps generated yet.</div>
        )}
        <Link to={`/projects/${id}`} className="btn btn-secondary btn-sm">
          Open documentation editor →
        </Link>
      </AssetSection>

      {/* ─── Screenshots / frames ──────────────────────────────── */}
      <AssetSection title="Screenshots" count={frames.length || undefined} subtitle="Frames extracted from the video and matched to steps">
        {frames.length > 0 ? (
          <div className="asset-frame-grid">
            {frames.map((frame) => (
              <figure key={frame.id} className="asset-frame">
                <img src={frame.url} alt={`Frame at ${formatTime(frame.timestamp_seconds)}`} loading="lazy" />
                <figcaption>{formatTime(frame.timestamp_seconds)} · {frame.source}</figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <div className="asset-empty">No screenshots extracted yet.</div>
        )}
      </AssetSection>

      {/* ─── AI voice-over ─────────────────────────────────────── */}
      <AssetSection title="AI voice-over" subtitle="On-demand narration generated from the transcript">
        {voice.status ? (
          <div className="asset-voice-info">
            <span className={`asset-voice-badge asset-voice-${voice.status}`}>
              {VOICE_STATUS_LABELS[voice.status] || voice.status}
            </span>
            {voice.voiceName && <span>Voice: {voice.voiceName}</span>}
            {voice.voiceModel && <span>Model: {voice.voiceModel}</span>}
            {voice.generatedAt && <span>Generated: {new Date(voice.generatedAt).toLocaleString()}</span>}
            {voice.error && <span className="asset-voice-error">{voice.error}</span>}
          </div>
        ) : (
          <div className="asset-empty">No AI voice-over generated yet.</div>
        )}
        <Link to={`/projects/${id}/voice`} className="btn btn-secondary btn-sm">
          Open voice-over tool →
        </Link>
      </AssetSection>

      {/* ─── Exports ───────────────────────────────────────────── */}
      <AssetSection title="Exports" subtitle="Download the documentation in another format">
        <div className="asset-export-row">
          {EXPORT_FORMATS.map((f) => (
            <button
              key={f.key}
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => runExport(f.key)}
              disabled={exportPending !== null}
            >
              {exportPending === f.key ? (
                <><span className="btn-spinner" /> Preparing…</>
              ) : f.label}
            </button>
          ))}
        </div>
        {exportError && <div className="asset-empty asset-export-error">{exportError}</div>}
      </AssetSection>

      {/* ─── Cost / usage ──────────────────────────────────────── */}
      {cost?.breakdown?.length > 0 && (
        <AssetSection title="Generation cost" subtitle={`Estimated total: $${cost.total_usd.toFixed(4)}`}>
          <table className="asset-cost-table">
            <thead>
              <tr>
                <th>Service</th>
                <th>Model</th>
                <th>Input tokens</th>
                <th>Output tokens</th>
                <th>Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {cost.breakdown.map((row) => (
                <tr key={row.id}>
                  <td>{row.service}</td>
                  <td>{row.model}</td>
                  <td>{row.input_tokens}</td>
                  <td>{row.output_tokens}</td>
                  <td>${row.estimated_cost_usd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </AssetSection>
      )}
    </div>
  );
}
