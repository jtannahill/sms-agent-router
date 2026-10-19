import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker, { handleSms } from '../src/index.js';
import { twilioSignature } from '../src/twilio.js';

const OWNER = '+12125550100';
const URL_ = 'https://router.example.workers.dev/sms';
let sidCounter = 0;
const sid = () => `SM${(++sidCounter).toString(16).padStart(32, '0')}`;
const ENV = {
  TWILIO_AUTH_TOKEN: 'tw_token',
  OWNER_NUMBERS: `${OWNER}, +13125550111`,
  ROUTES: JSON.stringify([
    { name: 'grok', prefix: 'grok', url_env: 'GROK_URL', key_env: 'GROK_KEY', payload: 'twilio' },
    { name: 'claude', prefix: 'claude', url_env: 'CLAUDE_URL', key_env: 'CLAUDE_KEY', payload: 'text' },
  ]),
  GROK_URL: 'https://grok.example/routine', GROK_KEY: 'gk',
  CLAUDE_URL: 'https://claude.example/fire', CLAUDE_KEY: 'ck',
};

function fakeFetch() {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => '' }; };
  fn.calls = calls;
  return fn;
}

async function smsRequest(fields, { token = ENV.TWILIO_AUTH_TOKEN, url = URL_, sign = true } = {}) {
  const params = { MessageSid: sid(), To: '+15185550199', NumMedia: '0', ...fields };
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (sign) headers['x-twilio-signature'] = await twilioSignature(token, url, params);
  return new Request(url, { method: 'POST', headers, body: new URLSearchParams(params).toString() });
}

test('twilioSignature matches an independent HMAC-SHA1 over url + sorted params', async () => {
  const params = { To: '+1', From: '+2', Body: 'hi' };
  const expected = createHmac('sha1', 'tw_token').update(`${URL_}Bodyhi` + 'From+2' + 'To+1').digest('base64');
  assert.equal(await twilioSignature('tw_token', URL_, params), expected);
});

test('owner text with a prefix goes to that agent only, stripped', async () => {
  const f = fakeFetch();
  const res = await handleSms(await smsRequest({ From: OWNER, Body: 'grok what is new' }), ENV, null, { fetchImpl: f });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, ENV.GROK_URL);
  assert.equal(JSON.parse(f.calls[0].init.body).Body, 'what is new');
});

test('a second owner number works too', async () => {
  const f = fakeFetch();
  await handleSms(await smsRequest({ From: '+13125550111', Body: 'claude hi' }), ENV, null, { fetchImpl: f });
  assert.equal(f.calls[0].url, ENV.CLAUDE_URL);
});

test('a bad or missing Twilio signature is rejected before anything else', async () => {
  const f = fakeFetch();
  const forged = await smsRequest({ From: OWNER, Body: 'grok hi' }, { token: 'wrong' });
  assert.equal((await handleSms(forged, ENV, null, { fetchImpl: f })).status, 403);
  const unsigned = await smsRequest({ From: OWNER, Body: 'grok hi' }, { sign: false });
  assert.equal((await handleSms(unsigned, ENV, null, { fetchImpl: f })).status, 403);
  assert.equal(f.calls.length, 0);
});

test('PUBLIC_URL is used for the signature when the worker sits behind another hostname', async () => {
  const f = fakeFetch();
  const req = await smsRequest({ From: OWNER, Body: 'grok hi' }, { url: 'https://sms.example.com/sms' });
  const internal = new Request(URL_, { method: 'POST', headers: req.headers, body: await req.text() });
  const res = await handleSms(internal, { ...ENV, PUBLIC_URL: 'https://sms.example.com' }, null, { fetchImpl: f });
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 1);
});

test('texts from other numbers are ignored quietly', async () => {
  const f = fakeFetch();
  const res = await handleSms(await smsRequest({ From: '+19995550000', Body: 'grok hi' }), ENV, null, { fetchImpl: f });
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 0);
});

test('with a PIN, the text must start with it and the PIN is removed', async () => {
  const f = fakeFetch();
  const env = { ...ENV, PIN: '4821' };
  await handleSms(await smsRequest({ From: OWNER, Body: 'grok hi' }), env, null, { fetchImpl: f });
  assert.equal(f.calls.length, 0);
  await handleSms(await smsRequest({ From: OWNER, Body: '4821 grok hi' }), env, null, { fetchImpl: f });
  assert.equal(JSON.parse(f.calls[0].init.body).Body, 'hi');
});

test('no prefix and no default: a short hint back, nothing forwarded', async () => {
  const f = fakeFetch();
  const res = await handleSms(await smsRequest({ From: OWNER, Body: 'hello' }), ENV, null, { fetchImpl: f });
  assert.match(await res.text(), /<Message>Start your text with one of: grok, claude<\/Message>/);
  assert.equal(f.calls.length, 0);
});

