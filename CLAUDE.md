# CLAUDE.md — working on CAUSECAM

CAUSECAM is a TypeScript MCP server. It drives a local web app in Chromium (Playwright), follows each action into the network requests and backend spans (OpenTelemetry, Express, Knex) it produced, and returns a source-linked trace. Read [README.md](README.md) for the user-facing picture; this file is for working on the code.

## Setup and verification

```bash
npm install                 # prepare script also builds dist/
npm run doctor              # checks Node, Chromium, ports, build, demo deps
npm run typecheck && npm test
```

- `npm test` includes a real end-to-end run (Chromium, instrumented demo, MCP over stdio). If Chromium is missing: `npx playwright install chromium`.
- Requires Node >= 22.13 (uses the built-in `node:sqlite`). The SQLite "experimental" warning in test output is expected.
- Baseline: all tests pass on a clean clone. Run both commands before saying a change works.

## Map of the code

| Path | What it does |
|---|---|
| `src/cli.ts` | CLI entry (`demo`, `run`, `mcp`, `collector`, `doctor`, `traces`) |
| `src/mcp/server.ts` | The six MCP tools and their zod input schemas |
| `src/services.ts` | Shared by CLI and MCP: sessions, actions, trace reads |
| `src/browser/session.ts` | Playwright Chromium, route allowlist, mutation policy, `traceparent` injection |
| `src/collector.ts` | OTLP/HTTP JSON receiver on `127.0.0.1:4319` (CSRF / DNS-rebinding checks) |
| `src/runtime/` | Loaded into the user's app via `NODE_OPTIONS=--import=…/register.js`: OTel setup, route-handler hook (`handlers.ts`), Knex call-site hook (`knex.ts`), call-site helpers (`callsite.ts`) |
| `src/core/assemble.ts` | Joins records into a `TraceView` with observed/inferred links and coverage gaps |
| `src/core/render.ts` | Compact text for LLM consumption |
| `src/core/compare.ts` | Run-vs-run differences |
| `src/core/source.ts` | Repo-relative, traversal- and symlink-safe source resolution |
| `src/core/redact.ts` | Span-attribute allowlist, URL/SQL/message redaction |
| `src/core/store.ts` | SQLite store (WAL), default `./.causecam/causecam.db` |
| `demo/` | Instrumented demo app on port 4400 with one seeded bug (see below) |
| `test/` | Vitest: unit tests plus `e2e.test.ts` (full reproduce → diagnose → fix → verify) |
| `examples/` | Real captured traces referenced by the README |

## Rules that the code and tests depend on

From [CONTRIBUTING.md](CONTRIBUTING.md), restated because they are easy to break:

- **Never present an inferred relationship as observed.** Every link carries a basis and a certainty.
- **Never fabricate a source location.** Unresolvable references get a label, not a guess.
- **New span attributes are dropped unless added to the allowlist** in `src/core/redact.ts`, with a reason.
- **MCP mode uses stdout as the protocol stream.** Diagnostics go to stderr only. CLI commands like `traces show` may use `console.log`; the MCP server may not.
- **Application-sourced text is untrusted.** Console output, exception messages and page strings are sanitized and quoted in trace output.
- **Capture is local-only.** Targets must be `localhost`, `*.localhost`, `127.0.0.0/8` or `[::1]`. Non-GET requests from the page are blocked unless `allowMutations` is set. Do not loosen either without an explicit reason and a test.

## Gotchas

- `dist/` is gitignored and is rebuilt by `npm install` (prepare) or `npm run build`. Rebuild after editing `src/` before running the `causecam` CLI or the `.mcp.json` server, which both run `dist/cli.js`. The e2e test rebuilds on its own.
- `.causecam/` and `.causecam-test/` hold local trace databases and are gitignored. Do not commit them or paste their contents into issues.
- The demo bug is intentional. It lives in `demo/src/settings-transform.ts` (`normalizeTimezone` drops canonical IANA names, so the `user_settings.timezone` NOT NULL insert fails). Don't "fix" it unless the task is to change the demo. `git checkout -- demo/src` restores the seeded state.
- Ports: demo app 4400, collector 4319. Pick another port with `--port` / `CAUSECAM_COLLECTOR_PORT` rather than killing whatever holds it.
- Don't add a new instrumentation adapter without a test that runs against real spans. Prefer official OpenTelemetry instrumentation where one exists.
