// Twilio request validation (X-Twilio-Signature).
// https://www.twilio.com/docs/usage/security#validating-requests
//
// The signature is HMAC-SHA1, keyed with the account auth token, over the full
// webhook URL followed by each POST parameter name and value, sorted by name.

import { enc, hmacBase64, safeEqual } from './crypto.js';

export async function twilioSignature(authToken, url, params) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return hmacBase64('SHA-1', enc.encode(authToken), data);
}

export async function verifyTwilio({ authToken, url, params, signature }) {
  if (!authToken || !signature) return false;
  return safeEqual(await twilioSignature(authToken, url, params), signature);
}

export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export function twimlMessage(text) {
  const safe = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${safe}</Message></Response>`;
}
