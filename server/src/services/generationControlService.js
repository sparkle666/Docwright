import fs from 'fs';
import path from 'path';
import { getProject, updateProject } from '../db/repository.js';

const STORAGE_ROOT = path.join(process.cwd(), 'storage');

const PROCESS_FIELD_MAP = {
  voice: {
    status: 'voice_status',
    error: 'voice_error',
    control: 'voice_control_action',
    progress: 'voice_progress_json',
    workDir: (projectId) => path.join(STORAGE_ROOT, 'voice_tmp', projectId),
  },
  talking_head: {
    status: 'talking_head_status',
    error: 'talking_head_error',
    control: 'talking_head_control_action',
    progress: 'talking_head_progress_json',
    workDir: (projectId) => path.join(STORAGE_ROOT, 'talking_head_tmp', projectId),
  },
};

export function getProcessFields(kind) {
  const fields = PROCESS_FIELD_MAP[kind];
  if (!fields) throw new Error(`Unknown process kind: ${kind}`);
  return fields;
}

export function parseProgress(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setProcessProgress(projectId, kind, progress, extraFields = {}) {
  const fields = getProcessFields(kind);
  const next = {
    ...progress,
    updatedAt: new Date().toISOString(),
  };
  return updateProject(projectId, {
    [fields.progress]: JSON.stringify(next),
    ...extraFields,
  });
}

export function clearProcessProgress(projectId, kind, extraFields = {}) {
  const fields = getProcessFields(kind);
  return updateProject(projectId, {
    [fields.progress]: null,
    ...extraFields,
  });
}

export function requestProcessControl(projectId, kind, action) {
  const fields = getProcessFields(kind);
  return updateProject(projectId, { [fields.control]: action });
}

export function clearProcessControl(projectId, kind) {
  const fields = getProcessFields(kind);
  return updateProject(projectId, { [fields.control]: null });
}

export function getProcessSnapshot(projectId, kind) {
  const project = getProject(projectId);
  if (!project) return null;
  const fields = getProcessFields(kind);
  return {
    project,
    status: project[fields.status] || null,
    error: project[fields.error] || null,
    control: project[fields.control] || null,
    progress: parseProgress(project[fields.progress]),
    workDir: fields.workDir(projectId),
    hasWorkDir: fs.existsSync(fields.workDir(projectId)),
  };
}

export function finalizeInterruptedProcess(projectId, kind, action, progress, extraFields = {}) {
  const fields = getProcessFields(kind);
  const status = action === 'pause' ? 'paused' : 'stopped';
  return updateProject(projectId, {
    [fields.status]: status,
    [fields.control]: null,
    [fields.error]: null,
    [fields.progress]: JSON.stringify({
      ...(progress || {}),
      interruptedAt: new Date().toISOString(),
      interruptedBy: action,
    }),
    ...extraFields,
  });
}

