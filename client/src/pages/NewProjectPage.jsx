import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { getSettings } from '../utils/settings.js';
import './NewProjectPage.css';

const DOC_TYPE_DESCRIPTIONS = {
  step_by_step: 'Clear, numbered instructions for walking someone through a task.',
  sop: 'Formal, auditable procedure with precise, unambiguous steps.',
  help_center: 'Friendly, plain-language article aimed at end customers.',
  knowledge_base: 'Neutral, reference-style article optimized for search.',
  walkthrough_voiceover_polished: 'Smooth, professional narrator — clean and neutral.',
  walkthrough_voiceover_demo: 'Confident, upbeat narration for product demos.',
  walkthrough_voiceover_technical: 'Precise, authoritative narration for tutorials and training.',
};

export default function NewProjectPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // "video" mode skips the documentation-review step entirely: the user
  // lands directly on the AI voice-over page once processing finishes,
  // instead of the step-by-step doc editor.
  const isVideoMode = searchParams.get('mode') === 'video';

  const [docTypes, setDocTypes] = useState([]);
  const [title, setTitle] = useState('');
  const [docType, setDocType] = useState('step_by_step');
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    api.getDocTypes().then((data) => {
      // In video mode, only offer the walkthrough-voiceover presets —
      // the written-doc presets (step-by-step, SOP, etc.) don't apply here.
      const relevant = data.types.filter((t) => Boolean(t.flowing) === isVideoMode);
      setDocTypes(relevant);
      const { defaultDocType } = getSettings();
      const preferred = relevant.find((t) => t.key === defaultDocType);
      setDocType(preferred ? preferred.key : (relevant[0]?.key || (isVideoMode ? 'walkthrough_voiceover_polished' : 'step_by_step')));
    }).catch(() => {});
  }, [isVideoMode]);

  function handleFileChange(f) {
    if (!f) return;
    setFile(f);
    if (!title) {
      const base = f.name.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ');
      setTitle(base.charAt(0).toUpperCase() + base.slice(1));
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!file) { setError('Choose a video file to continue.'); return; }
    if (!title.trim()) { setError('Give your project a title.'); return; }

    setSubmitting(true);
    setProgress(0);
    setError(null);
    try {
      const { project } = await api.createProject({
        title: title.trim(),
        docType,
        videoFile: file,
        onProgress: (fraction) => setProgress(fraction),
      });
      await api.startProcessing(project.id);
      // Video mode skips straight to the voice-over page (with autostart)
      // instead of the doc-review page — the transcript/step breakdown
      // still happens in the background, the user just never sees it.
      navigate(isVideoMode ? `/projects/${project.id}/voice?auto=1` : `/projects/${project.id}`);
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  const progressPct = Math.round(progress * 100);

  return (
    <div className="new-project">
      <h1>{isVideoMode ? 'New AI video' : 'New documentation'}</h1>
      <p className="new-project-sub">
        {isVideoMode
          ? "Upload a screen recording and we'll replace its audio with a professional AI voice-over — no manual doc review needed."
          : "Upload a screen recording. We'll transcribe it, write the steps, and pull matching screenshots automatically."}
      </p>

      <form onSubmit={handleSubmit} className="new-project-form">
        <label
          className={`dropzone ${dragOver ? 'dropzone-active' : ''} ${file ? 'dropzone-filled' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            handleFileChange(e.dataTransfer.files[0]);
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            onChange={(e) => handleFileChange(e.target.files[0])}
            hidden
          />
          {file ? (
            <div className="dropzone-file">
              <span className="dropzone-file-icon">▶</span>
              <div>
                <div className="dropzone-file-name">{file.name}</div>
                <div className="dropzone-file-size">{(file.size / (1024 * 1024)).toFixed(1)} MB</div>
              </div>
            </div>
          ) : (
            <>
              <div className="dropzone-title">Drop a screen recording here</div>
              <div className="dropzone-sub">or click to browse — MP4, MOV, WebM</div>
            </>
          )}
        </label>

        <div className="field">
          <label className="field-label" htmlFor="title">Title</label>
          <input
            id="title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. How to invite a teammate"
            className="text-input"
          />
        </div>

        <div className="field">
          <label className="field-label">{isVideoMode ? 'Narration style' : 'Documentation type'}</label>
          <div className="doctype-grid">
            {docTypes.map((dt) => (
              <button
                type="button"
                key={dt.key}
                className={`doctype-option ${docType === dt.key ? 'doctype-option-selected' : ''}`}
                onClick={() => setDocType(dt.key)}
              >
                <span className="doctype-option-label">{dt.label}</span>
                <span className="doctype-option-desc">{DOC_TYPE_DESCRIPTIONS[dt.key]}</span>
              </button>
            ))}
          </div>
        </div>

        {error && <div className="banner banner-error">{error}</div>}

        {submitting && (
          <div className="upload-progress">
            <div className="upload-progress-bar">
              <div className="upload-progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <div className="upload-progress-label">
              {progress < 1 ? `Uploading… ${progressPct}%` : 'Upload complete — starting pipeline…'}
            </div>
          </div>
        )}

        <button type="submit" className="btn btn-primary btn-submit" disabled={submitting}>
          {submitting ? 'Uploading…' : isVideoMode ? 'Generate AI video' : 'Generate documentation'}
        </button>
      </form>
    </div>
  );
}