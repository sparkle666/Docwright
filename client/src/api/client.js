const BASE = '/api';

async function handle(res) {
  if (!res.ok) {
    let message = `Request failed: ${res.status}`;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch (_) { /* ignore */ }
    throw new Error(message);
  }
  return res.json();
}

function filenameFromDisposition(disposition, fallback) {
  const match = /filename="?([^"]+)"?/.exec(disposition || '');
  return match ? match[1] : fallback;
}

export const api = {
  getDocTypes: () => fetch(`${BASE}/doc-types`).then(handle),

  getHealth: () => fetch(`${BASE}/health`).then(handle),

  listProjects: () => fetch(`${BASE}/projects`).then(handle),

  getProject: (id) => fetch(`${BASE}/projects/${id}`).then(handle),

  // Uses XHR (rather than fetch) so we can report real upload progress —
  // fetch has no cross-browser-safe progress event for request bodies.
  createProject: ({ title, docType, videoFile, onProgress }) => {
    const form = new FormData();
    form.append('title', title);
    form.append('docType', docType);
    form.append('video', videoFile);

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${BASE}/projects`);

      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
      }

      xhr.onload = () => {
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch (_) { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.error || `Upload failed: ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('Network error during upload.'));
      xhr.send(form);
    });
  },

  deleteProject: (id) => fetch(`${BASE}/projects/${id}`, { method: 'DELETE' }).then(handle),

  startProcessing: (id) => fetch(`${BASE}/projects/${id}/process`, { method: 'POST' }).then(handle),

  getStatus: (id) => fetch(`${BASE}/projects/${id}/status`).then(handle),

  getDoc: (id) => fetch(`${BASE}/projects/${id}/doc`).then(handle),

  // Single "everything" bundle: doc, transcript, media availability, voice
  // status, export links, and cost - used by the Assets page.
  getAssets: (id) => fetch(`${BASE}/projects/${id}/assets`).then(handle),

  getTranscript: (id) => fetch(`${BASE}/projects/${id}/transcript`).then(handle),

  updateTranscript: (projectId, segments) => fetch(`${BASE}/projects/${projectId}/transcript`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ segments }),
  }).then(handle),

  regenerateDoc: (projectId, fields = {}) => fetch(`${BASE}/projects/${projectId}/regenerate-doc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  }).then(handle),

  videoUrl: (projectId) => `${BASE}/projects/${projectId}/video`,

  audioUrl: (projectId) => `${BASE}/projects/${projectId}/audio`,

  updateStep: (projectId, stepId, fields) => fetch(`${BASE}/projects/${projectId}/steps/${stepId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  }).then(handle),

  deleteStep: (projectId, stepId) => fetch(`${BASE}/projects/${projectId}/steps/${stepId}`, {
    method: 'DELETE',
  }).then(handle),

  addStep: (projectId, fields) => fetch(`${BASE}/projects/${projectId}/steps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  }).then(handle),

  reorderSteps: (projectId, orderedIds) => fetch(`${BASE}/projects/${projectId}/steps/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedIds }),
  }).then(handle),

  getStepHistory: (projectId, stepId) => fetch(`${BASE}/projects/${projectId}/steps/${stepId}/history`).then(handle),

  restoreStepHistory: (projectId, stepId, historyId) => fetch(`${BASE}/projects/${projectId}/steps/${stepId}/restore/${historyId}`, {
    method: 'POST',
  }).then(handle),

  captureFrame: (projectId, stepId, timestampSeconds) => fetch(`${BASE}/projects/${projectId}/steps/${stepId}/capture-frame`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ timestampSeconds }),
  }).then(handle),

  frameImageUrl: (frameId) => `${BASE}/frames/${frameId}/image`,

  // ─── AI voice-over ──────────────────────────────────────────────────────

  listVoices: () => fetch(`${BASE}/voices`).then(handle),

  startVoiceGeneration: (projectId, fields = {}) => fetch(`${BASE}/projects/${projectId}/voice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  }).then(handle),

  getVoiceStatus: (projectId) => fetch(`${BASE}/projects/${projectId}/voice/status`).then(handle),

  controlVoiceGeneration: (projectId, action) => fetch(`${BASE}/projects/${projectId}/voice/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  }).then(handle),

  restoreOriginalVideo: (projectId) => fetch(`${BASE}/projects/${projectId}/voice/restore`, {
    method: 'POST',
  }).then(handle),

  // ─── Talking-head presenter ─────────────────────────────────────────────

  startTalkingHead: (projectId, fields = {}) => fetch(`${BASE}/projects/${projectId}/talking-head`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  }).then(handle),

  getTalkingHeadStatus: (projectId) => fetch(`${BASE}/projects/${projectId}/talking-head/status`).then(handle),

  controlTalkingHead: (projectId, action) => fetch(`${BASE}/projects/${projectId}/talking-head/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  }).then(handle),

  restoreTalkingHeadVideo: (projectId) => fetch(`${BASE}/projects/${projectId}/talking-head/restore`, {
    method: 'POST',
  }).then(handle),

  exportUrl: (projectId, format) => `${BASE}/projects/${projectId}/export/${format}`,

  // Fetches the export as a blob and triggers a save-as download, so the
  // calling UI can show a real loading state instead of a bare <a> link.
  downloadExport: async (projectId, format, fallbackName) => {
    const res = await fetch(`${BASE}/projects/${projectId}/export/${format}`);
    if (!res.ok) {
      let message = `Export failed: ${res.status}`;
      try {
        const body = await res.json();
        if (body.error) message = body.error;
      } catch (_) { /* ignore */ }
      throw new Error(message);
    }
    const blob = await res.blob();
    const filename = filenameFromDisposition(res.headers.get('Content-Disposition'), fallbackName || `export.${format}`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return filename;
  },
};

