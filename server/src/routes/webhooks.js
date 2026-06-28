import express from 'express';
import { registerWebhook, listWebhooks, deleteWebhook } from '../db/repository.js';

export const webhooksRouter = express.Router();

/**
 * @openapi
 * /api/webhooks:
 *   get:
 *     summary: List registered webhooks
 *     description: Returns all webhook endpoints currently registered on this server.
 *     tags: [Webhooks]
 *     responses:
 *       200:
 *         description: Webhook list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 webhooks:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Webhook' }
 *             example:
 *               webhooks:
 *                 - id: wh_111aaa
 *                   url: https://hooks.example.com/docwright
 *                   secret: null
 *                   created_at: "2024-01-15T10:30:00.000Z"
 */
webhooksRouter.get('/webhooks', (req, res) => {
  res.json({ webhooks: listWebhooks() });
});

/**
 * @openapi
 * /api/webhooks:
 *   post:
 *     summary: Register a webhook
 *     description: |
 *       Registers a URL to receive POST notifications when pipeline events occur.
 *
 *       **Events fired:**
 *       | Event | When |
 *       |---|---|
 *       | `project.complete` | Pipeline finished successfully |
 *       | `project.failed` | Pipeline failed with an error |
 *
 *       **Payload shape:**
 *       ```json
 *       {
 *         "event": "project.complete",
 *         "projectId": "proj_abc123",
 *         "timestamp": "2024-01-15T10:45:00.000Z"
 *       }
 *       ```
 *
 *       **Signature verification (optional):**
 *       If you supply a `secret`, each webhook request will include an
 *       `X-DocWright-Signature` header containing an HMAC-SHA256 hex digest
 *       of the raw JSON body, signed with your secret. Verify it like this:
 *
 *       ```js
 *       const crypto = require('crypto');
 *       const sig = req.headers['x-docwright-signature'];
 *       const expected = crypto.createHmac('sha256', secret)
 *         .update(rawBody).digest('hex');
 *       const ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
 *       ```
 *     tags: [Webhooks]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url]
 *             properties:
 *               url:
 *                 type: string
 *                 description: HTTPS endpoint to POST events to
 *                 example: https://hooks.example.com/docwright
 *               secret:
 *                 type: string
 *                 nullable: true
 *                 description: Optional signing secret for HMAC-SHA256 request verification
 *                 example: my-super-secret-token
 *           example:
 *             url: https://hooks.example.com/docwright
 *             secret: my-super-secret-token
 *     responses:
 *       201:
 *         description: Webhook registered
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 webhook: { $ref: '#/components/schemas/Webhook' }
 *             example:
 *               webhook:
 *                 id: wh_111aaa
 *                 url: https://hooks.example.com/docwright
 *                 secret: my-super-secret-token
 *                 created_at: "2024-01-15T10:30:00.000Z"
 *       400:
 *         description: Invalid or missing URL
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *             example: { error: A valid http/https URL is required }
 */
webhooksRouter.post('/webhooks', (req, res) => {
  const { url, secret } = req.body;
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ error: 'A valid http/https URL is required' });
  }
  const webhook = registerWebhook({ url: url.trim(), secret: secret || null });
  res.status(201).json({ webhook });
});

/**
 * @openapi
 * /api/webhooks/{id}:
 *   delete:
 *     summary: Delete a webhook
 *     description: Removes the webhook. No more events will be sent to its URL.
 *     tags: [Webhooks]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         example: wh_111aaa
 *     responses:
 *       200:
 *         description: Webhook deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean, example: true }
 */
webhooksRouter.delete('/webhooks/:id', (req, res) => {
  deleteWebhook(req.params.id);
  res.json({ ok: true });
});
