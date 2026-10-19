// Prints a curl command that posts a correctly signed Twilio-style SMS webhook,
// for testing signature mode against `wrangler dev` or a deployed Worker.
//
//   TWILIO_AUTH_TOKEN=... node scripts/sign.mjs http://localhost:8787/sms +12125550100 "claude hello"
//
// The URL must be exactly the one you send to: http vs https, host, port and
// path all count. The token is read from the environment so it never lands in
// your shell history (see README for reading it from .dev.vars).

import { twilioSignature } from '../src/twilio.js';

const [url, from, ...words] = process.argv.slice(2);
const token = process.env.TWILIO_AUTH_TOKEN;
if (!url || !from || !words.length || !token) {
  console.error('usage: TWILIO_AUTH_TOKEN=... node scripts/sign.mjs <url> <from> <message...>');
  process.exit(1);
}

const params = {
  MessageSid: `SMtest${Date.now()}`,
  From: from,
  To: '+15005550006',
  Body: words.join(' '),
  NumMedia: '0',
};
const signature = await twilioSignature(token, url, params);
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const fields = Object.entries(params).map(([k, v]) => `--data-urlencode ${q(`${k}=${v}`)}`).join(' ');
console.log(`curl -sS -X POST ${q(url)} -H ${q(`X-Twilio-Signature: ${signature}`)} ${fields}`);
