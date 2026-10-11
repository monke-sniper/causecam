# CAUSECAM

**Source-linked runtime tracing for AI coding agents.** CAUSECAM drives a local web app in a dedicated
Chromium browser, follows each action into the network requests it triggers and the backend spans those
requests produced (Express handlers, Knex/SQL queries), and hands a coding agent a compact, source-linked
trace over MCP — with every relationship marked **observed** or **inferred**.

> Show the agent what the application actually did, not just what its source suggests it should do.

Status: **MVP / vertical slice.** It works end to end for one stack (Chromium + Node.js + Express + Knex),
which is deliberately narrow. See [Limitations](#limitations).

---

## Quick start (demo, ~2 minutes)

Requirements: Node.js **>= 22.13** (uses the built-in `node:sqlite`), macOS or Linux, and a Playwright-managed Chromium.

```bash
git clone https://github.com/monke-sniper/causecam.git && cd causecam
npm install                        # also builds dist/ (prepare script)
npm run doctor                     # if Chromium is reported missing: npx playwright install chromium
npm run demo                       # demo app on http://localhost:4400, instrumented, with a seeded bug
```

> **Working on this repo with a coding agent?** [CLAUDE.md](CLAUDE.md) has the code map, the rules the tests
> enforce, and the gotchas (seeded demo bug, `dist/` rebuilds, stdout discipline for MCP).

In a second terminal, start Claude Code **in the same folder**. The repo ships a project-scoped
`.mcp.json`, so Claude Code offers to enable the `causecam` server (approve it). Or add it explicitly:

```bash
claude mcp add causecam -- node /absolute/path/to/causecam/dist/cli.js mcp
```

Then ask:

> Use causecam to reproduce the settings-save failure at http://localhost:4400 with time zone
> Europe/Berlin, find the root cause, fix it, and verify the fix by comparing traces.

The demo app runs under `tsx watch`, so Claude's edit restarts it automatically. To restore the bug
afterwards: `git checkout -- demo/src`.

### What Claude sees

Excerpt of a real capture from this repo (full files in `examples/`, produced by `causecam traces show/compare`):

```text
CAUSECAM TRACE 750dcf98abe59971aeb5ae74f55dba71  status=ERROR  session=ses_43d80333  kind=interaction
trigger: int_3 click button "Save settings" [testId="save-settings"]

TIMELINE (+ms from action start)
    +0ms ACTION int_3 click button "Save settings" [testId="save-settings"]
  +141ms PUT /api/settings -> 500 (73ms) fetch  [inferred: action window]
            └─ server PUT /api/settings -> 500 ERROR (18.7ms) svc=causecam-demo  [observed: traceparent]
               ├─ (3 middleware span(s) ok, 14.8ms total)
               └─ request handler - /api/settings ERROR (2.4ms)
                  └─ handler PUT /settings ERROR (2.4ms) @ demo/src/routes/settings.ts:18:10 (route registration, verified)
                     └─ db update user_settings ERROR (1ms) @ demo/src/routes/settings.ts:25:11 (query call site, verified)
                           sql: update `user_settings` set `display_name` = ?, `timezone` = ?, ... where `user_id` = ?
                           ! SQLITE_CONSTRAINT_NOTNULL: "NOT NULL constraint failed: user_settings.timezone"
                             stack has no application frames (top: node_modules/knex/lib/dialects/better-sqlite3/index.js:57:38)
  +163ms [browser console-error] "Saving settings failed with HTTP 500"

ERRORS (deepest failing backend operation first; all observed)
1. [database] db update user_settings failed (SQLITE_CONSTRAINT_NOTNULL); error also recorded on: handler PUT /settings <- ...
   message: "NOT NULL constraint failed: user_settings.timezone"
   at demo/src/routes/settings.ts:25:11 (query call site, verified)
```

After the fix, `causecam_compare_traces` reports (excerpt from `examples/compare.txt`):

```text
REQUESTS (A -> B)
  PUT /api/settings: 500 73ms -> 200 78ms  <- changed
BACKEND SPANS
  changed: db update user_settings | update `user_settings` set ...: error 1ms -> no error 0.9ms
ERRORS
  present in A, absent in B: [database] db update user_settings failed (SQLITE_CONSTRAINT_NOTNULL) ...
NOTE: these are observed differences between two runs. They show where the runs diverged, not by themselves why.
```

The demo's error handler returns a generic `{"error":"Something went wrong"}` and logs nothing, so this
evidence exists only in the trace. The root cause (a timezone normalizer that drops canonical IANA names)
is two calls away from the failing line; the trace points at the line, the agent reads the code.

---

## MCP tools

| Tool | Purpose |
|---|---|
| `causecam_start_session` | Launch Chromium on a **local** URL. `allowMutations` (default `false`) controls whether POST/PUT/PATCH/DELETE from the page are allowed or blocked. |
| `causecam_perform_action` | `navigate` / `click` / `fill` / `select` / `press`, targeting by `testId`, `role`+`name`, `label`, `text` or `css`. Returns interaction id + trace id + a one-line summary. |
| `causecam_list_traces` | Recent traces with outcome, duration, trigger and first error. |
| `causecam_inspect_trace` | The trace above (`format: "json"` for the full structured view). |
| `causecam_compare_traces` | Differences between two runs: request status/timing, span status, SQL statements, errors, source refs. |
| `causecam_stop_session` | Close the browser and summarize. |

## CLI

Run as `node dist/cli.js <command>` from the repo (or `npm link` once to get a `causecam` command).

```text
causecam demo [--port 4400] [--no-watch]   start the bundled demo app, instrumented
causecam run [--service name] [--esm] -- <cmd...>
                                         run your own Node server instrumented + local collector
causecam mcp                             MCP server on stdio
causecam collector                       only the OTLP/HTTP JSON receiver (for apps with their own OTel SDK)
causecam doctor                          check Node, Chromium, ports, build, demo deps
causecam traces [list|show <id>|compare <a> <b>|delete <id>|purge --yes]
```

## Using it on your own app

From your project root:

```bash
node /path/to/causecam/dist/cli.js run -- npm run dev     # or: node server.js, tsx src/server.ts, ...
```

`causecam run` sets `NODE_OPTIONS=--import=<causecam>/dist/runtime/register.js` for the child process and
starts a collector on `127.0.0.1:4319`. **No application code changes.** Register the MCP server in that
project (`claude mcp add causecam -- node /path/to/causecam/dist/cli.js mcp`); Claude Code starts it in the
project root, so source paths become repo-relative. Traces are stored in `./.causecam/causecam.db`
(override with `CAUSECAM_DATA_DIR`, `CAUSECAM_REPO_ROOT`, `CAUSECAM_COLLECTOR_PORT`).

Apps that already configure the OpenTelemetry SDK can instead export to `causecam collector` with
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4319/v1/traces` and protocol `http/json`.

---

## What a trace contains

| Evidence | Source | How it is linked |
|---|---|---|
| Action, element role / accessible name / test id | Playwright | — |
| Requests: method, redacted URL, status, duration, failures, redirects, blocks | Playwright request events + routing | to the action: **inferred** (started during the action window, while no other action ran); navigation document requests: **observed** |
| Backend HTTP server span | `@opentelemetry/instrumentation-http` | to the request: **observed** — CAUSECAM injects a `traceparent` header with a per-request span id and matches the server span's parent id |
| Express middleware / router / request-handler spans | `@opentelemetry/instrumentation-express` | parent/child from instrumentation: **observed** |
| Route handler span + **source location** of the route registration; async errors (Express 5 rejections) with stack | CAUSECAM route hook (`src/runtime/handlers.ts`) | observed |
| SQL query spans (normalized statement, table, operation, error) + **query call site** in app code | `@opentelemetry/instrumentation-knex` + CAUSECAM call-site hook (`src/runtime/knex.ts`) | observed |
| Console errors/warnings, uncaught page errors, dialogs, navigations | Playwright | timestamped within the action window |
| Coverage + gaps | CAUSECAM | e.g. "no backend span received for GET /x", spans that share the trace id but could not be attached |

Source references carry their origin (`route registration`, `query call site`, `stack trace`,
`instrumentation`) and classification (`app` verified/unverified, `dependency`, `generated`,
`node-internal`, `outside-repo`, `browser-url`). Only files that resolve inside the repo root (after
symlinks) are presented as application source, and `verified` means the file exists and the line is in range.

## Architecture

```text
 Claude Code ──MCP stdio──► causecam mcp ─────────────┐
                              │  services.ts           │ reads
                              ▼                        ▼
                    browser/session.ts          core/store.ts (SQLite, WAL) ◄── collector.ts (OTLP/HTTP JSON, 127.0.0.1)
                    Playwright Chromium                                              ▲
                    · per-action trace id                                            │ spans
                    · route(): allowlist, mutation policy,                           │
                      inject traceparent ─────────HTTP──────► your Node app ─────────┘
                                                         (causecam run → runtime/register.js:
                                                          OTel http + express + knex,
                                                          route-handler & query call-site hooks)
 core/assemble.ts  joins records → TraceView (observed/inferred links, errors, coverage)
 core/render.ts    compact text for LLMs      core/compare.ts   run-vs-run differences
 core/source.ts    repo-relative, traversal-safe source resolution
 core/redact.ts    attribute allowlist, URL/SQL/message redaction
```

The CLI and the MCP server share `services.ts` and the same store.

## Security and privacy

- **Local only.** Capture targets must be `localhost`, `*.localhost`, `127.0.0.0/8` or `[::1]`; requests from the page to any other origin are blocked and recorded. The collector binds to `127.0.0.1` and rejects requests with an `Origin` header or a non-loopback `Host` header (CSRF / DNS rebinding).
- **Mutations need permission.** Without `allowMutations`, non-GET/HEAD/OPTIONS requests from the page are aborted before they leave the browser and recorded as `blocked (mutation-not-permitted)`.
- **No arbitrary execution.** MCP tools accept only validated, typed inputs; there is no shell, eval or request replay.
- **Not recorded by default:** request/response bodies, headers, cookies, input values (only their length), screenshots, page contents, SQL bind values.
- **Redaction:** span attributes are allowlisted (unknown attributes are dropped), sensitive query parameters and token-like values are redacted, SQL literals are replaced with `?` — including SQL embedded in driver error messages — and emails/bearer tokens/JWTs are scrubbed from messages.
- **Untrusted text:** console output, exception messages and page strings are sanitized (control/bidi characters removed, length-bounded), always JSON-quoted in trace output, and labelled as untrusted data.
- **Validated references:** trace and session ids are format-checked; source paths are confined to the repo root.
- **Deletion:** `causecam traces delete <id>`, `causecam traces purge --yes`. The database file is created `0600`.

## Limitations

- **One stack:** Chromium via Playwright; Node.js servers; Express 4/5; Knex (any Knex dialect). Other frameworks/ORMs/DB drivers produce no spans unless they have OpenTelemetry instrumentation you configure yourself (then they appear via `causecam collector`, without CAUSECAM's source hooks).
- **CommonJS-loaded modules** are instrumented by default. ESM apps need `causecam run --esm` (OpenTelemetry loader hook); this path is **not covered by tests yet**.
- **Function calls inside handlers are not traced.** The trace shows the failing query and its call site; it does not show which helper produced a bad value. (In the demo the agent still has to read `toSettingsRow` → `normalizeTimezone`.)
- **Driver error stacks** usually contain no application frames; CAUSECAM compensates with the query call site and route registration site but cannot recover arbitrary frames.
- **Action → request** linkage is timing-based (labelled inferred). Requests started more than ~350 ms after the page goes quiet are recorded as background activity. Requests to a different local origin need `extraOrigins`, and cross-origin requests then carry a `traceparent` header that may trigger CORS preflights.
- **Browser stack traces** point at served URLs; frontend source maps are not resolved.
- Sessions live in the MCP server process; restarting the server ends them (stored traces remain).
- Requires Node >= 22.13 (`node:sqlite`, still flagged experimental by Node).
- Not yet evaluated systematically against related tools (Chrome DevTools MCP, Playwright MCP, Sentry Spotlight, Replay.io MCP and OpenTelemetry-backed MCP servers). No novelty claims are made.

## Development

```bash
npm run build        # tsc → dist/
npm run typecheck    # src + tests
npm test             # unit + MCP validation + real end-to-end (Chromium, instrumented demo, MCP stdio)
```

Tests cover the store, OTLP parsing and the collector's HTTP security checks, redaction, source
resolution (including traversal and symlink escapes), correlation rules, comparison, MCP tool validation
and one full reproduce → diagnose → fix → verify scenario against real spans (`test/e2e.test.ts`).

## Roadmap (next steps)

1. **Deeper in-handler evidence:** opt-in function-level spans for application modules (e.g. wrap exports of files under `src/`), so the trace can show *which* helper produced a bad value, not only the failing query.
2. **Broader coverage with the same guarantees:** test the ESM path; add `pg`/Prisma/fetch-to-upstream adapters; resolve frontend source maps for browser errors.
3. **Comparative evaluation:** measure agent iterations-to-fix with and without CAUSECAM on a small bug corpus, and document how this differs from Chrome DevTools MCP, Sentry Spotlight and Replay.io.

License: MIT.
