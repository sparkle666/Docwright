import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

const VideoContext = createContext(null);

export function VideoProvider({ src, children }) {
  const videoRef = useRef(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isReady, setIsReady] = useState(false);

  const seekTo = useCallback((seconds) => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, seconds);
    setCurrentTime(el.currentTime);
  }, []);

  const play = useCallback(() => videoRef.current?.play?.().catch(() => {}), []);

  const getCurrentTime = useCallback(() => videoRef.current?.currentTime ?? 0, []);

  const value = useMemo(() => ({
    src,
    videoRef,
    currentTime,
    duration,
    isReady,
    setCurrentTime,
    setDuration,
    setIsReady,
    seekTo,
    play,
    getCurrentTime,
  }), [src, currentTime, duration, isReady, seekTo, play, getCurrentTime]);

  return <VideoContext.Provider value={value}>{children}</VideoContext.Provider>;
}

// Returns null if no VideoProvider is mounted above — callers should treat
// the video controls as optional/unavailable in that case.
export function useVideo() {
  return useContext(VideoContext);
}
