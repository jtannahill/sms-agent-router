// sms-agent-router: a Twilio number in front of several AI agents.
// Text "grok ..." and Grok gets it; text "claude ..." and Claude gets it.
//
// POST /sms is the Twilio Messaging webhook. Every request is checked, then
// answered with empty TwiML (so Twilio never retries) while the delivery runs
// in the background.

import { parseRoutes, matchRoute } from './routes.js';
import { verifyTwilio, EMPTY_TWIML, twimlMessage } from './twilio.js';
import { deliver } from './deliver.js';
import { safeEqual } from './crypto.js';

const xml = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/xml' } });

// Numbers compare by digits only, so "+1 (212) 555-0100" and "+12125550100" match.
const digits = (n) => String(n || '').replace(/\D/g, '');

function isOwner(from, env) {
  const d = digits(from);
  return d.length > 0 && String(env.OWNER_NUMBERS || '').split(',').some((n) => digits(n) === d);
}

// With PIN set, a text must start with it: "4821 grok what's new". The PIN is
// removed before routing. Returns the rest of the text, or null on a mismatch.
function checkPin(text, pin) {
  if (!pin) return text;
  const [first, ...rest] = text.trim().split(/\s+/);
  return first && safeEqual(first, pin) ? rest.join(' ') : null;
}

export async function handleSms(request, env, ctx, deps = {}) {
  const form = await request.formData();
  const params = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));

  if (env.TWILIO_VERIFY !== 'false') {
    const url = env.PUBLIC_URL ? new URL(new URL(request.url).pathname + new URL(request.url).search, env.PUBLIC_URL).toString() : request.url;
    const ok = await verifyTwilio({ authToken: env.TWILIO_AUTH_TOKEN, url, params, signature: request.headers.get('x-twilio-signature') });
    if (!ok) return new Response('invalid signature', { status: 403 });
  }

  const from = params.From || '';
  if (!isOwner(from, env)) {
    console.log(`[router] ignored text from a number not in OWNER_NUMBERS`);
    return xml(EMPTY_TWIML);
  }

  const afterPin = checkPin(params.Body || '', env.PIN);
  if (afterPin === null) {
    console.log('[router] ignored text without the PIN');
    return xml(EMPTY_TWIML);
  }

  const routes = parseRoutes(env.ROUTES);
  const match = matchRoute(afterPin, routes);
  if (!match) {
    const names = routes.filter((r) => r.prefix).map((r) => r.prefix).join(', ');
    return xml(env.REPLY_ON_NO_MATCH === 'false' ? EMPTY_TWIML : twimlMessage(`Start your text with one of: ${names}`));
  }

  const count = Number(params.NumMedia || 0);
  const msg = {
    from,
    to: params.To || '',
    text: match.text,
    messageSid: params.MessageSid || '',
    mediaUrls: Array.from({ length: count }, (_, i) => params[`MediaUrl${i}`]).filter(Boolean),
    receivedAt: new Date((deps.now || Date.now)()).toISOString(),
  };

  const job = deliver(match.route, msg, env, deps).then((r) => {
    if (r.ok) console.log(`[router] ${r.route}: delivered (${r.status})`);
    else console.error(`[router] ${r.route}: failed ${r.status || ''} ${r.error || ''}`.trim());
    return r;
  });
  if (ctx?.waitUntil) ctx.waitUntil(job);
  else await job;

  return xml(env.ACK ? twimlMessage(env.ACK.replace('{agent}', match.route.name)) : EMPTY_TWIML);
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
        // Still 200 with empty TwiML: a 5xx makes Twilio retry the webhook.
        return xml(EMPTY_TWIML);
      }
    }
    return new Response('not found', { status: 404 });
  },
};
