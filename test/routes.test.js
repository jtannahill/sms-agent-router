import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoutes, matchRoute } from '../src/routes.js';

const ROUTES = parseRoutes([
  { name: 'grok', prefix: 'grok', url_env: 'GROK_URL', key_env: 'GROK_KEY' },
  { name: 'claude', prefix: 'claude', url_env: 'CLAUDE_URL', key_env: 'CLAUDE_KEY', payload: 'text' },
]);
const WITH_DEFAULT = parseRoutes([
  ...ROUTES.map((r) => ({ name: r.name, prefix: r.prefix, url_env: r.urlEnv, key_env: r.keyEnv })),
  { name: 'inbox', default: true, url_env: 'INBOX_URL', auth: 'standard-webhooks', key_env: 'INBOX_SECRET' },
]);

test('prefix picks the agent and is stripped', () => {
  assert.deepEqual(
    [matchRoute('grok what is new', ROUTES).route.name, matchRoute('grok what is new', ROUTES).text],
    ['grok', 'what is new'],
  );
  assert.equal(matchRoute('Claude: draft a reply', ROUTES).text, 'draft a reply');
  assert.equal(matchRoute('  @GROK, hi', ROUTES).route.name, 'grok');
  assert.equal(matchRoute('grok', ROUTES).text, '');
});

test('a prefix only counts as a whole leading word', () => {
  assert.equal(matchRoute('grokking this now', ROUTES), null);
  assert.equal(matchRoute('ask grok later', ROUTES), null);
  assert.equal(matchRoute('claude-ish', ROUTES), null);
});

test('no match goes to the default route with the full text, or nowhere', () => {
  assert.equal(matchRoute('what is new', ROUTES), null);
  const m = matchRoute('what is new', WITH_DEFAULT);
  assert.deepEqual([m.route.name, m.text], ['inbox', 'what is new']);
});

test('config errors are explicit', () => {
  assert.throws(() => parseRoutes('nope'), /not valid JSON/);
  assert.throws(() => parseRoutes([]), /non-empty/);
  assert.throws(() => parseRoutes([{ name: 'a', prefix: 'a' }]), /url_env/);
  assert.throws(() => parseRoutes([{ name: 'a', prefix: 'a', url_env: 'U' }]), /key_env/);
  assert.throws(() => parseRoutes([{ name: 'a', prefix: 'two words', url_env: 'U', key_env: 'K' }]), /one-word prefix/);
  assert.throws(() => parseRoutes([{ name: 'a', prefix: 'a', url_env: 'U', auth: 'basic', key_env: 'K' }]), /unknown auth/);
  assert.throws(
    () => parseRoutes([
      { name: 'a', prefix: 'x', url_env: 'U', key_env: 'K' },
      { name: 'b', prefix: 'X', url_env: 'U', key_env: 'K' },
    ]),
    /used twice/,
  );
  assert.throws(
    () => parseRoutes([
      { name: 'a', default: true, url_env: 'U', key_env: 'K' },
      { name: 'b', default: true, url_env: 'U', key_env: 'K' },
    ]),
    /only one route/,
  );
  assert.doesNotThrow(() => parseRoutes([{ name: 'open', prefix: 'o', url_env: 'U', auth: 'none' }]));
});
