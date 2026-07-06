import path from 'path';
import fs from 'fs';

const STORAGE_ROOT = path.join(process.cwd(), 'storage');

function safeName(value) {
  return String(value || 'artifact').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

export function getGenerationArtifactDir(projectId, generationId) {
  return path.join(STORAGE_ROOT, 'artifacts', projectId, generationId);
}

export function persistArtifactFile(projectId, generationId, sourcePath, { label = 'artifact' } = {}) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;
  const artifactDir = getGenerationArtifactDir(projectId, generationId);
  fs.mkdirSync(artifactDir, { recursive: true });

  const ext = path.extname(sourcePath) || '';
  const fileName = `${Date.now()}_${safeName(label)}${ext}`;
  const outPath = path.join(artifactDir, fileName);
  fs.copyFileSync(sourcePath, outPath);
  return outPath;
}

