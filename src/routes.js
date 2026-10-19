// Route config and prefix matching.
//
// ROUTES is a JSON array. Each route names an agent, the prefix that selects
// it, and which secrets hold its URL and credential, so secrets never live in
// the config itself:
//
//   [{ "name": "grok",   "prefix": "grok",   "url_env": "GROK_URL",   "auth": "standard-webhooks", "key_env": "GROK_SECRET" },
//    { "name": "claude", "prefix": "claude", "url_env": "CLAUDE_URL", "auth": "bearer",            "key_env": "CLAUDE_KEY", "payload": "text" },
//    { "name": "inbox",  "default": true,    "url_env": "INBOX_URL",  "auth": "bearer",            "key_env": "INBOX_KEY" }]

// Thrown for mistakes in ROUTES; the message names fields, never secret values.
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const AUTH_TYPES = new Set(['bearer', 'standard-webhooks', 'none']);
const PAYLOADS = new Set(['json', 'twilio', 'text']);
const PREFIX_SHAPE = /^[a-z0-9_-]+$/i;

export function parseRoutes(raw) {
  let routes;
  try {
    routes = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new ConfigError('ROUTES is not valid JSON');
  }
  if (!Array.isArray(routes) || routes.length === 0) throw new ConfigError('ROUTES must be a non-empty array');

  let defaults = 0;
  const seen = new Set();
  const parsed = routes.map((r, i) => {
    const where = `ROUTES[${i}]`;
    if (!r || typeof r !== 'object') throw new ConfigError(`${where} must be an object`);
    if (!r.name || typeof r.name !== 'string') throw new ConfigError(`${where} needs a name`);
    if (!r.url_env) throw new ConfigError(`${where} (${r.name}) needs url_env`);
    if (r.default !== undefined && typeof r.default !== 'boolean') throw new ConfigError(`${where} (${r.name}) default must be true or false`);
    const auth = r.auth || 'bearer';
    if (!AUTH_TYPES.has(auth)) throw new ConfigError(`${where} (${r.name}) has unknown auth "${auth}"`);
    if (auth !== 'none' && !r.key_env) throw new ConfigError(`${where} (${r.name}) needs key_env for auth "${auth}"`);
    const payload = r.payload || 'json';
    if (!PAYLOADS.has(payload)) throw new ConfigError(`${where} (${r.name}) has unknown payload "${payload}"`);

    const isDefault = r.default === true;
    if (isDefault) defaults++;
    const hasPrefix = r.prefix !== undefined && r.prefix !== null && r.prefix !== '';
    if (hasPrefix && (typeof r.prefix !== 'string' || !PREFIX_SHAPE.test(r.prefix))) {
      throw new ConfigError(`${where} (${r.name}) prefix must be one word (letters, digits, - or _)`);
    }
    if (!hasPrefix && !isDefault) throw new ConfigError(`${where} (${r.name}) needs a prefix, or "default": true`);
    const prefix = hasPrefix ? r.prefix.toLowerCase() : null;
    if (prefix && seen.has(prefix)) throw new ConfigError(`prefix "${prefix}" is used twice`);
    if (prefix) seen.add(prefix);
    return { name: r.name, prefix, isDefault, urlEnv: r.url_env, keyEnv: r.key_env || null, auth, payload };
  });
  if (defaults > 1) throw new ConfigError('only one route can be the default');
  return parsed;
}

// Returns { route, text } with the prefix stripped, the default route with the
// whole text when nothing matches, or null when there is no match and no
// default. A prefix only counts as a whole leading word, optionally with a
// leading @ and a trailing : or ,: "grok hi", "Grok: hi" and "@grok, hi" match
// "grok"; "grokking", "grokemon" and "ask grok" do not.
export function matchRoute(body, routes) {
  const text = (body || '').trim();
  for (const route of routes) {
    if (!route.prefix) continue;
    // Prefixes are limited to [a-z0-9_-], so they are safe inside a regex.
    const re = new RegExp(`^@?${route.prefix}(?![\\p{L}\\p{N}_-])[\\s:,]*`, 'iu');
    if (re.test(text)) return { route, text: text.replace(re, '').trim() };
  }
  const fallback = routes.find((r) => r.isDefault);
  return fallback ? { route: fallback, text } : null;
}
