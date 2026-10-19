// sms-agent-router: a Twilio number in front of several AI agents.
// Text "grok ..." and Grok gets it; text "claude ..." and Claude gets it.
//
// POST /sms is the Twilio Messaging webhook. A request with a bad signature
// gets a 403; every other request gets 200 TwiML right away, while the
// delivery runs in the background.

import { parseRoutes, matchRoute } from './routes.js';
import { verifyTwilio, EMPTY_TWIML, twimlMessage } from './twilio.js';
import { deliver } from './deliver.js';
import { safeEqual } from './crypto.js';

const xml = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/xml' } });
const SEEN_TTL_SECONDS = 86400;

// Numbers compare by digits only, so "+1 (212) 555-0100" matches "+12125550100".
// Include the country code: "2125550100" does not match "+12125550100".
const digits = (n) => String(n || '').replace(/\D/g, '');

function isOwner(from, env) {
  const d = digits(from);
  return d.length > 0 && String(env.OWNER_NUMBERS || '').split(',').some((n) => digits(n) === d);
}

// With PIN set, a text must start with it: "4821 grok what's new". The PIN is
// removed before routing; line breaks in the rest are kept. Returns the rest
// of the text, or null on a mismatch.
function checkPin(text, pin) {
  if (!pin) return text;
  const m = text.trimStart().match(/^(\S+)\s*([\s\S]*)$/);
  return m && safeEqual(m[1], pin) ? m[2] : null;
}

// Optional replay guard. Twilio signatures carry no timestamp, so a captured
// request could be resent. With a KV namespace bound as SEEN, each MessageSid
// is accepted once per day. Best effort: KV is eventually consistent, so a
// replay within about a minute, or from another region, can still get through.
async function firstDelivery(env, sid) {
  if (!env.SEEN || !sid) return true;
  const key = `sid:${sid}`;
  if (await env.SEEN.get(key)) return false;
  await env.SEEN.put(key, '1', { expirationTtl: SEEN_TTL_SECONDS });
  return true;
}

export async function handleSms(request, env, ctx, deps = {}) {
  // Twilio always posts a form. Anything else is not Twilio.
  if (!(request.headers.get('content-type') || '').startsWith('application/x-www-form-urlencoded')) {
    return new Response('expected a Twilio form post', { status: 403 });
  }
  const form = await request.formData();
  const params = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));

  if (env.TWILIO_VERIFY !== 'false') {
    const self = new URL(request.url);
    const url = env.PUBLIC_URL ? new URL(self.pathname + self.search, env.PUBLIC_URL).toString() : request.url;
    const ok = await verifyTwilio({ authToken: env.TWILIO_AUTH_TOKEN, url, params, signature: request.headers.get('x-twilio-signature') });
    if (!ok) return new Response('invalid signature', { status: 403 });
  }

  if (!isOwner(params.From, env)) {
    console.log('[router] ignored text from a number not in OWNER_NUMBERS');
    return xml(EMPTY_TWIML);
  }

  const afterPin = checkPin(params.Body || '', env.PIN);
  if (afterPin === null) {
    console.log('[router] ignored text without the PIN');
    return xml(EMPTY_TWIML);
  }
  if (!afterPin.trim() && !Number(params.NumMedia || 0)) return xml(EMPTY_TWIML);

  if (!(await firstDelivery(env, params.MessageSid))) {
    console.log('[router] ignored a repeat of an earlier MessageSid');
    return xml(EMPTY_TWIML);
  }

  const routes = parseRoutes(env.ROUTES);
  const match = matchRoute(afterPin, routes);
  if (!match) {
    if (env.REPLY_ON_NO_MATCH === 'false') return xml(EMPTY_TWIML);
    const names = routes.filter((r) => r.prefix).map((r) => r.prefix).join(', ');
    return xml(twimlMessage(`Start your text with one of: ${names}`));
  }

  const count = Number(params.NumMedia || 0);
  if (!match.text && !count) return xml(EMPTY_TWIML);
  const msg = {
    from: params.From,
    to: params.To || '',
    text: match.text,
    messageSid: params.MessageSid || '',
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

  return xml(env.ACK ? twimlMessage(env.ACK.replaceAll('{agent}', () => match.route.name)) : EMPTY_TWIML);
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/health') return new Response('ok');
    if (pathname === '/sms' && request.method === 'POST') {
      try {
        return await handleSms(request, env, ctx);
      } catch (err) {
        console.error('[router] error:', err.message);
        // Answer 200 anyway: an error status only adds Twilio debugger noise,
        // and nothing about this request will succeed on a second try.
        return xml(EMPTY_TWIML);
      }
    }
    return new Response('not found', { status: 404 });
  },
};
