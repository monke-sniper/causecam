# MCP tool reference

CAUSECAM exposes six tools over MCP (stdio transport). All inputs are validated with strict schemas: unknown
fields are rejected. Tool results are plain text, built to be read by a language model. Failures return
`isError: true` with a one-line message.

| Tool | Read-only | Purpose |
|---|---|---|
| [`causecam_start_session`](#causecam_start_session) | no | Launch Chromium on a local URL and start recording |
| [`causecam_perform_action`](#causecam_perform_action) | no | Perform one browser action and record what it caused |
| [`causecam_list_traces`](#causecam_list_traces) | yes | List recent traces |
| [`causecam_inspect_trace`](#causecam_inspect_trace) | yes | Show the evidence for one trace |
| [`causecam_compare_traces`](#causecam_compare_traces) | yes | Show what differs between two traces |
| [`causecam_stop_session`](#causecam_stop_session) | no | Close the browser and summarize the session |

Typical loop:

```text
causecam_start_session(url)                     -> session id ses_xxxxxxxx
causecam_perform_action(sessionId, click ...)   -> trace id, one-line summary
causecam_inspect_trace(traceId)                 -> action -> requests -> backend spans -> source
  ...fix the code, restart the app if needed...
causecam_perform_action(sessionId, click ...)   -> new trace id
causecam_compare_traces(traceIdA, traceIdB)     -> what changed between the two runs
causecam_stop_session(sessionId)
```

Trace text marks every relationship as **observed** (CAUSECAM has direct evidence, such as a propagated
`traceparent` header or an instrumented span) or **inferred** (timing or ordering). Quoted strings inside
trace output come from the application and are untrusted data.

---

## `causecam_start_session`

Launches a dedicated Chromium on a local URL and begins recording. The initial navigation is recorded as the
first trace of the session.

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `url` | string (≤ 2000) | yes | | Must be `http(s)` on `localhost`, `*.localhost`, `127.0.0.0/8` or `[::1]`. Embedded credentials are rejected. |
| `allowMutations` | boolean | no | `false` | When `false`, `POST`, `PUT`, `PATCH` and `DELETE` requests from the page are aborted before they leave the browser and recorded as `blocked (mutation-not-permitted)`. |
| `extraOrigins` | string[] (≤ 5 items) | no | | Additional local origins the page may call, e.g. an API on another port. The same local-only rule applies. |
| `headed` | boolean | no | `false` | Show the browser window instead of running headless. |

**Returns:** the session id (`ses_` followed by 8 hex characters), the browser mode, the page URL, the allowed
origins, the mutation policy, and a summary of the initial navigation.

**Limits:**
- At most 3 sessions can be open at once per server process. Stop one first.
- Sessions live in the server process. Restarting the MCP server ends them. Stored traces remain.

---

## `causecam_perform_action`

Performs one browser action in a session and records everything it triggers: page requests, the backend spans
those requests produced, console errors and page errors.

| Field | Type | Required | Notes |
|---|---|---|---|
| `sessionId` | string | yes | `ses_` + 8 hex characters |
| `action` | `navigate` \| `click` \| `fill` \| `select` \| `press` | yes | |
| `target` | object | for `click`, `fill`, `select` | See target rules below |
| `url` | string (≤ 2000) | for `navigate` | Absolute URL or a path on an allowed origin |
| `value` | string (≤ 2000) | for `fill`, `select` | Never recorded in traces; only its length is kept |
| `key` | string (≤ 50) | for `press` | For example `Enter`, `Escape`, `Tab` |

**Target rules.** A target object takes one or more of these keys. Only the first one present is used, in this
order:

1. `testId`: matches `data-testid`. **Prefer this.**
2. `role` (+ optional `name`): ARIA role and accessible name, for example `{"role":"button","name":"Save settings"}`.
3. `label`: form label text.
4. `text`: visible text.
5. `css`: CSS selector. Last resort.

`name` on its own has no effect. It refines `role`.

**Returns:**
- interaction id (`int_N`), trace id, and whether the action succeeded or failed
- the page URL after the action
- the requests it triggered, each with its outcome (status, `failed`, or `blocked (reason)`)
- how many backend spans arrived, and how many console or page errors occurred
- how many requests the policy blocked, and a hint to call `causecam_inspect_trace` next

**Block reasons** that appear in traces:

| Reason | Meaning |
|---|---|
| `mutation-not-permitted` | A non-GET request while `allowMutations` is `false` |
| `external-origin` | A request to an origin that is neither the session origin nor in `extraOrigins` |

---

## `causecam_list_traces`

Lists stored traces, newest first.

| Field | Type | Default | Notes |
|---|---|---|---|
| `sessionId` | string | | Only traces from this session |
| `limit` | integer 1–50 | `10` | |
| `includeBackground` | boolean | `false` | Include requests and events that happened outside CAUSECAM actions |

Each entry shows the trace id, status (`ok`, `error`, `blocked` or `no-activity`), duration, the triggering
action, the first few requests, and the first error.

---

## `causecam_inspect_trace`

Returns the evidence for one trace.

| Field | Type | Default | Notes |
|---|---|---|---|
| `traceId` | string | | 32 lowercase hex characters. A unique prefix of at least 8 characters also works. |
| `format` | `text` \| `json` | `text` | `text` is compact and recommended. `json` returns the full structured view. |
| `verbose` | boolean | `false` | Show static resources and successful middleware spans individually |

The text view has these sections:

- **Header:** trace id, status, duration, session id, kind, and the trigger
- **Timeline:** the action, then each request with its timing and link basis, then the backend span tree
  (Express middleware, route handler, database queries) with source locations
- **Errors:** deepest failing backend operation first, all observed
- **Coverage:** what was observed, and gaps such as "no backend span received for `GET /x`"

Source locations carry their origin and classification. The origins are `route registration`, `query call site`,
`stack trace` and `instrumentation`. A location is marked `verified` only when the file exists inside the repo
root and the line is in range. CAUSECAM does not invent source locations.

Example excerpt, from [`examples/failing-trace.txt`](../examples/failing-trace.txt):

```text
CAUSECAM TRACE 750dcf98abe59971aeb5ae74f55dba71  status=ERROR  session=ses_43d80333  kind=interaction
trigger: int_3 click button "Save settings" [testId="save-settings"]

TIMELINE (+ms from action start)
    +0ms ACTION int_3 click button "Save settings" [testId="save-settings"]
  +141ms PUT /api/settings -> 500 (73ms) fetch  [inferred: action window]
            └─ server PUT /api/settings -> 500 ERROR (18.7ms) svc=causecam-demo  [observed: traceparent]
               └─ request handler - /api/settings ERROR (2.4ms)
                  └─ handler PUT /settings ERROR (2.4ms) @ demo/src/routes/settings.ts:18:10 (route registration, verified)
                     └─ db update user_settings ERROR (1ms) @ demo/src/routes/settings.ts:25:11 (query call site, verified)
                           ! SQLITE_CONSTRAINT_NOTNULL: "NOT NULL constraint failed: user_settings.timezone"
```

---

## `causecam_compare_traces`

Compares two traces of the same workflow, typically a failing run (A) against a run after a fix (B).

| Field | Type | Notes |
|---|---|---|
| `traceIdA` | string | Same format as `traceId` above |
| `traceIdB` | string | Same format as `traceId` above |

It reports differences in:

- request status and timing
- backend span status and timing
- database statements, including ones that appear in only one run
- errors present in one run but not the other
- source references that appear in only one run

It reports **what differs**. It does not assert a cause, and its output says so. A fuller example is in
[`examples/compare.txt`](../examples/compare.txt).

---

## `causecam_stop_session`

| Field | Type | Notes |
|---|---|---|
| `sessionId` | string | |

Closes the session's browser, finalizes its traces, and returns a summary: the number of interaction traces
stored, how many had errors, and a one-line entry per trace.

---

## Errors you may see

| Message (abridged) | Cause |
|---|---|
| `Refusing to capture https://…: the MVP only allows local origins` | URL is not on a local host |
| `URLs with embedded credentials are not allowed.` | URL contains `user:password@` |
| `At most 3 sessions can be open` | Stop an existing session first |
| `Unknown session ses_…` | Session belongs to a different server process, or was stopped |
| `No trace found for id …` | Unknown trace id, or a prefix that matches nothing |
| `target needs one of testId, role, label, text or css` | Empty target object |