test('ACK replies with the agent name', async () => {
  const f = fakeFetch();
  const res = await handleSms(await smsRequest({ From: OWNER, Body: 'claude hi' }), { ...ENV, ACK: 'Sent to {agent}' }, null, { fetchImpl: f });
  assert.match(await res.text(), /<Message>Sent to claude<\/Message>/);
});

test('MMS media urls are passed along', async () => {
  const f = fakeFetch();
  await handleSms(await smsRequest({ From: OWNER, Body: 'grok look', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/m/1' }), ENV, null, { fetchImpl: f });
  assert.equal(JSON.parse(f.calls[0].init.body).MediaUrl0, 'https://api.twilio.com/m/1');
});

test('worker: health, 404, and a config error still answers Twilio with empty TwiML and sends nothing', async () => {
  assert.equal(await (await worker.fetch(new Request('https://x/health'), ENV, {})).text(), 'ok');
  assert.equal((await worker.fetch(new Request('https://x/nope'), ENV, {})).status, 404);
  const jobs = [];
  const res = await worker.fetch(await smsRequest({ From: OWNER, Body: 'grok hi' }), { ...ENV, ROUTES: 'broken' }, { waitUntil: (p) => jobs.push(p) });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  assert.equal(jobs.length, 0);
});

test('owner numbers match by digits, whatever the formatting', async () => {
  const f = fakeFetch();
  const env = { ...ENV, OWNER_NUMBERS: '+1 (212) 555-0100' };
  await handleSms(await smsRequest({ From: OWNER, Body: 'grok hi' }), env, null, { fetchImpl: f });
  assert.equal(f.calls.length, 1);
  await handleSms(await smsRequest({ From: '+12125550101', Body: 'grok hi' }), env, null, { fetchImpl: f });
  assert.equal(f.calls.length, 1);
  await handleSms(await smsRequest({ From: '', Body: 'grok hi' }), { ...ENV, OWNER_NUMBERS: '' }, null, { fetchImpl: f });
  assert.equal(f.calls.length, 1);
});

test('with a PIN, line breaks in the message survive', async () => {
  const f = fakeFetch();
  await handleSms(await smsRequest({ From: OWNER, Body: '4821 grok line one\n\nline   two' }), { ...ENV, PIN: '4821' }, null, { fetchImpl: f });
  assert.equal(JSON.parse(f.calls[0].init.body).Body, 'line one\n\nline   two');
});

test('a text that is only the PIN, or empty, is ignored', async () => {
  const f = fakeFetch();
  await handleSms(await smsRequest({ From: OWNER, Body: '4821' }), { ...ENV, PIN: '4821' }, null, { fetchImpl: f });
  await handleSms(await smsRequest({ From: OWNER, Body: '   ' }), ENV, null, { fetchImpl: f });
  assert.equal(f.calls.length, 0);
});

test('a query string is part of the signed URL', async () => {
  const f = fakeFetch();
  const url = `${URL_}?tenant=a`;
  const good = await smsRequest({ From: OWNER, Body: 'grok hi' }, { url });
  assert.equal((await handleSms(good, ENV, null, { fetchImpl: f })).status, 200);
  const params = { MessageSid: sid(), To: '+15185550199', NumMedia: '0', From: OWNER, Body: 'grok hi' };
  const signedWithout = await twilioSignature(ENV.TWILIO_AUTH_TOKEN, URL_, params);
  const bad = new Request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signedWithout }, body: new URLSearchParams(params).toString() });
  assert.equal((await handleSms(bad, ENV, null, { fetchImpl: f })).status, 403);
});

test('missing TWILIO_AUTH_TOKEN rejects; TWILIO_VERIFY=false skips the check', async () => {
  const f = fakeFetch();
  const req = () => smsRequest({ From: OWNER, Body: 'grok hi' });
  assert.equal((await handleSms(await req(), { ...ENV, TWILIO_AUTH_TOKEN: '' }, null, { fetchImpl: f })).status, 403);
  const unsigned = await smsRequest({ From: OWNER, Body: 'grok hi' }, { sign: false });
  assert.equal((await handleSms(unsigned, { ...ENV, TWILIO_VERIFY: 'false' }, null, { fetchImpl: f })).status, 200);
  assert.equal(f.calls.length, 1);
});

