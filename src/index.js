// sms-agent-router: a Twilio number in front of several AI agents.
// Text "grok ..." and Grok gets it; text "claude ..." and Claude gets it.
//
// POST /sms is the Twilio Messaging webhook. A request that is not a small,
// correctly signed Twilio form post gets a 403 (or 413 if too large); every
// other request gets 200 TwiML right away, while the delivery runs in the
// background.

import { parseRoutes, matchRoute, ConfigError } from './routes.js';
import { verifyTwilio, EMPTY_TWIML, twimlMessage } from './twilio.js';
import { deliver } from './deliver.js';
import { safeEqual } from './crypto.js';

const xml = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/xml' } });
const deny = (msg, status = 403) => new Response(msg, { status });
const SEEN_TTL_SECONDS = 86400;
// A Twilio SMS/MMS webhook is a few KB even with 10 media URLs.
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MEDIA = 10;
const MESSAGE_SID = /^(SM|MM)[0-9a-fA-F]{32}$/;

// Numbers compare by digits only, so "+1 (212) 555-0100" matches "+12125550100".
// Include the country code: "2125550100" does not match "+12125550100".
const digits = (n) => String(n || '').replace(/\D/g, '');

function isOwner(from, env) {
  const d = digits(from);
  return d.length > 0 && String(env.OWNER_NUMBERS || '').split(',').some((n) => digits(n) === d);
}

// With PIN set, a text must start with it: "482193 grok what's new". The PIN
// is removed before routing; line breaks in the rest are kept. Returns the
// rest of the text, or null on a mismatch.
function checkPin(text, pin) {
  if (!pin) return text;
  const m = text.trimStart().match(/^(\S+)\s*([\s\S]*)$/);
  return m && safeEqual(m[1], pin) ? m[2] : null;
}

// Optional replay guard. Twilio signatures carry no timestamp, so a captured
// request could be resent. With a KV namespace bound as SEEN, a request is
// accepted once per day, keyed by both its MessageSid and its signature: the
// signature is the same for every way of re-splitting the signed form fields,
// so re-splitting cannot dodge the guard. Best effort: KV is eventually
// consistent, so a replay within about a minute, or from another region, can
// still get through. If KV fails, the text is dropped (fail closed).
async function firstDelivery(env, keys) {
  if (!env.SEEN) return true;
  const ids = keys.filter(Boolean);
  for (const k of ids) if (await env.SEEN.get(k)) return false;
  for (const k of ids) await env.SEEN.put(k, '1', { expirationTtl: SEEN_TTL_SECONDS });
  return true;
}

// Reads the body with a running cap, so a large chunked body is never
// buffered in full. Returns null when it is over MAX_BODY_BYTES.
async function readForm(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) return null;
  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  // One value per name: Twilio's Messaging webhooks never repeat a field.
  return Object.fromEntries(new URLSearchParams(new TextDecoder().decode(bytes)));
}

export async function handleSms(request, env, ctx, deps = {}) {
  // Twilio always posts a small form. Anything else is not Twilio.
  if (!(request.headers.get('content-type') || '').startsWith('application/x-www-form-urlencoded')) {
    return deny('expected a Twilio form post');
  }
  const params = await readForm(request);
  if (!params) return deny('too large', 413);

  let signature = null;
  if (env.TWILIO_VERIFY !== 'false') {
    const self = new URL(request.url);
    const url = env.PUBLIC_URL ? new URL(self.pathname + self.search, env.PUBLIC_URL).toString() : request.url;
    signature = request.headers.get('x-twilio-signature');
    const ok = await verifyTwilio({ authToken: env.TWILIO_AUTH_TOKEN, url, params, signature });
    if (!ok) return deny('invalid signature');
  }
  // Every real Twilio message carries a well-formed MessageSid. A signed request
  // without one has had its fields re-split, so it is not what Twilio sent.
  if (!MESSAGE_SID.test(params.MessageSid || '')) return deny('invalid MessageSid');

  if (!isOwner(params.From, env)) {
    console.log('[router] ignored text from a number not in OWNER_NUMBERS');
    return xml(EMPTY_TWIML);
  }

  if (env.PIN && /\s/.test(env.PIN)) {
    console.error('[router] config error: PIN must be one word with no spaces');
    return xml(EMPTY_TWIML);
  }
  const afterPin = checkPin(params.Body || '', env.PIN);
  if (afterPin === null) {
    console.log('[router] ignored text without the PIN');
    return xml(EMPTY_TWIML);
  }

  const count = Math.max(0, Math.min(MAX_MEDIA, Math.floor(Number(params.NumMedia) || 0)));
  if (!afterPin.trim() && !count) return xml(EMPTY_TWIML);

  let fresh;
  try {
    fresh = await firstDelivery(env, [`sid:${params.MessageSid}`, signature && `sig:${signature}`]);
  } catch (err) {
    console.error(`[router] replay guard unavailable (${err.name}), text dropped`);
    return xml(EMPTY_TWIML);
  }
  if (!fresh) {
    console.log('[router] ignored a repeat of an earlier request');
    return xml(EMPTY_TWIML);
  }

  const routes = parseRoutes(env.ROUTES);
  const match = matchRoute(afterPin, routes);
  if (!match) {
    if (env.REPLY_ON_NO_MATCH === 'false') return xml(EMPTY_TWIML);
    const names = routes.filter((r) => r.prefix).map((r) => r.prefix).join(', ');
    return xml(twimlMessage(`Start your text with one of: ${names}`));
  }
  if (!match.text && !count) return xml(EMPTY_TWIML);

  const msg = {
    from: params.From,
    to: params.To || '',
    text: match.text,
    messageSid: params.MessageSid,
    mediaUrls: Array.from({ length: count }, (_, i) => params[`MediaUrl${i}`]).filter(Boolean),
    receivedAt: new Date((deps.now || Date.now)()).toISOString(),
  };

  const job = deliver(match.route, msg, env, deps).then((r) => {
    if (r.ok) console.log(`[router] ${r.route}: delivered (${r.status})`);
    else console.error(`[router] ${r.route}: failed${r.status ? ` (${r.status})` : ''}: ${r.error}`);
    return r;
  });
  if (ctx?.waitUntil) ctx.waitUntil(job);
  else await job;

  // ACK goes out as soon as the text is routed, before the agent answers.
  return xml(env.ACK ? twimlMessage(env.ACK.replaceAll('{agent}', () => match.route.name)) : EMPTY_TWIML);
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/health') return new Response('ok');
    if ((pathname === '/sms' || pathname === '/sms/') && request.method === 'POST') {
      try {
        return await handleSms(request, env, ctx);
      } catch (err) {
        console.error(`[router] error: ${err instanceof ConfigError ? err.message : err.name}`);
        // Answer 200 anyway: an error status only adds Twilio debugger noise,
        // and nothing about this request will succeed on a second try.
        return xml(EMPTY_TWIML);
      }
    }
    return new Response('not found', { status: 404 });
  },
};
