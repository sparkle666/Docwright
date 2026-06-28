const STORAGE_KEY = 'docwright:settings';

const DEFAULTS = {
  defaultDocType: 'step_by_step',
  preferredExportFormat: 'markdown',
};

export function getSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

export function saveSettings(partial) {
  const next = { ...getSettings(), ...partial };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (_) { /* ignore (e.g. storage disabled) */ }
  return next;
}
