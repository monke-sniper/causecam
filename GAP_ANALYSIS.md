# CAUSECAM gap analysis

Audit date: 2026-10-11. Scope: the repository at `4218f8b`, plus the uncommitted `docs/` pages. Everything below
comes from runs in this session or from reading source. No benchmark numbers are claimed.

## Verdict

- **Works end to end for one stack** (Chromium → Express → Knex/SQLite). Verified live: the reproduce → inspect →
  fix → verify → compare loop ran with real traces.
- **The unique value is narrow.** The thing CAUSECAM does that a trace-query server cannot is tie a UI action to
  the backend trace it caused (observed via an injected `traceparent`), and then attribute spans to source lines.
  Trace-query servers can show source attributes when the runtime emits them, so attribution alone is not unique.
- **Not yet shown to beat a code-reading agent.** The seeded bug is small enough that reading the route file finds
  it. No blind with/without comparison has been run (see *Baseline* below).
- **Recommendation:** release as an experimental MCP, positioned as complementary to trace-query servers, after
  fixing the three weaknesses below. Do not rewrite.

## Test results

| Check | Result |
|---|---|
| `npm run typecheck` (src + tests) | pass |
| `npm test` on the repo, seeded demo | **47/47 pass** (7 files, includes the end-to-end run) |
| `npm test` with a correct timezone fix applied to `demo/src` | **46/47**: `e2e.test.ts` fails at its first assertion (expected `PUT /api/settings -> 500`, got `int_3 click ok`) |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm audit` (full) | 1 high, in devDependency `@modelcontextprotocol/client` 2.0.0–2.1.0 (test-only) |

The e2e failure is a test-design issue, not a product bug: the test expects the seeded bug to be live in
`demo/src`, so a correct fix breaks it. The suite is not hermetic.

## What works and what is only claimed

| Capability | Status | Evidence |
|---|---|---|
| Browser actions: navigate, click, fill, select, press | Implemented | Ran fill (failed on a `<select>`), select, click, navigate |
| Action → request linkage | Implemented, **inferred** (timing window) | Trace `0f3bccf1…`: `PUT /api/settings … [inferred: action window]` |
| Request → backend span via `traceparent` | Implemented, **observed** | `server PUT /api/settings … [observed: traceparent]` |
| Express route/handler span with registration source | Implemented, verified | `settings.ts:18:10 (route registration, verified)` |
| Knex query span with call site and SQL template | Implemented, verified | `settings.ts:25:11 (query call site, verified)`; SQL shown with `?` placeholders |
| Driver stack → application frame | Limitation, honestly reported | "stack has no application frames (top: knex/…/index.js)" |
| Bind values (the actual `timezone` value) | **Not captured** (privacy default) | Trace says `NOT NULL … user_settings.timezone`, nothing about the value |
| Run-vs-run comparison | Implemented, correct for the fix | `causecam_compare_traces` reported `500 → 200`, NOT NULL error present in A and absent in B |
| Mutation policy (`allowMutations`) | Implemented, **default blocks saves** | Default session: PUT → `blocked (mutation-not-permitted)` |
| Concurrency limit (3 sessions), local-only capture, collector Origin/Host checks | Implemented | Code read (`services.ts`, `browser/session.ts`, `collector.ts`); not exercised at runtime |
| `causecam run --esm` (ESM apps) | Implemented, **not tested** | README says so; not evaluated here |
| Non-Express frameworks, pg/Prisma, upstream `fetch` | **Not implemented** | `register.ts` loads only HTTP, Express and Knex instrumentation |
| Frontend source maps, function-level spans | **Not implemented** | README roadmap |

## Competitors (code and docs inspected, not assumed)

**moondef/otel-mcp** (`0.1.5` on npm; TypeScript, MIT; 2 stars; last push 2025-12-29). An OTLP receiver with an
in-memory, LRU-evicted store, and five MCP tools: `list_traces`, `get_trace` (with `show_attributes`),
`query_spans`, `get_summary`, `clear_traces`. No browser control, no action or request correlation, no source
resolution. **Ran it** against the same app's spans. It returned the failing `PUT`, the `NOT NULL constraint
failed: user_settings.timezone` error, and, with `show_attributes`, the route registration's `code.filepath`,
`code.lineno` and `causecam.source`. It also has a five-attribute display cap that hid the Knex call-site attribute.
It has no way to tell which click produced a given trace.

**traceloop/opentelemetry-mcp-server** (Python; Apache-2.0; 204 stars; last push 2026-06-21). Queries Jaeger, Tempo
or Traceloop backends with 11 tools: `search_traces`, `get_trace`, `find_errors`, `list_services`,
`search_spans_tool`, `list_llm_tools_tool`, and LLM-specific usage, model, slow and expensive-trace tools. No
browser control and no source attribution beyond passing through `exception.stacktrace`. **Not run end to end**
because it needs a Jaeger or Tempo backend. The assessment is from source only.

Both do the trace-querying half better and more broadly than CAUSECAM. CAUSECAM's six tools are a repro loop.

## Strongest defensible differentiator

**The closed loop.** The agent drives the UI action. The backend trace is linked to that action by a header
CAUSECAM injected (observed), and the failing query is attributed to a source line by the runtime. A trace-query
server can only read traces that already exist, and it cannot say which click made them.

Evidence: trace `0f3bccf1…` links the click, the `PUT`, the server span (`observed: traceparent`) and the failing
query at `settings.ts:25:11` in one view.

Caveat: source attribution comes from CAUSECAM's runtime hooks and could be produced by any OpenTelemetry setup
with those hooks. The defensible part is the correlation and the browser control.

## Workflow run (actual, seeded bug)

| # | Step | Outcome |
|---|---|---|
| 1 | `start_session` (default policy) | Navigate OK, 13 backend spans. Used only to show the default policy. |
| 2 | `fill` on `[data-testid=timezone]` | **Failed**: "Element is not an `<input>`…". The field is a `<select>`. |
| 3 | `select` `Europe/Berlin` | OK |
| 4 | `click` save, in a session started with `allowMutations=true` | `PUT /api/settings → 500`, trace `0f3bccf1…`, 89 ms |
| 5 | `inspect_trace` | Failing `UPDATE` at `settings.ts:25:11`, NOT NULL on `timezone`. No application frame in the driver stack. **Bind value not shown**, so the cause is not identified. |
| 6 | Read source | `normalizeTimezone` maps only aliases (`utc`, `eastern`, …) and returns `null` for canonical IANA names, while `validateSettingsInput` accepts them. This step is manual. |
| 7 | Fix (one line, saved as a patch) | Return canonical IANA names unchanged |
| 8 | `click` save | `PUT /api/settings → 200`, trace `42f8575c…`, 83 ms |
| 9 | `compare_traces` | Reports `500 → 200` and the NOT NULL error removed |

Tool calls on the happy path: 7 CAUSECAM calls, including one failed fill. Plus one session started under the
default policy that could not reproduce the bug, then restarted. This is a call count, not an agent timing.

The seeded demo was restored after the evaluation (`git status` clean for `demo/src`). The fix is kept as
`timezone-fix.patch` in the session scratchpad.

## Baseline: without CAUSECAM's browser or trace tools

I ran the buggy HEAD copy in a clean clone. It was instrumented by the same runtime and exported to otel-mcp,
and I reproduced it with one HTTP request:

- The request returned `500` in 49 ms with body `{"error":"Something went wrong"}`. The app's error handler logs
  nothing, so the response alone carries no cause.
- otel-mcp's `list_traces`, `get_trace` and `get_summary` (3 queries) surfaced the NOT NULL error and the failing
  `update` span.
- Finding the cause still required reading `routes/settings.ts` and `settings-transform.ts`, which is the same
  manual step as above.

**Not measured:** a blind agent with equivalent starting state, once with CAUSECAM and once without. I already know
this bug from reading the code, so any run I did would be contaminated. A valid comparison needs a fresh agent per
arm, which costs real tokens and time. I have not run it. The demo is 77 lines, and its bug is reachable from the
route file, so code reading alone is a strong baseline. This demo cannot separate the two approaches, and that is
itself a finding.

## The three biggest technical weaknesses

1. **Narrow instrumentation that patches internals.** `src/runtime/handlers.ts` patches methods on Express's
   `Route` prototype. `src/runtime/knex.ts` patches Knex factory and `then` methods, using `require-in-the-middle`
   with `internals: true`. Both depend on internal module paths and can break silently on a dependency upgrade.
   Coverage is Express and Knex only. Plain `app.use` middleware is not wrapped. There is no pg, Prisma or upstream
   `fetch` coverage.

2. **No value-level evidence.** Bind values are not recorded, by privacy default. The trace reports
   `NOT NULL constraint failed: user_settings.timezone` but not that the value was null, or where null came from.
   In the demo this is the gap that forced the code read. The trace says a null reached a column. It cannot say
   which transform produced it.

3. **Misleading agent-facing behavior, and a non-hermetic test.**
   - Default `allowMutations=false` means the README's own save reproduction fails with a blocked `PUT`. The start
     prompt that `causecam demo` prints does not mention the flag.
   - `perform_action` reports `click ok` for a click whose request was blocked and whose page logged two errors.
     `list_traces` shows `BLOCKED` for the same trace.
   - `fill` on a `<select>` fails with a raw Playwright message and no hint to use `select`.
   - `e2e.test.ts` expects the seeded bug to be live. A correct fix fails it (46/47).

## Smallest change that makes it materially more useful

**Record the shape of bind values for failing queries.** For an errored Knex query, add the null, undefined or type
of each bind parameter (never its value) to the query span, shown under the SQL line:

```text
binds: display_name=string, timezone=NULL, digest_frequency=string, marketing_emails=number, user_id=number
```

Privacy is unchanged, because no values are recorded. The trace would have pointed straight at the null column,
and the code read would have been unnecessary. The scope is `src/runtime/knex.ts`, one allowlisted attribute in
`src/core/redact.ts`, and a test on the same demo scenario. This is a recommendation. It is not implemented.

## Other gaps

- **Correlation:** action linkage is timing-based (350 ms quiet window), so a request from an earlier action can
  attach to the wrong trace. Not tested with concurrent actions.
- **Source ambiguity:** `appCallSite()` takes the first frame outside `node_modules`. A query issued from a shared
  repository helper is attributed to the helper, not the caller. It is labelled `verified` because the file and line
  exist. That label is accurate, but it can mislead. Not tested with a helper.
- **Manual information Claude still has to collect:** bind values; which helper produced a bad value; why a field
  was null; database state; frontend source; anything outside the instrumented layers.
- **Dependency:** one high-severity advisory in a test-only dev dependency.

## Changes made in this pass

- **Product code:** none.
- **Demo:** one-line fix applied for the evaluation, saved as `timezone-fix.patch` in the scratchpad, then restored.
  The seeded bug is live in the working tree again.
- **Docs:** `docs/tools.md` and `docs/configuration.md` are new and uncommitted. This file is new and uncommitted.
- **Processes:** the demo server and its collector, which I started, were stopped. Ports 4318, 4319, 4400 and 4402
  are free.
