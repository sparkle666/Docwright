import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { DragDropContext, Droppable } from '@hello-pangea/dnd';
import { api } from '../api/client.js';
import { VideoProvider } from '../context/VideoContext.jsx';
import VideoPanel from '../components/VideoPanel.jsx';
import StatusPill from '../components/StatusPill.jsx';
import StepCard from '../components/StepCard.jsx';
import { getExportHistory, recordExport } from '../utils/exportHistory.js';
import './ProjectPage.css';

const PIPELINE_STAGES = [
  { key: 'extracting_audio', label: 'Extracting audio' },
  { key: 'transcribing', label: 'Transcribing with Whisper' },
  { key: 'writing_doc', label: 'Writing documentation' },
  { key: 'extracting_frames', label: 'Scanning video for key frames' },
  { key: 'matching_screenshots', label: 'Matching screenshots to steps' },
];

const IN_PROGRESS_STATUSES = new Set(PIPELINE_STAGES.map((s) => s.key));

const EXPORT_FORMATS = [
  { key: 'markdown', label: 'Export .md' },
  { key: 'html', label: 'Export .html' },
  { key: 'pdf', label: 'Export .pdf', hint: 'Can take 10–30s for longer guides' },
  { key: 'docx', label: 'Export .docx' },
];

function PipelineProgress({ status }) {
  const currentIndex = PIPELINE_STAGES.findIndex((s) => s.key === status);
  return (
    <div className="pipeline-progress">
      <h2>Generating your documentation</h2>
      <p className="pipeline-sub">This runs Whisper transcription, GPT-4 writing, and GPT-4 Vision screenshot matching — it can take a few minutes for longer videos.</p>
      <ol className="pipeline-steps">
        {PIPELINE_STAGES.map((stage, idx) => {
          const state = idx < currentIndex ? 'done' : idx === currentIndex ? 'active' : 'pending';
          return (
            <li key={stage.key} className={`pipeline-step pipeline-step-${state}`}>
              <span className="pipeline-step-dot" />
              <span>{stage.label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ExportRow({ projectId }) {
  const [pending, setPending] = useState(null);
  const [history, setHistory] = useState(() => getExportHistory(projectId));
  const [error, setError] = useState(null);

  async function runExport(format) {
    setPending(format);
    setError(null);
    try {
      await api.downloadExport(projectId, format);
      setHistory(recordExport(projectId, format));
    } catch (err) {
      setError(err.message);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="export-block">
      <div className="export-row">
        {EXPORT_FORMATS.map((f) => (
          <button
            key={f.key}
            type="button"
            className="btn btn-secondary btn-sm"
            title={f.hint}
            onClick={() => runExport(f.key)}
            disabled={pending !== null}
          >
            {pending === f.key ? (
              <>
                <span className="btn-spinner" /> Preparing…
              </>
            ) : f.label}
          </button>
        ))}
      </div>
      {error && <div className="export-error">{error}</div>}

      {history.length > 0 && (
        <div className="export-history">
          <span className="export-history-label">Recent exports</span>
          <ul className="export-history-list">
            {history.map((entry, idx) => (
              <li key={`${entry.format}-${entry.at}-${idx}`}>
                <button type="button" className="export-history-item" onClick={() => runExport(entry.format)}>
                  {entry.format} · {new Date(entry.at).toLocaleString()}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function ProjectPage() {
  const { id } = useParams();
  const [project, setProject] = useState(null);
  const [meta, setMeta] = useState(null);
  const [steps, setSteps] = useState([]);
  const [frames, setFrames] = useState([]);
  const [error, setError] = useState(null);
  const pollTimerRef = useRef(null);
  const previousOrderRef = useRef(null);

  const loadDoc = useCallback(async () => {
    const data = await api.getDoc(id);
    setProject(data.project);
    setMeta(data.meta);
    setSteps(data.steps);
    setFrames(data.frames);
    return data.project;
  }, [id]);

  // Polls while the pipeline is running, but pauses while the tab is hidden
  // so we don't burn requests (and the user's battery) on a backgrounded tab.
  useEffect(() => {
    let cancelled = false;

    async function tick() {
      if (cancelled) return;
      try {
        const p = await loadDoc();
        if (cancelled) return;
        scheduleNext(p.status);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }

    function scheduleNext(status) {
      clearTimeout(pollTimerRef.current);
      if (!IN_PROGRESS_STATUSES.has(status)) return;
      if (document.visibilityState === 'hidden') return;
      pollTimerRef.current = setTimeout(tick, 2500);
    }

    function handleVisibility() {
      if (document.visibilityState === 'visible') {
        clearTimeout(pollTimerRef.current);
        tick();
      }
    }

    document.addEventListener('visibilitychange', handleVisibility);
    tick();

    return () => {
      cancelled = true;
      clearTimeout(pollTimerRef.current);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [loadDoc]);

  // Ctrl/Cmd+Z undoes the most recent drag-and-drop reorder (not while typing).
  useEffect(() => {
    function handleKeyDown(e) {
      const active = document.activeElement;
      const isTyping = active && ['INPUT', 'TEXTAREA'].includes(active.tagName);
      if (isTyping) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && previousOrderRef.current) {
        e.preventDefault();
        const prev = previousOrderRef.current;
        previousOrderRef.current = null;
        setSteps(prev);
        api.reorderSteps(id, prev.map((s) => s.id)).catch((err) => setError(err.message));
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [id]);

  const framesById = Object.fromEntries(frames.map((f) => [f.id, f]));

  function handleStepUpdated(updated) {
    setSteps((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    if (updated.screenshot_frame_id) {
      // Refresh frames list in case a new one was just captured
      api.getDoc(id).then((data) => setFrames(data.frames));
    }
  }

  async function handleStepDeleted(stepId) {
    if (!confirm('Delete this step?')) return;
    await api.deleteStep(id, stepId);
    setSteps((prev) => prev.filter((s) => s.id !== stepId));
  }

  async function handleAddStep() {
    const { step } = await api.addStep(id, { title: 'New step', body_markdown: '' });
    setSteps((prev) => [...prev, step]);
  }

  async function handleDragEnd(result) {
    if (!result.destination) return;
    previousOrderRef.current = steps;
    const reordered = Array.from(steps);
    const [moved] = reordered.splice(result.source.index, 1);
    reordered.splice(result.destination.index, 0, moved);
    setSteps(reordered);
    await api.reorderSteps(id, reordered.map((s) => s.id));
  }

  async function handleRetry() {
    await api.startProcessing(id);
    loadDoc();
  }

  if (error) return <div className="project-page"><div className="banner banner-error">{error}</div></div>;
  if (!project) return <div className="project-page"><div className="loading">Loading…</div></div>;

  if (IN_PROGRESS_STATUSES.has(project.status)) {
    return <div className="project-page"><PipelineProgress status={project.status} /></div>;
  }

  if (project.status === 'failed') {
    return (
      <div className="project-page">
        <div className="pipeline-failed">
          <h2>Something went wrong</h2>
          <p>{project.error_message || 'The pipeline failed unexpectedly.'}</p>
          <button className="btn btn-primary" onClick={handleRetry}>Retry processing</button>
        </div>
      </div>
    );
  }

  if (project.status === 'uploaded') {
    return (
      <div className="project-page">
        <div className="pipeline-failed">
          <h2>Ready to process</h2>
          <p>Your video is uploaded. Start the AI pipeline to generate documentation.</p>
          <button className="btn btn-primary" onClick={handleRetry}>Generate documentation</button>
        </div>
      </div>
    );
  }

  return (
    <VideoProvider src={api.videoUrl(id)}>
      <div className="project-page">
        <div className="project-header">
          <div>
            <h1>{project.title}</h1>
            <div className="project-header-meta">
              <StatusPill status={project.status} />
              <Link to={`/projects/${id}/assets`} className="transcript-link">View all assets →</Link>
              <Link to={`/projects/${id}/transcript`} className="transcript-link">View transcript →</Link>
              <Link to={`/projects/${id}/voice`} className="transcript-link">AI voice-over →</Link>
            </div>
          </div>
          <ExportRow projectId={id} />
        </div>

        <VideoPanel />

        {meta?.summary && (
          <div className="doc-meta-block">
            <p>{meta.summary}</p>
            <div className="doc-meta-tags">
              {meta.audience && <span className="doc-meta-tag">Audience: {meta.audience}</span>}
              {meta.prerequisites && <span className="doc-meta-tag">Prerequisites: {meta.prerequisites}</span>}
            </div>
          </div>
        )}

        <DragDropContext onDragEnd={handleDragEnd}>
          <Droppable droppableId="steps">
            {(provided) => (
              <div className="steps-list" ref={provided.innerRef} {...provided.droppableProps}>
                {steps.map((step, idx) => (
                  <StepCard
                    key={step.id}
                    step={step}
                    index={idx}
                    projectId={id}
                    frame={step.screenshot_frame_id ? framesById[step.screenshot_frame_id] : null}
                    onUpdated={handleStepUpdated}
                    onDeleted={handleStepDeleted}
                  />
                ))}
                {provided.placeholder}
              </div>
            )}
          </Droppable>
        </DragDropContext>

        <button className="btn btn-secondary add-step-btn" onClick={handleAddStep}>+ Add step</button>
      </div>
    </VideoProvider>
  );
}
