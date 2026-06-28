import React from 'react';
import './StatusPill.css';

const STATUS_CONFIG = {
  created: { label: 'Created', tone: 'neutral' },
  uploaded: { label: 'Ready to process', tone: 'neutral' },
  extracting_audio: { label: 'Extracting audio', tone: 'progress' },
  transcribing: { label: 'Transcribing', tone: 'progress' },
  writing_doc: { label: 'Writing documentation', tone: 'progress' },
  extracting_frames: { label: 'Extracting frames', tone: 'progress' },
  filtering_frames: { label: 'Filtering blurry frames', tone: 'progress' },
  matching_screenshots: { label: 'Matching screenshots', tone: 'progress' },
  complete: { label: 'Complete', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
};

export default function StatusPill({ status }) {
  const config = STATUS_CONFIG[status] || { label: status, tone: 'neutral' };
  return (
    <span className={`status-pill status-${config.tone}`}>
      {config.tone === 'progress' && <span className="status-dot-pulse" />}
      {config.label}
    </span>
  );
}
