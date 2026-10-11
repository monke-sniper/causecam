# Configuration and CLI

This page covers the `causecam` command, the environment variables it reads, where data is stored, and how to
instrument an existing app. For the MCP tools themselves, see [tools.md](tools.md).

## Commands

Run from a clone as `node dist/cli.js <command>`, or run `npm link` once to get a `causecam` command on your PATH.

| Command | Purpose |
|---|---|
| `causecam mcp` | Serve the MCP tools over stdio. This is what MCP clients launch. |
| `causecam demo [--port <n>] [--no-watch]` | Start the bundled demo app (port 4400 by default), instrumented, with a seeded bug. `--no-watch` disables restart-on-edit. |
| `causecam run [--service <name>] [--esm] -- <command...>` | Run your own Node.js process with CAUSECAM's runtime preloaded and a local collector started. |
| `causecam collector` | Run only the OTLP/HTTP JSON receiver. For apps that already configure their own OpenTelemetry SDK. |
| `causecam doctor` | Check Node, `node:sqlite`, Chromium, the build, ports, and demo dependencies. |
| `causecam traces list [--session <id>] [--limit <n>] [--all]` | List stored traces. `--all` includes background activity. |
| `causecam traces show <traceId> [--json] [--verbose]` | Show one trace. |
| `causecam traces compare <a> <b>` | Compare two traces. |
| `causecam traces delete <traceId>` | Delete one trace and its spans. |
| `causecam traces purge --yes` | Delete all trace data. Requires `--yes`. |

`causecam run --service` sets `OTEL_SERVICE_NAME`, which is the service name shown in traces. `--esm` also
turns on OpenTelemetry's loader hook for ES modules. See [Limitations](../README.md#limitations).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CAUSECAM_REPO_ROOT` | current working directory | Repository root. Source paths are made relative to it, and nothing outside it is presented as application source. |
| `CAUSECAM_DATA_DIR` | `<repo root>/.causecam` | Directory for `causecam.db` (SQLite, WAL mode). |
| `CAUSECAM_COLLECTOR_PORT` | `4319` | Port for the local OTLP/HTTP receiver on `127.0.0.1`. |

When an MCP client launches `causecam mcp`, the working directory is usually the project root, so
`CAUSECAM_REPO_ROOT` is often unnecessary. Set it explicitly if your client starts servers from somewhere else.

Ports used: **4400** for the demo app and **4319** for the collector. If one is taken, pass `--port` to the demo
or set `CAUSECAM_COLLECTOR_PORT`.

## Connecting an MCP client

Register the server with an absolute path to `dist/cli.js`. A relative path only works from the repo.

**Claude Code** (CLI):

```bash
claude mcp add causecam -- node /absolute/path/to/causecam/dist/cli.js mcp
```

**Claude Code** (project-scoped): the repo ships a `.mcp.json`. Claude Code offers to enable the `causecam` server
the first time you open the folder. Approve it.

**Claude Desktop** and other clients that read a JSON config: add an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "causecam": {
      "command": "node",
      "args": ["/absolute/path/to/causecam/dist/cli.js", "mcp"],
      "env": {
        "CAUSECAM_REPO_ROOT": "/absolute/path/to/your/app"
      }
    }
  }
}
```

The `env` block is optional. Add it when the server should read source from a different project than the one
the client starts it in.

## Instrumenting your own app

From your project root, wrap the command that starts your Node.js server:

```bash
node /absolute/path/to/causecam/dist/cli.js run -- npm run dev
```

`causecam run` sets `NODE_OPTIONS=--import=<causecam>/dist/runtime/register.js` for the child process and starts a
collector on `127.0.0.1:4319`. It makes no changes to application code.

Supported out of the box: Node.js servers (CommonJS), Express 4 and 5, and Knex on any Knex dialect. Other
frameworks, ORMs and drivers produce no spans unless they have OpenTelemetry instrumentation that you configure
yourself. Those spans still arrive through the collector, but without CAUSECAM's source hooks.

If your app already configures the OpenTelemetry SDK, skip the wrapper. Start the collector and point your exporter at it:

```bash
node /absolute/path/to/causecam/dist/cli.js collector
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4319/v1/traces
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
```

## Data storage

All trace data stays on the local machine in `causecam.db`. Nothing is sent to a remote service. To delete data,
use `causecam traces delete <id>` for one trace, or `causecam traces purge --yes` for everything.

Traces are not recorded by default: request and response bodies, headers, cookies, input values (only their
length), screenshots, page contents and SQL bind values. See [Security and privacy](../README.md#security-and-privacy) in the README for the full list.
