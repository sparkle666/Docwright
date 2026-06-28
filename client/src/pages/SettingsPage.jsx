import React, { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { getSettings, saveSettings } from '../utils/settings.js';
import './SettingsPage.css';

const EXPORT_FORMATS = [
  { key: 'markdown', label: 'Markdown (.md)' },
  { key: 'html', label: 'HTML (.html)' },
  { key: 'pdf', label: 'PDF (.pdf)' },
  { key: 'docx', label: 'Word (.docx)' },
];

function StatusRow({ label, ok, okLabel = 'OK', badLabel = 'Unavailable' }) {
  return (
    <div className="status-row">
      <span>{label}</span>
      <span className={ok ? 'status-ok' : 'status-bad'}>{ok ? okLabel : badLabel}</span>
    </div>
  );
}

export default function SettingsPage() {
  const [docTypes, setDocTypes] = useState([]);
  const [settings, setSettingsState] = useState(getSettings());
  const [health, setHealth] = useState(null);
  const [healthError, setHealthError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getDocTypes().then((d) => setDocTypes(d.types)).catch(() => {});
    api.getHealth().then(setHealth).catch((err) => setHealthError(err.message));
  }, []);

  function update(partial) {
    const next = saveSettings(partial);
    setSettingsState(next);
    setSaved(true);
    clearTimeout(update._t);
    update._t = setTimeout(() => setSaved(false), 1400);
  }

  return (
    <div className="settings-page">
      <h1>Settings</h1>
      <p className="settings-sub">
        Defaults applied to new documentation, plus a live status check of this Docwright instance.
        Defaults are saved in this browser only.
      </p>

      <section className="settings-section">
        <h2>Defaults for new documentation</h2>
        <div className="field">
          <label className="field-label" htmlFor="default-doctype">Default documentation type</label>
          <select
            id="default-doctype"
            className="text-input"
            value={settings.defaultDocType}
            onChange={(e) => update({ defaultDocType: e.target.value })}
          >
            {docTypes.map((dt) => <option key={dt.key} value={dt.key}>{dt.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="default-export">Preferred export format</label>
          <select
            id="default-export"
            className="text-input"
            value={settings.preferredExportFormat}
            onChange={(e) => update({ preferredExportFormat: e.target.value })}
          >
            {EXPORT_FORMATS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </div>
        {saved && <div className="settings-saved">Saved ✓</div>}
      </section>

      <section className="settings-section">
        <h2>Instance status</h2>
        {healthError && <div className="banner banner-error">{healthError}</div>}
        {!health && !healthError && <div className="loading">Checking…</div>}
        {health && (
          <div className="status-grid">
            <StatusRow label="OpenAI API key" ok={health.hasOpenAIKey} okLabel="Configured" badLabel="Missing" />
            <StatusRow label="ffmpeg" ok={!!health.ffmpeg} okLabel="Available" badLabel="Not found" />
            <StatusRow label="Database" ok={!!health.database} okLabel="Reachable" badLabel="Unreachable" />
            <StatusRow label="Storage" ok={!!health.storage} okLabel="Writable" badLabel="Not writable" />
          </div>
        )}
      </section>

      {health?.models && (
        <section className="settings-section">
          <h2>Model overrides</h2>
          <p className="settings-note">
            Set via environment variables on the server (<code>WHISPER_MODEL</code>, <code>TEXT_MODEL</code>,{' '}
            <code>VISION_MODEL</code> in <code>.env</code>) — shown here for visibility, not editable from the UI.
          </p>
          <div className="status-grid">
            <div className="status-row"><span>Whisper (transcription)</span><span className="model-name">{health.models.whisper}</span></div>
            <div className="status-row"><span>Text (doc writing)</span><span className="model-name">{health.models.text}</span></div>
            <div className="status-row"><span>Vision (screenshot matching)</span><span className="model-name">{health.models.vision}</span></div>
          </div>
        </section>
      )}
    </div>
  );
}
