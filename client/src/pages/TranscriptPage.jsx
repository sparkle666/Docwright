import React, { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { VideoProvider, useVideo } from '../context/VideoContext.jsx';
import VideoPanel from '../components/VideoPanel.jsx';
import './TranscriptPage.css';

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '00:00';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function SegmentList({ segments, editedText, onEditText, onJump, activeIndex }) {
  return (
    <ol className="transcript-segments">
      {segments.map((seg, idx) => (
        <li key={seg.id ?? idx}>
          <div className={`transcript-segment ${activeIndex === idx ? 'transcript-segment-active' : ''}`}>
            <button
              type="button"
              className="transcript-segment-time"
              onClick={() => onJump(seg, idx)}
              title="Jump video to this moment"
            >
              {formatTime(seg.start)}
            </button>
            <textarea
              className="transcript-segment-input"
              rows={1}
              value={editedText[seg.id] ?? seg.text}
              onChange={(e) => onEditText(seg.id, e.target.value)}
              onFocus={() => onJump(seg, idx, { seek: false })}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}

function TranscriptEditor({ id, transcript, onTranscriptUpdated }) {
  const video = useVideo();
  const [activeIndex, setActiveIndex] = useState(null);
  const [editedText, setEditedText] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedMessage, setSavedMessage] = useState(null);

  const segments = transcript.raw_json?.segments || [];
  const dirtyIds = Object.keys(editedText).filter((segId) => {
    const original = segments.find((s) => String(s.id) === String(segId));
    return original && editedText[segId] !== original.text;
  });
  const hasEdits = dirtyIds.length > 0;

  function jumpTo(seg, idx, { seek = true } = {}) {
    setActiveIndex(idx);
    if (seek) {
      video?.seekTo(seg.start);
      video?.play();
    }
  }

  function handleEditText(segId, value) {
    setEditedText((prev) => ({ ...prev, [segId]: value }));
    setSavedMessage(null);
  }

  async function handleSaveAndRegenerate() {
    setSaving(true);
    setError(null);
    setSavedMessage(null);
    try {
      const payload = dirtyIds.map((segId) => ({ id: segId, text: editedText[segId] }));
      const { transcript: updated } = await api.updateTranscript(id, payload);
      onTranscriptUpdated(updated);
      await api.regenerateDoc(id);
      setEditedText({});
      setSavedMessage('Saved — regenerating documentation from the corrected transcript…');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="transcript-toolbar">
        <p className="transcript-sub">
          Click a timestamp to jump the video to that moment, or edit a line directly — handy for
          fixing a mis-transcribed product name, UI label, or technical term before it propagates
          into every step.
        </p>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!hasEdits || saving}
          onClick={handleSaveAndRegenerate}
        >
          {saving ? (
            <>
              <span className="btn-spinner" /> Saving…
            </>
          ) : (
            `Save & regenerate doc${hasEdits ? ` (${dirtyIds.length})` : ''}`
          )}
        </button>
      </div>

      {error && <div className="banner banner-error">{error}</div>}
      {savedMessage && (
        <div className="banner banner-success">
          {savedMessage}{' '}
          <Link to={`/projects/${id}`}>View progress →</Link>
        </div>
      )}

      {segments.length === 0 ? (
        <div className="empty-state">No transcript segments available for this project.</div>
      ) : (
        <SegmentList
          segments={segments}
          editedText={editedText}
          onEditText={handleEditText}
          onJump={jumpTo}
          activeIndex={activeIndex}
        />
      )}
    </>
  );
}

export default function TranscriptPage() {
  const { id } = useParams();
  const [project, setProject] = useState(null);
  const [transcript, setTranscript] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    Promise.all([api.getProject(id), api.getTranscript(id)])
      .then(([p, t]) => {
        setProject(p.project);
        setTranscript(t.transcript);
      })
      .catch((err) => setError(err.message));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <div className="transcript-page">
        <Link to={`/projects/${id}`} className="back-link">← Back</Link>
        <div className="banner banner-error">{error}</div>
      </div>
    );
  }
  if (!project || !transcript) {
    return <div className="transcript-page"><div className="loading">Loading…</div></div>;
  }

  return (
    <VideoProvider src={api.videoUrl(id)}>
      <div className="transcript-page">
        <Link to={`/projects/${id}`} className="back-link">← Back to {project.title}</Link>
        <h1>Transcript</h1>

        <VideoPanel defaultOpen />

        <TranscriptEditor
          id={id}
          transcript={transcript}
          onTranscriptUpdated={setTranscript}
        />
      </div>
    </VideoProvider>
  );
}
