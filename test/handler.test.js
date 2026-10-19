import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker, { handleSms } from '../src/index.js';
import { twilioSignature } from '../src/twilio.js';

const OWNER = '+12125550100';
const URL_ = 'https://router.example.workers.dev/sms';
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
  const params = { MessageSid: 'SM1', To: '+15185550199', NumMedia: '0', ...fields };
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

test('worker: health, 404, and a config error still answers Twilio with 200', async () => {
  assert.equal(await (await worker.fetch(new Request('https://x/health'), ENV, {})).text(), 'ok');
  assert.equal((await worker.fetch(new Request('https://x/nope'), ENV, {})).status, 404);
  const res = await worker.fetch(await smsRequest({ From: OWNER, Body: 'grok hi' }), { ...ENV, ROUTES: 'broken' }, { waitUntil() {} });
  assert.equal(res.status, 200);
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
