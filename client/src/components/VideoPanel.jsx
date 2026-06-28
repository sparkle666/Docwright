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

  const hasVideo = Boolean(video.src);
  const isMetadataReady = video.isReady && Number.isFinite(video.duration) && video.duration > 0;

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
          <div className="video-panel-stage">
            {hasVideo ? (
              <video
                ref={video.videoRef}
                src={video.src}
                controls
                preload="metadata"
                onLoadedMetadata={(e) => { video.setDuration(e.target.duration); video.setIsReady(true); }}
                onTimeUpdate={(e) => video.setCurrentTime(e.target.currentTime)}
              />
            ) : (
              <div className="video-panel-empty">
                <div className="video-panel-empty-title">No video is available for this project.</div>
                <div className="video-panel-empty-subtitle">Upload a recording to preview it here, or reopen the page once the source is available.</div>
              </div>
            )}
          </div>

          {hasVideo && (
            <div className="video-panel-actions">
              <a
                className="btn btn-secondary btn-sm video-panel-action"
                href={video.src}
                target="_blank"
                rel="noreferrer"
              >
                Open video in new tab
              </a>
              <a
                className="btn btn-secondary btn-sm btn-sm"
                href={video.src}
                download
              >
                Download video
              </a>
              {!isMetadataReady && (
                <span className="video-panel-note">If the embedded player stays blank, open or download the source file directly.</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
