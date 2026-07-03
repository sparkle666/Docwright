import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { VideoProvider } from '../context/VideoContext.jsx';
import VideoPanel from '../components/VideoPanel.jsx';
import './VoiceOverPage.css';

const IN_PROGRESS = new Set(['generating', 'stitching', 'muxing']);

const STAGE_LABEL = {
  generating: 'Synthesizing speech for each transcript segment…',
  stitching: 'Fitting clips to the original timing…',
  muxing: 'Combining the new audio with your video…',
};

// Background pipeline stages the project passes through before it has
// steps/timestamps to narrate at all — this page can be reached before
// that finishes (e.g. from the "New AI video" flow, which skips the doc
// review page entirely), so we need our own progress view for it.
const PIPELINE_IN_PROGRESS = new Set([
  'extracting_audio', 'transcribing', 'writing_doc', 'extracting_frames', 'matching_screenshots',
]);

const PIPELINE_STAGE_LABEL = {
  extracting_audio: 'Extracting audio…',
  transcribing: 'Transcribing with Whisper…',
  writing_doc: 'Writing the narration script…',
  extracting_frames: 'Scanning the video…',
  matching_screenshots: 'Finalizing…',
};

export default function VoiceOverPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  // Set by the "New AI video" flow so this page kicks off generation
  // automatically the moment the project is ready, instead of making the
  // user click through a doc-review step first.
  const autoStart = searchParams.get('auto') === '1';
  const autoStartedRef = useRef(false);

  const [project, setProject] = useState(null);
  const [voices, setVoices] = useState([]);
  const [models, setModels] = useState([]);
  const [voice, setVoice] = useState('');
  const [model, setModel] = useState('');
  const [status, setStatus] = useState(null);
  const [videoCacheKey, setVideoCacheKey] = useState(0);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef(null);
  const pipelinePollRef = useRef(null);

  const loadStatus = useCallback(() => api.getVoiceStatus(id).then((data) => {
    setStatus(data);
    if (data.voiceName) setVoice((v) => v || data.voiceName);
    if (data.voiceModel) setModel((m) => m || data.voiceModel);
    return data;
  }), [id]);

  const loadProject = useCallback(() => api.getProject(id).then((p) => {
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

  // Polls the underlying doc-generation pipeline (transcription/step
  // breakdown) while it's still running, since that has to finish before
  // there's anything to narrate. Pauses while the tab is hidden.
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
      if (document.visibilityState === 'visible') {
        clearTimeout(pipelinePollRef.current);
        tick();
      }
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
      if (IN_PROGRESS.has(data.voiceStatus)) {
        pollRef.current = setTimeout(poll, 2500);
      } else if (data.voiceStatus === 'complete') {
        setVideoCacheKey((k) => k + 1);
      }
    }).catch((err) => setError(err.message));
  }

  async function handleGenerate() {
    setError(null);
    setBusy(true);
    try {
      await api.startVoiceGeneration(id, { voice, model });
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
      await api.restoreOriginalVideo(id);
      await loadStatus();
      setVideoCacheKey((k) => k + 1);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Once the pipeline is done and we have a voice + model to use, fire off
  // generation automatically for the "New AI video" flow — this is the
  // whole point of that entry point: no manual step in between.
  useEffect(() => {
    if (!autoStart || autoStartedRef.current) return;
    if (!project || PIPELINE_IN_PROGRESS.has(project.status) || project.status === 'failed') return;
    if (!status || status.voiceStatus) return; // already started/complete at some point
    if (!voice || !model) return;

    autoStartedRef.current = true;
    handleGenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, project, status, voice, model]);

  if (error) {
    return (
      <div className="voice-page">
        <Link to={`/projects/${id}`} className="back-link">← Back</Link>
        <div className="banner banner-error">{error}</div>
      </div>
    );
  }
  if (!project || !status) {
    return <div className="voice-page"><div className="loading">Loading…</div></div>;
  }

  if (PIPELINE_IN_PROGRESS.has(project.status)) {
    return (
      <div className="voice-page">
        <h1>Preparing your AI video</h1>
        <p className="voice-page-sub">
          We're transcribing the recording and scripting the narration in the background —
          this finishes on its own, no review needed.
        </p>
        <div className="voice-progress">
          <span className="voice-dot-pulse" />
          {PIPELINE_STAGE_LABEL[project.status] || 'Working…'}
        </div>
      </div>
    );
  }

  if (project.status === 'failed') {
    return (
      <div className="voice-page">
        <div className="banner banner-error">
          Processing failed: {project.error_message || 'The pipeline failed unexpectedly.'}
        </div>
        <Link to={`/projects/${id}`} className="btn btn-secondary">View project</Link>
      </div>
    );
  }

  const inProgress = IN_PROGRESS.has(status.voiceStatus);

  return (
    <VideoProvider src={`${api.videoUrl(id)}?v=${videoCacheKey}`}>
      <div className="voice-page">
        <Link to={`/projects/${id}`} className="back-link">← Back to {project.title}</Link>
        <h1>AI voice-over</h1>
        <p className="voice-page-sub">
          Replace this video's audio with an AI voice reading the transcript, fitted to the
          original timing (silence where pauses were, slight pitch-preserved speed-up if a clip
          runs long). This overwrites the video's audio in place — you can restore the original
          any time afterward.
        </p>

        <VideoPanel defaultOpen label="Preview (this is the actual project video, with whatever audio is currently active)" />

        <div className="voice-controls">
          <label className="voice-field">
            <span>Voice</span>
            <select value={voice} onChange={(e) => setVoice(e.target.value)} disabled={inProgress}>
              {voices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </label>

          <label className="voice-field">
            <span>Model</span>
            <select value={model} onChange={(e) => setModel(e.target.value)} disabled={inProgress}>
              {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
        </div>

        {inProgress && (
          <div className="voice-progress">
            <span className="voice-dot-pulse" />
            {STAGE_LABEL[status.voiceStatus] || 'Working…'}
          </div>
        )}

        {status.voiceStatus === 'failed' && (
          <div className="banner banner-error">Last attempt failed: {status.voiceError}</div>
        )}

        <div className="voice-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleGenerate}
            disabled={busy || inProgress || !voice || !model}
          >
            {inProgress ? 'Generating…' : status.voiceStatus === 'complete' ? 'Regenerate' : 'Generate AI voice-over'}
          </button>

          {status.canRestore && (
            <button type="button" className="btn btn-secondary" onClick={handleRestore} disabled={busy || inProgress}>
              Restore original audio
            </button>
          )}
        </div>

        {status.voiceStatus === 'complete' && status.voiceGeneratedAt && (
          <p className="voice-meta">
            Last generated {new Date(status.voiceGeneratedAt).toLocaleString()} with voice "{status.voiceName}".
            Reopen the preview above (or refresh) if it doesn't update right away — browsers
            sometimes cache video data.
          </p>
        )}
      </div>
    </VideoProvider>
  );
}
