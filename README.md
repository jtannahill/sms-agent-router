# sms-agent-router

Text one phone number, reach whichever AI agent you name.

```
grok what moved in my portfolio today   ->  Grok
claude summarize the PR I just opened   ->  Claude
```

A Twilio number receives the text. A small Cloudflare Worker checks that it really came from Twilio and from you, reads the first word, strips it, and hands the rest to that agent's webhook. The agent does the work and replies however it normally does.

No dependencies, one Worker, about 250 lines.

## How it works

```
your phone --SMS--> Twilio --POST /sms--> sms-agent-router --webhook--> agent
                                           1. verify X-Twilio-Signature
                                           2. sender in OWNER_NUMBERS?
                                           3. optional PIN
                                           4. first word picks the route
                                           5. deliver in the background
                                           6. answer Twilio with empty TwiML
```

- **A prefix is a whole leading word.** `grok hi`, `Grok: hi` and `@grok, hi` all reach `grok` as `hi`. `grokking` and `ask grok` do not.
- **Nothing matches?** It goes to your `default` route if you set one. Otherwise you get a one-line text back listing the prefixes.
- **Twilio always gets a 200**, even on a config error, so it never retries the webhook.
- **No retries to agents.** Most agent endpoints start a new run per request and have no idempotency key; a retry would run the agent twice. Failures are logged instead.

## Setup

You need a Cloudflare account, `wrangler`, and a Twilio number that can receive SMS.

```sh
git clone https://github.com/jtannahill/sms-agent-router
cd sms-agent-router
npm test
```

1. **Pick your routes** in `wrangler.toml` (`ROUTES`, see below).
2. **Add the secrets.** Each route's `url_env` and `key_env` name a secret:

   ```sh
   wrangler secret put TWILIO_AUTH_TOKEN   # Twilio console, Account info
   wrangler secret put OWNER_NUMBERS       # +12125550100 (comma-separate several)
   wrangler secret put GROK_URL
   wrangler secret put GROK_SECRET
   wrangler secret put CLAUDE_URL
   wrangler secret put CLAUDE_KEY
   wrangler secret put PIN                 # optional
   ```

3. **Deploy:** `npm run deploy`. Note the URL, e.g. `https://sms-agent-router.<you>.workers.dev`.
4. **Point Twilio at it.** Twilio console, Phone Numbers, your number, Messaging: "A message comes in" -> Webhook, `HTTP POST`, `https://sms-agent-router.<you>.workers.dev/sms`.
5. **Text it:** `claude are you there?`. Watch `wrangler tail` for `[router] claude: delivered (200)`.

If the Worker sits behind a custom domain or proxy, set `PUBLIC_URL` (e.g. `https://sms.example.com`) to the exact origin Twilio posts to. The signature covers the URL, so it must match.

## Routes

`ROUTES` is a JSON array. Each entry:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Label used in logs and `{agent}` in `ACK`. |
| `prefix` | unless `default` | One word that selects this route. Case-insensitive. |
| `default` | no | `true` for the route that gets texts with no prefix. At most one. |
| `url_env` | yes | Name of the secret holding the agent's webhook URL. |
| `auth` | no | `bearer` (default), `standard-webhooks`, or `none`. |
| `key_env` | unless `auth` is `none` | Name of the secret holding the key or signing secret. |
| `payload` | no | `json` (default), `twilio`, or `text`. |

### Auth

