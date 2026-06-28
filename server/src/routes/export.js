import express from 'express';
import fs from 'fs';
import { getProject, getDocMeta, listSteps, listFrames } from '../db/repository.js';
import { buildMarkdown } from '../services/exporters/markdownExporter.js';
import { buildHtml } from '../services/exporters/htmlExporter.js';
import { htmlToPdfBuffer } from '../services/exporters/pdfExporter.js';
import { buildDocx } from '../services/exporters/docxExporter.js';

export const exportRouter = express.Router();

const SERVER_BASE = process.env.SERVER_BASE_URL || 'http://localhost:' + (process.env.PORT || 4000);

function loadDocBundle(projectId) {
  const project = getProject(projectId);
  if (!project) return null;
  const meta = getDocMeta(projectId);
  const steps = listSteps(projectId);
  const frames = listFrames(projectId);
  const framesById = Object.fromEntries(frames.map((f) => [f.id, f]));
  return { project, meta, steps, framesById };
}

function frameToUrl(frame) {
  if (!frame) return '';
  return `${SERVER_BASE}/api/frames/${frame.id}/image`;
}

function frameToDataUrl(frame) {
  if (!frame || !fs.existsSync(frame.file_path)) return '';
  const buf = fs.readFileSync(frame.file_path);
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

/**
 * @openapi
 * /api/projects/{id}/export/markdown:
 *   get:
 *     summary: Export as Markdown
 *     description: |
 *       Downloads a `.md` file containing the full documentation.
 *
 *       Screenshots are referenced as absolute URLs pointing to
 *       `GET /api/frames/:frameId/image` so any Markdown viewer
 *       that can reach the server will render them inline.
 *
 *       Set `SERVER_BASE_URL` in `.env` to change the base URL embedded
 *       in image links (useful when the server is not on localhost).
 *     tags: [Exports]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: proj_abc123
 *     responses:
 *       200:
 *         description: Markdown file download
 *         content:
 *           text/markdown:
 *             schema:
 *               type: string
 *         headers:
 *           Content-Disposition:
 *             schema:
 *               type: string
 *               example: attachment; filename="How_to_invite_a_teammate.md"
 *       404:
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
exportRouter.get('/projects/:id/export/markdown', (req, res) => {
  const bundle = loadDocBundle(req.params.id);
  if (!bundle) return res.status(404).json({ error: 'Project not found' });

  const markdown = buildMarkdown({
    ...bundle,
    screenshotUrlResolver: (frame) => frameToUrl(frame),
  });

  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="${bundle.project.title.replace(/[^a-z0-9]+/gi, '_')}.md"`);
  res.send(markdown);
});

/**
 * @openapi
 * /api/projects/{id}/export/html:
 *   get:
 *     summary: Export as HTML
 *     description: |
 *       Downloads a self-contained `.html` file with embedded CSS.
 *       Screenshots are embedded as base64 data URIs so the file is
 *       fully portable — no internet connection required to view images.
 *     tags: [Exports]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: proj_abc123
 *     responses:
 *       200:
 *         description: HTML file download
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *         headers:
 *           Content-Disposition:
 *             schema:
 *               type: string
 *               example: attachment; filename="How_to_invite_a_teammate.html"
 *       404:
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
exportRouter.get('/projects/:id/export/html', (req, res) => {
  const bundle = loadDocBundle(req.params.id);
  if (!bundle) return res.status(404).json({ error: 'Project not found' });

  const html = buildHtml({
    ...bundle,
    screenshotUrlResolver: (frame) => frameToDataUrl(frame),
  });

  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', `attachment; filename="${bundle.project.title.replace(/[^a-z0-9]+/gi, '_')}.html"`);
  res.send(html);
});

/**
 * @openapi
 * /api/projects/{id}/export/pdf:
 *   get:
 *     summary: Export as PDF
 *     description: |
 *       Renders the documentation to a print-ready A4 PDF using Puppeteer (headless Chromium).
 *
 *       Screenshots are loaded via their server URL during render — Puppeteer
 *       fetches each image from `GET /api/frames/:frameId/image` so they appear
 *       correctly in the PDF. Ensure the server is accessible from within the
 *       Puppeteer process (which is always true for local deployments).
 *
 *       This endpoint can take several seconds for long documents.
 *     tags: [Exports]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: proj_abc123
 *     responses:
 *       200:
 *         description: PDF file download
 *         content:
 *           application/pdf:
 *             schema:
 *               type: string
 *               format: binary
 *         headers:
 *           Content-Disposition:
 *             schema:
 *               type: string
 *               example: attachment; filename="How_to_invite_a_teammate.pdf"
 *       404:
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       500:
 *         description: PDF rendering failed (Puppeteer error)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
exportRouter.get('/projects/:id/export/pdf', async (req, res) => {
  try {
    const bundle = loadDocBundle(req.params.id);
    if (!bundle) return res.status(404).json({ error: 'Project not found' });

    const html = buildHtml({
      ...bundle,
      screenshotUrlResolver: (frame) => frameToUrl(frame),
    });

    const pdfBuffer = await htmlToPdfBuffer(html);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${bundle.project.title.replace(/[^a-z0-9]+/gi, '_')}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * @openapi
 * /api/projects/{id}/export/docx:
 *   get:
 *     summary: Export as Word document (.docx)
 *     description: |
 *       Generates a `.docx` file compatible with Microsoft Word, Google Docs,
 *       and LibreOffice. Screenshots are embedded as binary image data directly
 *       inside the document — no external references needed.
 *     tags: [Exports]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: proj_abc123
 *     responses:
 *       200:
 *         description: Word document download
 *         content:
 *           application/vnd.openxmlformats-officedocument.wordprocessingml.document:
 *             schema:
 *               type: string
 *               format: binary
 *         headers:
 *           Content-Disposition:
 *             schema:
 *               type: string
 *               example: attachment; filename="How_to_invite_a_teammate.docx"
 *       404:
 *         description: Project not found
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       500:
 *         description: docx generation failed
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
exportRouter.get('/projects/:id/export/docx', async (req, res) => {
  try {
    const bundle = loadDocBundle(req.params.id);
    if (!bundle) return res.status(404).json({ error: 'Project not found' });

    const buffer = await buildDocx(bundle);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${bundle.project.title.replace(/[^a-z0-9]+/gi, '_')}.docx"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