test('REPLY_ON_NO_MATCH=false stays silent; a default route catches unprefixed texts', async () => {
  const f = fakeFetch();
  const quiet = await handleSms(await smsRequest({ From: OWNER, Body: 'hello' }), { ...ENV, REPLY_ON_NO_MATCH: 'false' }, null, { fetchImpl: f });
  assert.equal(await quiet.text(), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  const routes = JSON.parse(ENV.ROUTES).concat({ name: 'inbox', default: true, url_env: 'INBOX_URL', key_env: 'INBOX_KEY' });
  await handleSms(await smsRequest({ From: OWNER, Body: 'hello' }), { ...ENV, ROUTES: JSON.stringify(routes), INBOX_URL: 'https://inbox.example', INBOX_KEY: 'ik' }, null, { fetchImpl: f });
  assert.equal(f.calls[0].url, 'https://inbox.example');
  assert.equal(JSON.parse(f.calls[0].init.body).text, 'hello');
});

test('ACK replaces every {agent}, does not expand $ patterns, and is XML-escaped', async () => {
  const f = fakeFetch();
  const res = await handleSms(await smsRequest({ From: OWNER, Body: 'grok hi' }), { ...ENV, ACK: '{agent} <ok> & {agent} $&' }, null, { fetchImpl: f });
  assert.match(await res.text(), /<Message>grok &lt;ok&gt; &amp; grok \$&amp;<\/Message>/);
});

test('with a SEEN KV namespace, a repeated MessageSid is delivered once', async () => {
  const f = fakeFetch();
  const store = new Map();
  const SEEN = { get: async (k) => store.get(k) ?? null, put: async (k, v, o) => { store.set(k, v); assert.equal(o.expirationTtl, 86400); } };
  const env = { ...ENV, SEEN };
  await handleSms(await smsRequest({ From: OWNER, Body: 'grok hi', MessageSid: 'SM' + 'd'.repeat(32) }), env, null, { fetchImpl: f });
  await handleSms(await smsRequest({ From: OWNER, Body: 'grok hi', MessageSid: 'SM' + 'd'.repeat(32) }), env, null, { fetchImpl: f });
  assert.equal(f.calls.length, 1);
});

test('the delivery is handed to ctx.waitUntil', async () => {
  const f = fakeFetch();
  const jobs = [];
  await handleSms(await smsRequest({ From: OWNER, Body: 'grok hi' }), ENV, { waitUntil: (p) => jobs.push(p) }, { fetchImpl: f });
  assert.equal(jobs.length, 1);
  assert.deepEqual(await jobs[0], { route: 'grok', ok: true, status: 200 });
});

test('a non-form request gets a 403 before anything is parsed', async () => {
  const f = fakeFetch();
  const req = new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await handleSms(req, ENV, null, { fetchImpl: f })).status, 403);
  assert.equal(f.calls.length, 0);
});

test('a bare prefix with nothing after it is ignored', async () => {
  const f = fakeFetch();
  await handleSms(await smsRequest({ From: OWNER, Body: 'grok' }), ENV, null, { fetchImpl: f });
  assert.equal(f.calls.length, 0);
});

// Twilio signs url + name1 + value1 + name2 + value2... with no separators, so
// the same signature fits other splits of the same string. These rebuild one
// captured request with re-split fields and the original signature.
async function captured(fields) {
  const params = { MessageSid: sid(), To: '+15185550199', NumMedia: '0', From: OWNER, Body: 'grok hi', ...fields };
  const signature = await twilioSignature(ENV.TWILIO_AUTH_TOKEN, URL_, params);
  const send = (p) => new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
    body: new URLSearchParams(p).toString(),
  });
  return { params, send };
}
function kv() {
  const store = new Map();
  return { store, get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } };
}

test('re-splitting a captured request cannot dodge the replay guard', async () => {
  const f = fakeFetch();
  const env = { ...ENV, SEEN: kv() };
  const { params, send } = await captured();
  assert.equal((await handleSms(send(params), env, null, { fetchImpl: f })).status, 200);
  assert.equal(f.calls.length, 1);

  // MessageSi=dSM...: same signature, MessageSid gone
  const { MessageSid, ...rest } = params;
  const noSid = { ...rest, MessageSi: `d${MessageSid}` };
  assert.equal((await handleSms(send(noSid), env, null, { fetchImpl: f })).status, 403);

  // MessageSid swallows the next field: same signature, malformed MessageSid
  const { NumMedia, ...rest2 } = params;
  const swallowed = { ...rest2, MessageSid: `${MessageSid}NumMedia${NumMedia}` };
  assert.equal((await handleSms(send(swallowed), env, null, { fetchImpl: f })).status, 403);

  // T=o+1518...: same signature, MessageSid intact; caught as a repeat
  const { To, ...rest3 } = params;
  const splitTo = { ...rest3, T: `o${To}` };
  assert.equal((await handleSms(send(splitTo), env, null, { fetchImpl: f })).status, 200);
  assert.equal(f.calls.length, 1);
});

