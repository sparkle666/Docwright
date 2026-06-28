import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { nanoid } from 'nanoid';

const UPLOAD_DIR = path.join(process.cwd(), 'storage', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, `${nanoid()}${ext}`);
  },
});

const maxUploadBytes = (parseInt(process.env.MAX_UPLOAD_MB || '1024', 10)) * 1024 * 1024;

const ALLOWED_MIME_PREFIXES = ['video/'];

export const upload = multer({
  storage,
  limits: { fileSize: maxUploadBytes },
  fileFilter: (req, file, cb) => {
    const ok = ALLOWED_MIME_PREFIXES.some((p) => file.mimetype.startsWith(p));
    if (!ok) return cb(new Error('Only video files are accepted.'));
    cb(null, true);
  },
});
