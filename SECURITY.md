# Security

sms-agent-router sits between a public phone number and AI agents that may be able to read mail, run code or drive a browser. Please treat anything that lets a text reach an agent it should not, or lets a request skip the signature, owner, PIN or replay checks, as a vulnerability.

## Reporting

Please report privately through GitHub: **Security** tab, then **Report a vulnerability** ([link](https://github.com/jtannahill/sms-agent-router/security/advisories/new)). Do not open a public issue for a vulnerability.

Include what you sent, what you expected and what happened. You should get a reply within a few days.

## Supported versions

Only the latest commit on `main` and the most recent release are supported.

## Known limits (not vulnerabilities)

- A sender number is not proof of identity; SMS sender IDs can be spoofed before Twilio. Use `PIN` if your agents can take actions that matter.
- The `SEEN` replay guard is best effort (Cloudflare KV is eventually consistent).
- Forwarded text is untrusted input to your agents; their own instructions must say so.
