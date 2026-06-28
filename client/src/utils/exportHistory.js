const keyFor = (projectId) => `docwright:exports:${projectId}`;

export function getExportHistory(projectId) {
  try {
    const raw = localStorage.getItem(keyFor(projectId));
    return raw ? JSON.parse(raw) : [];
  } catch (_) {
    return [];
  }
}

export function recordExport(projectId, format) {
  const entry = { format, at: new Date().toISOString() };
  const list = [entry, ...getExportHistory(projectId)].slice(0, 8);
  try {
    localStorage.setItem(keyFor(projectId), JSON.stringify(list));
  } catch (_) { /* ignore */ }
  return list;
}
