import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { deliver, buildPayload, standardWebhookHeaders } from '../src/deliver.js';
import { parseRoutes } from '../src/routes.js';

const MSG = {
  from: '+12125550100', to: '+15185550199', text: 'hello', messageSid: 'SM1',
  mediaUrls: ['https://api.twilio.com/m/1'], receivedAt: '2026-10-19T15:00:00.000Z',
};
const KEY = Buffer.from('a-32-byte-signing-key-for-tests!');
const SECRET = `whsec_${KEY.toString('base64')}`;

function fakeFetch(status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok: status < 400, status, text: async () => 'nope' };
  };
  fn.calls = calls;
  return fn;
}

const route = (r) => parseRoutes([{ name: 'a', prefix: 'a', url_env: 'U', key_env: 'K', ...r }])[0];

test('bearer auth with the json payload', async () => {
  const f = fakeFetch();
  const r = await deliver(route({}), MSG, { U: 'https://agent.example/hook', K: 'k1' }, { fetchImpl: f });
  assert.deepEqual(r, { route: 'a', ok: true, status: 200 });
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://agent.example/hook');
  assert.equal(init.headers.authorization, 'Bearer k1');
  assert.deepEqual(JSON.parse(init.body), {
    type: 'sms', from: MSG.from, to: MSG.to, text: 'hello', message_sid: 'SM1',
    media_urls: MSG.mediaUrls, received_at: MSG.receivedAt,
  });
});

test('standard-webhooks signature verifies with an independent HMAC', async () => {
  const f = fakeFetch(202);
  const r = await deliver(route({ auth: 'standard-webhooks' }), MSG, { U: 'https://x/hook', K: SECRET }, { fetchImpl: f, now: () => 1760900000000 });
  assert.equal(r.status, 202);
  const h = f.calls[0].init.headers;
  assert.equal(h.authorization, undefined);
  assert.match(h['webhook-id'], /^msg_[0-9a-f]{32}$/);
  assert.equal(h['webhook-timestamp'], '1760900000');
  const expected = createHmac('sha256', KEY).update(`${h['webhook-id']}.${h['webhook-timestamp']}.${f.calls[0].init.body}`).digest('base64');
  assert.equal(h['webhook-signature'], `v1,${expected}`);
});

test('standardWebhookHeaders is deterministic for a fixed id and time', async () => {
  const h = await standardWebhookHeaders(SECRET, '{}', { now: 1000, id: 'msg_1' });
  const expected = createHmac('sha256', KEY).update('msg_1.1.{}').digest('base64');
  assert.deepEqual(h, { 'webhook-id': 'msg_1', 'webhook-timestamp': '1', 'webhook-signature': `v1,${expected}` });
});

test('twilio and text payload shapes', () => {
  assert.deepEqual(buildPayload('twilio', MSG), {
    From: MSG.from, To: MSG.to, Body: 'hello', MessageSid: 'SM1', NumMedia: '1', MediaUrl0: MSG.mediaUrls[0],
  });
  assert.deepEqual(buildPayload('text', MSG), { text: `SMS from ${MSG.from}\n\nhello\nAttachment: ${MSG.mediaUrls[0]}` });
});

test('Claude routine URLs get the anthropic-version header', async () => {
  const f = fakeFetch();
  await deliver(route({ payload: 'text' }), MSG, { U: 'https://api.anthropic.com/v1/claude_code/routines/trig_1/fire', K: 'k' }, { fetchImpl: f });
  assert.equal(f.calls[0].init.headers['anthropic-version'], '2023-06-01');
});

test('missing config, rejections and network errors are reported, never thrown or retried', async () => {
  const f = fakeFetch(401);
  assert.deepEqual(await deliver(route({}), MSG, { K: 'k' }, { fetchImpl: f }), { route: 'a', ok: false, error: 'U is not set' });
  assert.deepEqual(await deliver(route({}), MSG, { U: 'https://x' }, { fetchImpl: f }), { route: 'a', ok: false, error: 'K is not set' });
  assert.deepEqual(await deliver(route({}), MSG, { U: 'https://x', K: 'k' }, { fetchImpl: f }), { route: 'a', ok: false, status: 401, error: 'nope' });
  assert.equal(f.calls.length, 1);
  const boom = async () => { throw new Error('boom'); };
  assert.deepEqual(await deliver(route({}), MSG, { U: 'https://x', K: 'k' }, { fetchImpl: boom }), { route: 'a', ok: false, error: 'boom' });
});
