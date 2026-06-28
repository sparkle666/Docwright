import fs from 'fs';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, AlignmentType,
} from 'docx';
import { formatTimestamp } from '../whisperService.js';

function imageDimensions(filePath, maxWidth = 600) {
  // We don't have a full image-dimension library wired in; docx requires
  // explicit width/height. Use a conservative fixed box and let aspect
  // ratio distortion be a known limitation noted in the README, OR
  // (better) read JPEG dimensions ourselves with a tiny header parse.
  try {
    const buf = fs.readFileSync(filePath);
    // Minimal JPEG SOF marker scan for width/height.
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker)) {
        const height = buf.readUInt16BE(i + 5);
        const width = buf.readUInt16BE(i + 7);
        const scale = Math.min(1, maxWidth / width);
        return { width: Math.round(width * scale), height: Math.round(height * scale) };
      }
      const len = buf.readUInt16BE(i + 2);
      i += 2 + len;
    }
  } catch (err) {
    // fall through to default
  }
  return { width: maxWidth, height: Math.round(maxWidth * 0.5625) };
}

/**
 * Builds a .docx Buffer from project data. framesById maps frame.id -> frame row
 * (with file_path pointing at a local JPEG on disk).
 */
export async function buildDocx({ project, meta, steps, framesById }) {
  const children = [];

  children.push(new Paragraph({ text: project.title, heading: HeadingLevel.TITLE }));

  if (meta?.summary) {
    children.push(new Paragraph({ children: [new TextRun(meta.summary)] }));
  }
  if (meta?.audience) {
    children.push(new Paragraph({ children: [new TextRun({ text: `Audience: `, bold: true }), new TextRun(meta.audience)] }));
  }
  if (meta?.prerequisites) {
    children.push(new Paragraph({ children: [new TextRun({ text: `Prerequisites: `, bold: true }), new TextRun(meta.prerequisites)] }));
  }

  steps.forEach((step, idx) => {
    children.push(new Paragraph({ text: `${idx + 1}. ${step.title}`, heading: HeadingLevel.HEADING_1 }));

    if (step.start_seconds != null) {
      const tsText = `Timestamp: ${formatTimestamp(step.start_seconds)}${step.end_seconds != null ? ' – ' + formatTimestamp(step.end_seconds) : ''}`;
      children.push(new Paragraph({ children: [new TextRun({ text: tsText, italics: true, color: '888888', size: 18 })] }));
    }

    // Strip simple markdown bold markers since docx TextRun handles bold separately;
    // for a first pass we render body as plain paragraphs split on newlines.
    const bodyLines = (step.body_markdown || '').split('\n').filter((l) => l.trim().length > 0);
    bodyLines.forEach((line) => {
      const cleaned = line.replace(/\*\*/g, '').replace(/^[-*]\s*/, '• ');
      children.push(new Paragraph({ children: [new TextRun(cleaned)] }));
    });

    const frame = step.screenshot_frame_id ? framesById[step.screenshot_frame_id] : null;
    if (frame && fs.existsSync(frame.file_path)) {
      const { width, height } = imageDimensions(frame.file_path);
      const imageBuffer = fs.readFileSync(frame.file_path);
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new ImageRun({
            data: imageBuffer,
            transformation: { width, height },
            type: 'jpg',
          }),
        ],
      }));
    }
  });

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });

  return Packer.toBuffer(doc);
}
