import React, { useState } from 'react';
import { useVideo } from '../context/VideoContext.jsx';
import './VideoPanel.css';

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '00:00';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export default function VideoPanel({ defaultOpen = false, label = 'Source video' }) {
  const video = useVideo();
  const [open, setOpen] = useState(defaultOpen);

  if (!video) return null;

  return (
    <div className={`video-panel ${open ? 'video-panel-open' : ''}`}>
      <button type="button" className="video-panel-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="video-panel-toggle-label">
          <span className="video-panel-caret">{open ? '▾' : '▸'}</span> {label}
        </span>
        {video.duration > 0 && (
          <span className="video-panel-time">{formatTime(video.currentTime)} / {formatTime(video.duration)}</span>
        )}
      </button>

      {open && (
        <div className="video-panel-body">
          <video
            ref={video.videoRef}
            src={video.src}
            controls
            preload="metadata"
            onLoadedMetadata={(e) => { video.setDuration(e.target.duration); video.setIsReady(true); }}
            onTimeUpdate={(e) => video.setCurrentTime(e.target.currentTime)}
          />
        </div>
      )}
    </div>
  );
}
