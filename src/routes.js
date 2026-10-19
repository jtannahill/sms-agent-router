// Route config and prefix matching.
//
// ROUTES is a JSON array. Each route names an agent, the prefix that selects
// it, and which env vars hold its URL and credential, so secrets never live
// in the config itself:
//
//   [{ "name": "grok",   "prefix": "grok",   "url_env": "GROK_URL",   "auth": "bearer",            "key_env": "GROK_KEY",   "payload": "twilio" },
//    { "name": "claude", "prefix": "claude", "url_env": "CLAUDE_URL", "auth": "bearer",            "key_env": "CLAUDE_KEY", "payload": "text" },
//    { "name": "inbox",  "default": true,    "url_env": "INBOX_URL",  "auth": "standard-webhooks", "key_env": "INBOX_SECRET" }]

const AUTH_TYPES = new Set(['bearer', 'standard-webhooks', 'none']);
const PAYLOADS = new Set(['json', 'twilio', 'text']);

export function parseRoutes(raw) {
  let routes;
  try {
    routes = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new Error('ROUTES is not valid JSON');
  }
  if (!Array.isArray(routes) || routes.length === 0) throw new Error('ROUTES must be a non-empty array');

  let defaults = 0;
  const seen = new Set();
  const parsed = routes.map((r, i) => {
    const where = `ROUTES[${i}]`;
    if (!r || typeof r !== 'object') throw new Error(`${where} must be an object`);
    if (!r.name) throw new Error(`${where} needs a name`);
    if (!r.url_env) throw new Error(`${where} (${r.name}) needs url_env`);
    const auth = r.auth || 'bearer';
    if (!AUTH_TYPES.has(auth)) throw new Error(`${where} (${r.name}) has unknown auth "${auth}"`);
    if (auth !== 'none' && !r.key_env) throw new Error(`${where} (${r.name}) needs key_env for auth "${auth}"`);
    const payload = r.payload || 'json';
    if (!PAYLOADS.has(payload)) throw new Error(`${where} (${r.name}) has unknown payload "${payload}"`);
    if (r.default) defaults++;
    else if (!r.prefix || !/^[a-z0-9_-]+$/i.test(r.prefix)) {
      throw new Error(`${where} (${r.name}) needs a one-word prefix (letters, digits, - or _)`);
    }
    const prefix = r.prefix ? r.prefix.toLowerCase() : null;
    if (prefix && seen.has(prefix)) throw new Error(`prefix "${prefix}" is used twice`);
    if (prefix) seen.add(prefix);
    return { name: r.name, prefix, isDefault: Boolean(r.default), urlEnv: r.url_env, keyEnv: r.key_env || null, auth, payload };
  });
  if (defaults > 1) throw new Error('only one route can be the default');
  return parsed;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Returns { route, text } with the prefix stripped, the default route with the
// whole text when nothing matches, or null when there is no match and no
// default. A prefix only counts as a whole leading word: "grok hi", "Grok: hi"
// and "@grok, hi" match "grok"; "grokking" and "ask grok" do not.
export function matchRoute(body, routes) {
  const text = (body || '').trim();
  for (const route of routes) {
    if (!route.prefix) continue;
    const re = new RegExp(`^@?${escapeRegex(route.prefix)}(?![a-z0-9_-])[\\s:,.-]*`, 'i');
    if (re.test(text)) return { route, text: text.replace(re, '').trim() };
  }
  const fallback = routes.find((r) => r.isDefault);
  return fallback ? { route: fallback, text } : null;
}