| `auth` | Sends |
|---|---|
| `bearer` | `Authorization: Bearer <key>` |
| `standard-webhooks` | `webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<sig>`, an HMAC-SHA256 over `{id}.{timestamp}.{body}` keyed with the base64 part of a `whsec_...` secret ([standardwebhooks.com](https://www.standardwebhooks.com/)) |
| `none` | Nothing. Only for endpoints you protect some other way. |

### Payloads

| `payload` | Body |
|---|---|
| `json` | `{"type":"sms","from","to","text","message_sid","media_urls":[],"received_at"}` |
| `twilio` | Twilio's own field names: `{"From","To","Body","MessageSid","NumMedia","MediaUrl0",...}` |
| `text` | `{"text":"SMS from +1...\n\n<message>\nAttachment: <url>"}` |

`text` and `media_urls` hold the message with the prefix (and PIN) already removed. MMS attachment URLs are Twilio media URLs; fetching them may need your Twilio credentials.

## Recipes

**Claude Code routine.** On claude.ai/code/routines, edit the routine, add an API trigger and generate a token. The URL looks like `https://api.anthropic.com/v1/claude_code/routines/trig_.../fire`. Use `auth: "bearer"`, `payload: "text"`; the router adds the required `anthropic-version` header for these URLs. In the routine's prompt, tell it to read the `<routine-fire-payload>` block, or it treats the text as inert context.

```json
{ "name": "claude", "prefix": "claude", "url_env": "CLAUDE_URL", "auth": "bearer", "key_env": "CLAUDE_KEY", "payload": "text" }
```

**Grok automation.** On grok.com, Automations, New Automation, add a Webhook trigger, save, and copy the endpoint and the `whsec_...` signing secret (shown once). Use `auth: "standard-webhooks"` ([docs](https://docs.x.ai/grok/automations/webhooks)).

```json
{ "name": "grok", "prefix": "grok", "url_env": "GROK_URL", "auth": "standard-webhooks", "key_env": "GROK_SECRET" }
```

**Any agent with a bearer webhook.** If the agent wants Twilio's raw fields, use `payload: "twilio"`.

```json
{ "name": "bot", "prefix": "bot", "url_env": "BOT_URL", "auth": "bearer", "key_env": "BOT_KEY", "payload": "twilio" }
```

**A catch-all.** Texts without a prefix go here.

```json
{ "name": "inbox", "default": true, "url_env": "INBOX_URL", "auth": "bearer", "key_env": "INBOX_KEY" }
```

## Settings

| Name | Kind | Meaning |
|---|---|---|
| `TWILIO_AUTH_TOKEN` | secret | Verifies `X-Twilio-Signature`. Required unless `TWILIO_VERIFY=false`. |
| `OWNER_NUMBERS` | secret | Numbers allowed to use the router, comma-separated, e.g. `+12125550100`. Compared by digits, so formatting does not matter. Everyone else is ignored. |
| `PIN` | secret, optional | If set, texts must start with it: `4821 grok hi`. |
| `ROUTES` | var | The route list above. |
| `ACK` | var, optional | Text back after routing, e.g. `Sent to {agent}`. Empty means silent. |
| `REPLY_ON_NO_MATCH` | var, optional | `false` to stay silent when no prefix matches and there is no default. |
| `PUBLIC_URL` | var, optional | Origin Twilio posts to, when it differs from the Worker's own URL. |
| `TWILIO_VERIFY` | var, optional | `false` skips signature checks. Local testing only. |

## Security

These agents can often read your mail, run code or drive a browser, so treat the router as a remote control.

- **Signature first.** Requests without a valid Twilio signature get a 403 before anything else runs. Never turn `TWILIO_VERIFY` off in production.
- **Owner numbers are not proof of identity.** Twilio's signature proves the request came from Twilio, not that you sent the text; SMS sender IDs can be spoofed upstream. Set a `PIN` if your agents can take actions that matter.
- **The text is untrusted input to the agent.** Tell each agent, in its own instructions, to treat forwarded texts as requests from you and to ignore instructions embedded in quoted or forwarded content.
- **Secrets stay in Wrangler secrets.** `ROUTES` only names them.

## Local development

```sh
cp .dev.vars.example .dev.vars   # fill it in
npm run dev                      # wrangler dev on :8787
npm test                         # node --test, no install needed
```

To hit `wrangler dev` with curl, set `TWILIO_VERIFY=false` in `.dev.vars` (never in production):

```sh
curl -X POST localhost:8787/sms --data-urlencode From=+12125550100 --data-urlencode To=+15185550199 \
  --data-urlencode 'Body=claude hello' -d MessageSid=SMtest
```

## License

MIT
