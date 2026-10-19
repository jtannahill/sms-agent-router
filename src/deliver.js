// Builds and sends the request for one route.
//
// Payloads:
//   json   {type, from, to, text, message_sid, media_urls, received_at}
//   twilio {From, To, Body, MessageSid, NumMedia, MediaUrl0..}: Twilio's own field names
//   text   {text}: the shape Claude Code routine API triggers read
//
// Auth:
//   bearer             Authorization: Bearer <key>
//   standard-webhooks  webhook-id / webhook-timestamp / webhook-signature,
//                      HMAC-SHA256 over "{id}.{timestamp}.{body}" (standardwebhooks.com)
//   none               no credential (only for endpoints you protect another way)
//
// No retries: most agent endpoints start a new run per delivery and have no
// idempotency key, so a retry would run the agent twice.

import { base64ToBytes, hmacBase64 } from './crypto.js';

export const TIMEOUT_MS = 8000;

export function buildPayload(kind, msg) {
  if (kind === 'twilio') {
    const out = { From: msg.from, To: msg.to, Body: msg.text, MessageSid: msg.messageSid, NumMedia: String(msg.mediaUrls.length) };
    msg.mediaUrls.forEach((u, i) => { out[`MediaUrl${i}`] = u; });
    return out;
  }
  if (kind === 'text') {
    const lines = [`SMS from ${msg.from}`, '', msg.text || '(no text)'];
    msg.mediaUrls.forEach((u) => lines.push(`Attachment: ${u}`));
    return { text: lines.join('\n') };
  }
  return {
    type: 'sms',
    from: msg.from,
    to: msg.to,
    text: msg.text,
    message_sid: msg.messageSid,
    media_urls: msg.mediaUrls,
    received_at: msg.receivedAt,
  };
}

export async function standardWebhookHeaders(secret, body, { now = Date.now(), id } = {}) {
  const key = base64ToBytes(secret.replace(/^whsec_/, ''));
  const msgId = id || `msg_${crypto.randomUUID().replace(/-/g, '')}`;
  const timestamp = String(Math.floor(now / 1000));
  const sig = await hmacBase64('SHA-256', key, `${msgId}.${timestamp}.${body}`);
  return { 'webhook-id': msgId, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${sig}` };
}

export async function deliver(route, msg, env, { fetchImpl = fetch, now = Date.now } = {}) {
  const url = env[route.urlEnv];
  const key = route.keyEnv ? env[route.keyEnv] : null;
  if (!url) return { route: route.name, ok: false, error: `${route.urlEnv} is not set` };
  if (route.auth !== 'none' && !key) return { route: route.name, ok: false, error: `${route.keyEnv} is not set` };

  const body = JSON.stringify(buildPayload(route.payload, msg));
  const headers = { 'content-type': 'application/json' };
  if (route.auth === 'bearer') headers.authorization = `Bearer ${key}`;
  if (route.auth === 'standard-webhooks') Object.assign(headers, await standardWebhookHeaders(key, body, { now: now() }));
  // Claude Code routine fire endpoints require this version header; others ignore it.
  if (/api\.anthropic\.com\/v1\/claude_code\/routines\//.test(url)) headers['anthropic-version'] = '2023-06-01';

  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      return { route: route.name, ok: false, status: res.status, error: detail };
    }
    return { route: route.name, ok: true, status: res.status };
  } catch (err) {
    return { route: route.name, ok: false, error: err.message };
  }
}
