import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import StatusPill from '../components/StatusPill.jsx';
import './DashboardPage.css';

const DOC_TYPE_LABELS = {
  step_by_step: 'Step-by-Step Guide',
  sop: 'SOP',
  help_center: 'Help Center Article',
  knowledge_base: 'Knowledge Base Article',
};

const IN_PROGRESS = new Set([
  'extracting_audio', 'transcribing', 'writing_doc', 'extracting_frames', 'matching_screenshots',
]);

const STATUS_FILTERS = [
  { key: 'all', label: 'All statuses' },
  { key: 'uploaded', label: 'Ready to process' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'complete', label: 'Complete' },
  { key: 'failed', label: 'Failed' },
];

export default function DashboardPage() {
  const [projects, setProjects] = useState(null);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  useEffect(() => {
    let cancelled = false;
    api.listProjects()
      .then((data) => { if (!cancelled) setProjects(data.projects); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, []);

  const filtered = useMemo(() => {
    if (!projects) return null;
    return projects.filter((p) => {
      const matchesSearch = !search.trim() || p.title.toLowerCase().includes(search.trim().toLowerCase());
      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'in_progress' ? IN_PROGRESS.has(p.status) : p.status === statusFilter);
      return matchesSearch && matchesStatus;
    });
  }, [projects, search, statusFilter]);

  const hasAnyProjects = projects && projects.length > 0;

  return (
    <div className="dashboard">
      <div className="dashboard-intro">
        <h1>Your documentation</h1>
        <p>Turn a screen recording into a polished, step-by-step guide — transcript, matched screenshots, and all.</p>
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      {projects === null && !error && (
        <div className="empty-state">Loading…</div>
      )}

      {projects?.length === 0 && (
        <div className="empty-state">
          <p className="empty-state-title">No documentation yet</p>
          <p className="empty-state-body">Upload a screen recording to generate your first guide.</p>
          <Link to="/new" className="btn btn-primary">+ New documentation</Link>
        </div>
      )}

      {hasAnyProjects && (
        <div className="dashboard-controls">
          <input
            type="text"
            className="text-input search-input"
            placeholder="Search documentation by title…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="text-input status-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            {STATUS_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </div>
      )}

      {hasAnyProjects && filtered.length === 0 && (
        <div className="empty-state">
          <p className="empty-state-title">No matches</p>
          <p className="empty-state-body">Try a different search term or status filter.</p>
        </div>
      )}

      {filtered && filtered.length > 0 && (
        <div className="project-grid">
          {filtered.map((p) => (
            <Link to={`/projects/${p.id}`} key={p.id} className="project-card">
              <div className="project-card-top">
                <span className="project-doctype">{DOC_TYPE_LABELS[p.doc_type] || p.doc_type}</span>
                <StatusPill status={p.status} />
              </div>
              <h3 className="project-title">{p.title}</h3>
              <div className="project-meta">
                {p.duration_seconds ? `${Math.round(p.duration_seconds)}s video` : 'Processing…'}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
