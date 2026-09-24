# Security and testing

## Threat model

AGmail and the AMQ bridge are strictly local development tools. Agent communications can contain source code, prompts, logs, and execution commands, so the dashboard must not be exposed to a WAN or untrusted LAN.

The server applies:

- Loopback-only binding
- DNS-rebinding protection through `Host` validation
- Null-byte request rejection
- `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and CSP headers
- Path-traversal and credential-path denial
- Bounded, symlink-rejected local prompt templates
- No-store headers for dashboard HTML, JavaScript, and CSS

Do not place secrets in profiles, briefs, prompt templates, task descriptions, or screenshots.

## Test layers

```bash
npm test
npm run test:security
npm run test:coverage
npm run check
npm run test:e2e
```

`npm test` runs the native unit, integration, simulation, registration-security, and red-team suites. `npm run test:e2e` uses a temporary queue and fake Herdr socket, then captures desktop/mobile journeys without touching live mailboxes.

## Definition of done

A change is ready when syntax, unit/integration tests, browser journeys, audit, and diff checks pass. Report skipped or unavailable gates explicitly; do not turn a missing signal into a pass.
