import React, { useEffect, useState } from 'react';
import { Draggable } from '@hello-pangea/dnd';
import ReactMarkdown from 'react-markdown';
import { api } from '../api/client.js';
import { useVideo } from '../context/VideoContext.jsx';
import './StepCard.css';

function formatTime(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function HistoryPanel({ projectId, stepId, onClose, onRestored }) {
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);
  const [restoringId, setRestoringId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.getStepHistory(projectId, stepId)
      .then((data) => { if (!cancelled) setHistory(data.history); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [projectId, stepId]);

  async function restore(historyId) {
    setRestoringId(historyId);
    try {
      const { step: updated } = await api.restoreStepHistory(projectId, stepId, historyId);
      onRestored(updated);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <div className="history-panel">
      <div className="history-panel-head">
        <span>Version history</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
      </div>
      {error && <div className="banner banner-error">{error}</div>}
      {history === null && !error && <div className="history-empty">Loading…</div>}
      {history?.length === 0 && <div className="history-empty">No earlier versions saved yet — edits create a version automatically.</div>}
      {history?.length > 0 && (
        <ul className="history-list">
          {history.map((entry) => (
            <li key={entry.id} className="history-item">
              <div className="history-item-meta">
                <span className="history-item-title">{entry.title}</span>
                <span className="history-item-time">{new Date(entry.saved_at).toLocaleString()}</span>
              </div>
              <p className="history-item-preview">{entry.body_markdown.slice(0, 140)}{entry.body_markdown.length > 140 ? '…' : ''}</p>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => restore(entry.id)}
                disabled={restoringId === entry.id}
              >
                {restoringId === entry.id ? 'Restoring…' : 'Restore this version'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function StepCard({ step, index, projectId, frame, onUpdated, onDeleted }) {
  const video = useVideo();

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(step.title);
  const [body, setBody] = useState(step.body_markdown);
  const [showPreview, setShowPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [captureTime, setCaptureTime] = useState(step.start_seconds ?? 0);
  const [showHistory, setShowHistory] = useState(false);

  function startEditing() {
    setTitle(step.title);
    setBody(step.body_markdown);
    setShowPreview(false);
    setEditing(true);
  }

  function cancelEditing() {
    setTitle(step.title);
    setBody(step.body_markdown);
    setEditing(false);
  }

  async function save() {
    setSaving(true);
    try {
      const { step: updated } = await api.updateStep(projectId, step.id, {
        title, body_markdown: body,
      });
      onUpdated(updated);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  // Ctrl/Cmd+S saves, Escape cancels — works from either the title input or the body textarea.
  function handleEditKeyDown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEditing();
    }
  }

  async function captureAt(timestampSeconds) {
    setCapturing(true);
    try {
      const { step: updated } = await api.captureFrame(projectId, step.id, timestampSeconds);
      onUpdated(updated);
    } catch (err) {
      alert(`Couldn't capture frame: ${err.message}`);
    } finally {
      setCapturing(false);
    }
  }

  function recapture() {
    captureAt(parseFloat(captureTime));
  }

  function captureFromVideo() {
    if (!video) return;
    const t = video.getCurrentTime();
    setCaptureTime(t.toFixed(1));
    captureAt(t);
  }

  return (
    <Draggable draggableId={step.id} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          className={`step-card ${snapshot.isDragging ? 'step-card-dragging' : ''}`}
        >
          <div className="step-card-drag" {...provided.dragHandleProps} title="Drag to reorder">⠿</div>

          <div className="step-card-number">{index + 1}</div>

          <div className="step-card-body">
            <div className="step-card-header">
              {editing ? (
                <input
                  className="step-title-input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={handleEditKeyDown}
                />
              ) : (
                <h3 className="step-title">{step.title}</h3>
              )}

              {(step.start_seconds != null) && (
                <span className="step-time">{formatTime(step.start_seconds)}{step.end_seconds != null ? `–${formatTime(step.end_seconds)}` : ''}</span>
              )}
            </div>

            <div className="step-content">
              <div className="step-text">
                {editing ? (
                  <div className="step-edit-area">
                    <div className="step-edit-toolbar">
                      <button
                        type="button"
                        className={`pill-toggle ${!showPreview ? 'pill-toggle-active' : ''}`}
                        onClick={() => setShowPreview(false)}
                      >
                        Write
                      </button>
                      <button
                        type="button"
                        className={`pill-toggle ${showPreview ? 'pill-toggle-active' : ''}`}
                        onClick={() => setShowPreview(true)}
                      >
                        Preview
                      </button>
                      <span className="step-edit-hint">⌘S to save · Esc to cancel</span>
                    </div>
                    <div className={`step-edit-panes ${showPreview ? 'step-edit-panes-split' : ''}`}>
                      <textarea
                        className="step-body-input"
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                        onKeyDown={handleEditKeyDown}
                        rows={6}
                        autoFocus
                      />
                      {showPreview && (
                        <div className="step-preview-pane">
                          <ReactMarkdown>{body || '*Nothing to preview yet.*'}</ReactMarkdown>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="step-body-text">
                    <ReactMarkdown>{step.body_markdown}</ReactMarkdown>
                  </div>
                )}

                <div className="step-actions">
                  {editing ? (
                    <>
                      <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={cancelEditing}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button className="btn btn-secondary btn-sm" onClick={startEditing}>Edit</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setShowHistory((s) => !s)}>History</button>
                      <button className="btn btn-danger btn-sm" onClick={() => onDeleted(step.id)}>Delete</button>
                    </>
                  )}
                </div>

                {showHistory && (
                  <HistoryPanel
                    projectId={projectId}
                    stepId={step.id}
                    onClose={() => setShowHistory(false)}
                    onRestored={onUpdated}
                  />
                )}
              </div>

              <div className="step-screenshot">
                {frame ? (
                  <img src={api.frameImageUrl(frame.id)} alt={`Screenshot for step ${index + 1}`} />
                ) : (
                  <div className="step-screenshot-empty">No screenshot</div>
                )}
                {step.screenshot_rationale && (
                  <div className="step-screenshot-rationale" title={step.screenshot_rationale}>
                    ✦ {step.screenshot_rationale}
                  </div>
                )}

                {video?.isReady && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm capture-from-video-btn"
                    onClick={captureFromVideo}
                    disabled={capturing}
                  >
                    {capturing ? 'Capturing…' : `🎬 Capture at ${formatTime(video.getCurrentTime())}`}
                  </button>
                )}

                <div className="recapture-row">
                  <input
                    type="number"
                    step="0.1"
                    className="recapture-input"
                    value={captureTime}
                    onChange={(e) => setCaptureTime(e.target.value)}
                  />
                  <button className="btn btn-secondary btn-sm" onClick={recapture} disabled={capturing}>
                    {capturing ? 'Capturing…' : 'Recapture at time'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </Draggable>
  );
}
