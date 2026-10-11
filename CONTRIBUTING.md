# Contributing

1. `npm install` (uses `legacy-peer-deps`, see `.npmrc`), then `npx playwright install chromium` if `causecam doctor` reports it missing.
2. `npm run typecheck && npm test` must pass. `npm test` includes a real end-to-end run (browser + instrumented demo + MCP over stdio).
3. Keep the core rules intact:
   - never present an inferred relationship as observed; every link carries a basis and a certainty;
   - never fabricate a source location; unresolvable references are labelled, not guessed;
   - new span attributes are dropped unless added to the allowlist in `src/core/redact.ts` with a reason;
   - all diagnostics go to stderr (the MCP stdio stream must stay clean);
   - trace text that comes from the application is quoted and treated as untrusted.
4. New instrumentation adapters should use official OpenTelemetry instrumentation where it exists and add a test that runs against real spans.
