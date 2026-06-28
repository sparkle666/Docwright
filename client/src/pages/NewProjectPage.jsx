import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { getSettings } from '../utils/settings.js';
import './NewProjectPage.css';

const DOC_TYPE_DESCRIPTIONS = {
  step_by_step: 'Clear, numbered instructions for walking someone through a task.',
  sop: 'Formal, auditable procedure with precise, unambiguous steps.',
  help_center: 'Friendly, plain-language article aimed at end customers.',
  knowledge_base: 'Neutral, reference-style article optimized for search.',
};

export default function NewProjectPage() {
  const navigate = useNavigate();
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
      setDocTypes(data.types);
      const { defaultDocType } = getSettings();
      const preferred = data.types.find((t) => t.key === defaultDocType);
      setDocType(preferred ? preferred.key : (data.types[0]?.key || 'step_by_step'));
    }).catch(() => {});
  }, []);

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
    if (!title.trim()) { setError('Give your documentation a title.'); return; }

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
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  const progressPct = Math.round(progress * 100);

  return (
    <div className="new-project">
      <h1>New documentation</h1>
      <p className="new-project-sub">Upload a screen recording. We'll transcribe it, write the steps, and pull matching screenshots automatically.</p>

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
          <label className="field-label">Documentation type</label>
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
          {submitting ? 'Uploading…' : 'Generate documentation'}
        </button>
      </form>
    </div>
  );
}
