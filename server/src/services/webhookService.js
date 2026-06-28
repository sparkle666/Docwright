import { listWebhooks } from '../db/repository.js';

/**
 * Fire all registered webhooks with a JSON payload.
 * Failures are logged but never thrown — a bad webhook must not abort the pipeline.
 *
 * @param {object} payload  – { event, projectId, [error] }
 */
export async function fireWebhooks(payload) {
  // Also support a single URL set via environment variable (no DB registration needed)
  const envUrl = process.env.WEBHOOK_URL;
  const rows = listWebhooks();
  const targets = [...rows];
  if (envUrl) targets.push({ url: envUrl, secret: null });

  if (targets.length === 0) return;

  const body = JSON.stringify({ ...payload, timestamp: new Date().toISOString() });

  await Promise.allSettled(
    targets.map(async ({ url, secret }) => {
      const headers = { 'Content-Type': 'application/json' };
      if (secret) headers['X-DocWright-Secret'] = secret;

      try {
        const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) {
          console.warn(`Webhook ${url} responded with ${res.status}`);
        }
      } catch (err) {
        console.warn(`Webhook ${url} failed: ${err.message}`);
      }
    }),
  );
}