test('a request whose MessageSid is not a Twilio SID is rejected even without SEEN', async () => {
  const f = fakeFetch();
  for (const bad of ['', 'SM1', `XX${'0'.repeat(32)}`, `SM${'g'.repeat(32)}`]) {
    const res = await handleSms(await smsRequest({ From: OWNER, Body: 'grok hi', MessageSid: bad }), ENV, null, { fetchImpl: f });
    assert.equal(res.status, 403);
  }
  assert.equal(f.calls.length, 0);
});

test('if the replay guard cannot be read, the text is dropped', async () => {
  const f = fakeFetch();
  const SEEN = { get: async () => { throw new Error('kv down'); }, put: async () => {} };
  const res = await handleSms(await smsRequest({ From: OWNER, Body: 'grok hi' }), { ...ENV, SEEN }, null, { fetchImpl: f });
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 0);
});

test('oversized bodies get a 413 before anything else', async () => {
  const f = fakeFetch();
  const big = new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `Body=${'a'.repeat(70 * 1024)}`,
  });
  assert.equal((await handleSms(big, ENV, null, { fetchImpl: f })).status, 413);
  const lying = new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(10 * 1024 * 1024) },
    body: 'Body=x',
  });
  assert.equal((await handleSms(lying, ENV, null, { fetchImpl: f })).status, 413);
  assert.equal(f.calls.length, 0);
});

test('MMS: media-only texts go to the default route, NumMedia is clamped to the URLs present', async () => {
  const f = fakeFetch();
  const routes = JSON.parse(ENV.ROUTES).concat({ name: 'inbox', default: true, url_env: 'INBOX_URL', key_env: 'INBOX_KEY' });
  const env = { ...ENV, ROUTES: JSON.stringify(routes), INBOX_URL: 'https://inbox.example', INBOX_KEY: 'ik' };
  await handleSms(await smsRequest({ From: OWNER, Body: '', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/m/1' }), env, null, { fetchImpl: f });
  assert.deepEqual(JSON.parse(f.calls[0].init.body).media_urls, ['https://api.twilio.com/m/1']);
  await handleSms(await smsRequest({ From: OWNER, Body: 'grok look', NumMedia: '999999999', MediaUrl0: 'https://api.twilio.com/m/2' }), env, null, { fetchImpl: f });
  const body = JSON.parse(f.calls[1].init.body);
  assert.equal(body.NumMedia, '1');
  assert.equal(body.MediaUrl0, 'https://api.twilio.com/m/2');
});

test('Unicode text survives signing and routing', async () => {
  const f = fakeFetch();
  await handleSms(await smsRequest({ From: OWNER, Body: 'grok café \u{1F680} 你好' }), ENV, null, { fetchImpl: f });
  assert.equal(JSON.parse(f.calls[0].init.body).Body, 'café \u{1F680} 你好');
});

test('with PUBLIC_URL set, a request signed for the internal URL is rejected', async () => {
  const f = fakeFetch();
  const res = await handleSms(await smsRequest({ From: OWNER, Body: 'grok hi' }), { ...ENV, PUBLIC_URL: 'https://sms.example.com' }, null, { fetchImpl: f });
  assert.equal(res.status, 403);
  assert.equal(f.calls.length, 0);
});

test('a PIN with a space is a config error: nothing is delivered', async () => {
  const f = fakeFetch();
  const res = await handleSms(await smsRequest({ From: OWNER, Body: '48 21 grok hi' }), { ...ENV, PIN: '48 21' }, null, { fetchImpl: f });
  assert.equal(res.status, 200);
  assert.equal(f.calls.length, 0);
});

test('worker: /sms/ with a trailing slash works when Twilio signed that URL', async () => {
  const req = await smsRequest({ From: OWNER, Body: 'grok hi' }, { url: `${URL_}/` });
  const jobs = [];
  const res = await worker.fetch(req, { ...ENV, GROK_URL: 'https://grok.example/routine' }, { waitUntil: (p) => jobs.push(p) });
  assert.equal(res.status, 200);
  assert.equal(jobs.length, 1);
});

test('the Worker entry exports only handlers (workerd refuses to start otherwise)', async () => {
  const mod = await import('../src/index.js');
  for (const [name, value] of Object.entries(mod)) {
    assert.ok(typeof value === 'function' || (name === 'default' && typeof value.fetch === 'function'), `export ${name} is not a handler`);
  }
});

test('a chunked body over the cap is cut off without being read in full', async () => {
  const f = fakeFetch();
  let pulled = 0;
  const body = new ReadableStream({
    pull(c) { pulled++; c.enqueue(new TextEncoder().encode('a'.repeat(16 * 1024))); if (pulled > 200) c.close(); },
  });
  const req = new Request(URL_, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, duplex: 'half' });
  assert.equal((await handleSms(req, ENV, null, { fetchImpl: f })).status, 413);
  assert.ok(pulled < 10, `read ${pulled} chunks`);
});
