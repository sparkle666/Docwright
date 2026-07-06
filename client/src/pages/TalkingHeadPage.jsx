import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { VideoProvider } from '../context/VideoContext.jsx';
import VideoPanel from '../components/VideoPanel.jsx';
import './TalkingHeadPage.css';

const IN_PROGRESS = new Set(['generating', 'stitching', 'rendering', 'compositing']);

const STAGE_LABEL = {
  generating: 'Synthesizing narration audio…',
  stitching:  'Assembling narration timeline…',
  rendering:  'Generating talking-head video…',
  compositing:'Compositing presenter bubble onto video…',
};

const PIPELINE_IN_PROGRESS = new Set([
  'extracting_audio', 'transcribing', 'writing_doc', 'extracting_frames', 'matching_screenshots',
]);

const PIPELINE_STAGE_LABEL = {
  extracting_audio:     'Extracting audio…',
  transcribing:         'Transcribing with Whisper…',
  writing_doc:          'Writing narration script…',
  extracting_frames:    'Scanning the video…',
  matching_screenshots: 'Finalizing…',
};

export default function TalkingHeadPage() {
  const { id } = useParams();
  const [project, setProject]             = useState(null);
  const [voices, setVoices]               = useState([]);
  const [models, setModels]               = useState([]);
  const [voice, setVoice]                 = useState('');
  const [model, setModel]                 = useState('');
  const [status, setStatus]               = useState(null);
  const [videoCacheKey, setVideoCacheKey] = useState(0);
  const [error, setError]                 = useState(null);
  const [busy, setBusy]                   = useState(false);
  const pollRef            = useRef(null);
  const pipelinePollRef    = useRef(null);

  const loadStatus = useCallback(() =>
    api.getTalkingHeadStatus(id).then((data) => {
      setStatus(data);
      return data;
    }), [id]);

  const loadProject = useCallback(() =>
    api.getProject(id).then((p) => {
      setProject(p.project);
      return p.project;
    }), [id]);

  useEffect(() => {
    api.listVoices().then((data) => {
      setVoices(data.voices);
      setModels(data.models);
      setVoice((v) => v || data.defaults.voice);
      setModel((m) => m || data.defaults.model);
    }).catch((err) => setError(err.message));
    loadStatus().catch((err) => setError(err.message));
    return () => { clearTimeout(pollRef.current); clearTimeout(pipelinePollRef.current); };
  }, [id, loadStatus]);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      if (cancelled) return;
      try {
        const p = await loadProject();
        if (cancelled) return;
        if (PIPELINE_IN_PROGRESS.has(p.status)) {
          if (document.visibilityState !== 'hidden') {
            pipelinePollRef.current = setTimeout(tick, 2500);
          }
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }
    function handleVisibility() {
      if (document.visibilityState === 'visible') { clearTimeout(pipelinePollRef.current); tick(); }
    }
    document.addEventListener('visibilitychange', handleVisibility);
    tick();
    return () => {
      cancelled = true;
      clearTimeout(pipelinePollRef.current);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [loadProject]);

  function poll() {
    loadStatus().then((data) => {
      if (IN_PROGRESS.has(data.talkingHeadStatus)) {
        pollRef.current = setTimeout(poll, 2500);
      } else if (data.talkingHeadStatus === 'complete') {
        setVideoCacheKey((k) => k + 1);
      }
    }).catch((err) => setError(err.message));
  }

  async function handleGenerate() {
    setError(null);
    setBusy(true);
    try {
      await api.startTalkingHead(id, { voice, model });
      poll();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore() {
    setError(null);
    setBusy(true);
    try {
      await api.restoreTalkingHeadVideo(id);
      await loadStatus();
      setVideoCacheKey((k) => k + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className="th-page">
        <Link to={`/projects/${id}`} className="back-link">← Back</Link>
        <div className="banner banner-error">{error}</div>
      </div>
    );
  }
  if (!project || !status) {
    return <div className="th-page"><div className="loading">Loading…</div></div>;
  }

  if (PIPELINE_IN_PROGRESS.has(project.status)) {
    return (
      <div className="th-page">
        <h1>Preparing your project</h1>
        <p className="th-sub">The documentation pipeline must finish before we can add a presenter.</p>
        <div className="th-progress">
          <span className="th-dot-pulse" />
          {PIPELINE_STAGE_LABEL[project.status] || 'Working…'}
        </div>
      </div>
    );
  }

  if (project.status === 'failed') {
    return (
      <div className="th-page">
        <div className="banner banner-error">
          Processing failed: {project.error_message || 'The pipeline failed unexpectedly.'}
        </div>
        <Link to={`/projects/${id}`} className="btn btn-secondary">View project</Link>
      </div>
    );
  }

  const inProgress = IN_PROGRESS.has(status.talkingHeadStatus);

  return (
    <VideoProvider src={`${api.videoUrl(id)}?v=${videoCacheKey}`}>
      <div className="th-page">
        <Link to={`/projects/${id}`} className="back-link">← Back to {project.title}</Link>
        <h1>Talking-head presenter</h1>
        <p className="th-sub">
          Adds an AI presenter bubble (bottom-right corner) that speaks the narration in sync
          with the video. The talking-head video replaces the audio — no separate voice-over
          track is added on top.
        </p>

        <div className="th-explainer">
          <div className="th-explainer-icon">🎙</div>
          <div>
            <strong>How it works</strong>
            <p>
              The narration is synthesized with the selected voice, then a talking-head video
              is generated to match that exact audio length. The presenter is overlaid as a
              picture-in-picture bubble in the lower-right of your screen recording.
            </p>
            <p className="th-mock-note">
              <em>Mock mode:</em> until you connect a real talking-head API, the bundled
              <code>talking-head.mp4</code> is looped to match the audio length. Drop-in
              replacement is one function swap in <code>talkingHeadService.js</code>.
            </p>
          </div>
        </div>

        <VideoPanel defaultOpen label="Preview (reflects current state of the project video)" />

        <div className="th-controls">
          <label className="th-field">
            <span>Voice</span>
            <select value={voice} onChange={(e) => setVoice(e.target.value)} disabled={inProgress}>
              {voices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </label>

          <label className="th-field">
            <span>Model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={inProgress}>
              {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
        </div>

        {inProgress && (
          <div className="th-progress">
            <span className="th-dot-pulse" />
            {STAGE_LABEL[status.talkingHeadStatus] || 'Working…'}
          </div>
        )}

        {status.talkingHeadStatus === 'failed' && (
          <div className="banner banner-error">
            Last attempt failed: {status.talkingHeadError}
          </div>
        )}

        <div className="th-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleGenerate}
            disabled={busy || inProgress || !voice || !model}
          >
            {inProgress
              ? 'Generating…'
              : status.talkingHeadStatus === 'complete'
                ? 'Regenerate presenter'
                : 'Add talking-head presenter'}
          </button>

          {status.canRestore && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleRestore}
              disabled={busy || inProgress}
            >
              Remove presenter (restore video)
            </button>
          )}
        </div>

        {status.talkingHeadStatus === 'complete' && status.talkingHeadGeneratedAt && (
          <p className="th-meta">
            Last generated {new Date(status.talkingHeadGeneratedAt).toLocaleString()} with
            voice "{status.talkingHeadVoice}". Refresh the preview if the video doesn't update.
          </p>
        )}
      </div>
    </VideoProvider>
  );
}
