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
  assert.throws(() => parseRoutes([{ name: 'a', prefix: 'two words', url_env: 'U', key_env: 'K' }]), /one word/);
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

test('accented letters and digits after a prefix keep it from matching', () => {
  assert.equal(matchRoute('grokémon go', ROUTES), null);
  assert.equal(matchRoute('grok2 hi', ROUTES), null);
});

test('only spaces, colons and commas are stripped after a prefix', () => {
  assert.equal(matchRoute('grok -5 degrees out', ROUTES).text, '-5 degrees out');
  assert.equal(matchRoute('grok\nline one\nline two', ROUTES).text, 'line one\nline two');
});

test('prefixes with - and _ work, and a shorter prefix does not steal a longer one', () => {
  const routes = parseRoutes([
    { name: 'g', prefix: 'g', url_env: 'U', key_env: 'K' },
    { name: 'my-bot', prefix: 'my-bot', url_env: 'U', key_env: 'K' },
    { name: 'grok', prefix: 'grok', url_env: 'U', key_env: 'K' },
  ]);
  assert.equal(matchRoute('grok hi', routes).route.name, 'grok');
  assert.equal(matchRoute('g hi', routes).route.name, 'g');
  assert.equal(matchRoute('my-bot: hi', routes).route.name, 'my-bot');
  assert.equal(matchRoute('my hi', routes), null);
});

test('default must be a real boolean and a present prefix is always checked', () => {
  assert.throws(() => parseRoutes([{ name: 'a', default: 'false', url_env: 'U', key_env: 'K' }]), /true or false/);
  assert.throws(() => parseRoutes([{ name: 'a', default: true, prefix: 'two words', url_env: 'U', key_env: 'K' }]), /one word/);
  assert.throws(() => parseRoutes([{ name: 'a', prefix: 5, url_env: 'U', key_env: 'K' }]), /one word/);
});
