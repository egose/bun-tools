# bun-tools

A collection of small Bun-based tools. Each tool lives in its own directory under
`tools/` and is a self-contained Docker build context.

## Layout

```
tools/<name>/
├── main.ts          # entrypoint
├── package.json
├── Dockerfile
└── .dockerignore
```

## Running a tool locally

```sh
cd tools/relay
UPSTREAM=https://api.example.com bun run dev
```

### Relay behavior and configuration

`UPSTREAM` must be an absolute `http://` or `https://` URL, optionally with a path
prefix. Queries, fragments, and other schemes are rejected at startup. For
example, `UPSTREAM=https://api.example.com/v1` maps `/chat?x=1` to
`https://api.example.com/v1/chat?x=1`. Credentials in the upstream URL are
supported but omitted from the startup log.

The relay preserves response encodings, lengths, and cache validators without
decompressing the body. Redirects are returned to the caller, not followed by
the relay. Hop-by-hop headers (including fields named by `Connection`) are
removed in both directions. Valid request lengths are preserved; uploads
without a known length remain streaming. GET/HEAD payloads are rejected with
`400` because Bun's server/fetch APIs cannot forward them faithfully. WebSocket
upgrades and CONNECT tunneling are not supported.

`HOST` defaults to `127.0.0.1` and `PORT` to `8787`. Ports must be integers from
0 to 65535; `PORT=0` selects an available port for local development or tests.
The Docker image binds to `0.0.0.0`. There is no inbound TLS, authentication, or
rate limiting: use a trusted network or supply those controls at an ingress.
Both `/healthz` and `/readyz` are local probes, not checks of upstream health.

Bun defaults to 256 concurrent fetches. Long-lived SSE streams occupy slots
until they finish, so other requests can queue behind them. Tune
`BUN_CONFIG_MAX_HTTP_REQUESTS` for your workload (for example, `512`), and
account for open connections and memory per relay process.

### Relay access logs

The relay logs a summary of each proxied request by default. Set `ACCESS_LOG=0`
to disable it. Query strings are omitted unless `ACCESS_LOG_QUERY=1` is set.
To append a JSON object containing request/response details, opt in with:

| Variable                        | Logged field                                                   |
| ------------------------------- | -------------------------------------------------------------- |
| `ACCESS_LOG_HEADERS=1`          | `headers`: incoming request headers                            |
| `ACCESS_LOG_BODY=1`             | `body`: incoming request body, as UTF-8 text                   |
| `ACCESS_LOG_RESPONSE_HEADERS=1` | `responseHeaders`: upstream headers after hop-by-hop filtering |

`true` and `on` also enable these options. All options have no effect when
access logging is disabled. The log line is written when the response stream
finishes or fails; response bodies are never captured. Error messages are
limited to error types/codes so credential-bearing URLs are not printed.

For example, with request headers and bodies enabled:

```text
POST /chat -> 200 12B 100ms {"headers":{"content-type":"application/json"},"body":"{\"message\":\"hi\"}"}
```

**Warning:** opted-in headers, bodies, and queries are logged without redaction
and can contain credentials or other sensitive information. Request paths are
always logged and can also contain sensitive data. Enable detailed logging
only where access to the logs is appropriately restricted.

`responseHeaders` does not include headers added later by Bun's HTTP server;
it is `null` when no upstream response was received. Multiple `Set-Cookie`
values are represented as an array.

Bodies are logged as UTF-8 text, with a maximum of 65,536 bytes by default.
Set `ACCESS_LOG_BODY_MAX_BYTES` to a positive integer to change that limit.
`bodyTruncated: true` indicates that the limit was exceeded;
`bodyIncomplete: true` indicates that the request body had not finished being
read when the log was written. These limits affect only the log, not the
forwarded request. Requests without a body, or whose body cannot be captured
(such as rejected GET payloads), are logged with `"body": null`.
The health endpoints `/healthz` and `/readyz` are never included in access logs.

```sh
UPSTREAM=https://api.example.com ACCESS_LOG_HEADERS=1 ACCESS_LOG_BODY=1 bun run start
```

To inspect upstream response headers such as `Retry-After` and `CF-Ray`:

```sh
UPSTREAM=https://opencode.ai ACCESS_LOG_RESPONSE_HEADERS=1 bun run start
```

## Building & running a tool with Docker

Each tool directory is its own build context, so Dockerfiles stay simple:

```sh
docker build -t relay tools/relay
docker run --rm -p 8787:8787 -e UPSTREAM=https://api.example.com relay
```

## Adding a new tool

1. `mkdir tools/<name>` and copy the layout above (entrypoint named `main.ts`).
2. Pin the same Bun version as `.tool-versions` in its `Dockerfile` (`oven/bun:<version>`).
3. If the tool gains dependencies, add a `bun.lock` and extend its Dockerfile with a
   `bun install --production --frozen-lockfile` stage.
