const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authentication-info",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function enabled(name: string): boolean {
  return ACCESS_LOG && /^(1|true|on)$/i.test(process.env[name] ?? "");
}

// Per-request access log on stdout; disable with ACCESS_LOG=0|false|off.
const ACCESS_LOG = !/^(0|false|off)$/i.test(process.env.ACCESS_LOG ?? "");
// These opt-in logs may contain credentials and other sensitive data.
const LOG_HEADERS = enabled("ACCESS_LOG_HEADERS");
const LOG_BODY = enabled("ACCESS_LOG_BODY");
const LOG_RESPONSE_HEADERS = enabled("ACCESS_LOG_RESPONSE_HEADERS");
const LOG_QUERY = enabled("ACCESS_LOG_QUERY");
const BODY_LOG_LIMIT = Number(
  process.env.ACCESS_LOG_BODY_MAX_BYTES ?? 64 * 1024,
);
if (LOG_BODY && (!Number.isSafeInteger(BODY_LOG_LIMIT) || BODY_LOG_LIMIT < 1)) {
  console.error("ACCESS_LOG_BODY_MAX_BYTES must be a positive integer");
  process.exit(1);
}

function filterHeaders(source: Headers, stripHost = false): Headers {
  const connectionFields = new Set(
    (source.get("connection") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase()),
  );
  // Copy first so repeated Set-Cookie fields survive. Iterate the original
  // while deleting from the copy, and only delete valid, existing field names.
  const headers = new Headers(source);
  for (const [name] of source) {
    if (
      HOP_BY_HOP.has(name) ||
      connectionFields.has(name) ||
      (stripHost && name === "host")
    ) {
      headers.delete(name);
    }
  }
  return headers;
}

function headersForLog(headers: Headers): Record<string, string | string[]> {
  const values: Record<string, string | string[]> = Object.fromEntries(headers);
  const cookies = headers.getSetCookie();
  if (cookies.length > 1) values["set-cookie"] = cookies;
  return values;
}

type BodyLog = {
  body: string | null;
  bodyTruncated?: boolean;
  bodyIncomplete?: boolean;
};

function captureBody(body: ReadableStream<Uint8Array> | null) {
  let complete = body === null;
  let truncated = false;
  let captured = new Uint8Array(0);
  let size = 0;
  // Observe the forwarded stream rather than consuming a clone or buffering
  // the upload. Copy at most BODY_LOG_LIMIT bytes for the log.
  const stream = body?.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const count = Math.min(chunk.byteLength, BODY_LOG_LIMIT - size);
        if (count > 0) {
          const needed = size + count;
          if (needed > captured.byteLength) {
            const capacity = Math.min(
              BODY_LOG_LIMIT,
              Math.max(needed, captured.byteLength * 2, 1024),
            );
            const buffer = new Uint8Array(capacity);
            buffer.set(captured.subarray(0, size));
            captured = buffer;
          }
          captured.set(chunk.subarray(0, count), size);
          size += count;
        }
        if (count < chunk.byteLength) truncated = true;
        controller.enqueue(chunk);
      },
      flush() {
        complete = true;
      },
    }),
  );
  return {
    stream: stream ?? null,
    details(): BodyLog {
      const details: BodyLog = {
        body: body
          ? new TextDecoder().decode(captured.subarray(0, size), {
              // Don't emit a replacement character for a partial UTF-8 code
              // point at the end of a truncated or incomplete capture.
              stream: truncated || !complete,
            })
          : null,
      };
      if (truncated) details.bodyTruncated = true;
      if (!complete) details.bodyIncomplete = true;
      return details;
    },
  };
}

function errorSummary(err: unknown): string {
  // Network error messages may embed URLs containing credentials or queries.
  // Log only the error type/code, not arbitrary error messages.
  const name = err instanceof Error ? err.name : "Error";
  const code =
    err && typeof err === "object" && "code" in err ? err.code : null;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]+$/.test(code)
    ? `${name} (${code})`
    : name;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function fmtDuration(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

const upstreamValue = process.env.UPSTREAM;
if (!upstreamValue) {
  console.error(
    "UPSTREAM env var is required, e.g. UPSTREAM=https://api.example.com",
  );
  process.exit(1);
}

let upstreamUrl: URL;
try {
  upstreamUrl = new URL(upstreamValue);
} catch {
  console.error("UPSTREAM must be an absolute HTTP(S) URL");
  process.exit(1);
}
if (upstreamUrl.protocol !== "http:" && upstreamUrl.protocol !== "https:") {
  console.error("UPSTREAM must use http:// or https://");
  process.exit(1);
}
const withoutQuery = new URL(upstreamUrl);
withoutQuery.search = "";
withoutQuery.hash = "";
if (withoutQuery.href !== upstreamUrl.href) {
  console.error("UPSTREAM must not include a query string or fragment");
  process.exit(1);
}
const UPSTREAM = upstreamUrl.href.replace(/\/+$/, "");
const displayUpstream = new URL(upstreamUrl);
displayUpstream.username = "";
displayUpstream.password = "";

const portValue = process.env.PORT ?? "8787";
const port = Number(portValue);
if (!/^\d+$/.test(portValue) || !Number.isInteger(port) || port > 65535) {
  console.error("PORT must be an integer from 0 to 65535");
  process.exit(1);
}
const hostname = process.env.HOST ?? "127.0.0.1";

const server = Bun.serve({
  port,
  hostname,
  // While we await the upstream the client connection is idle; the default 10s
  // would kill slow upstream requests. 255 is Bun's maximum.
  idleTimeout: 255,
  async fetch(req) {
    const u = new URL(req.url);
    // Health endpoints served locally, never proxied: liveness proves the
    // process is up, readiness proves it is accepting connections. They are
    // also excluded from the access log so probe traffic cannot drown it out.
    if (u.pathname === "/healthz" || u.pathname === "/readyz") {
      return new Response("ok\n");
    }
    const started = performance.now();
    let bytes = 0;
    const incomingBody = req.body;
    const lengthHeader = req.headers.get("content-length");
    const declaredLength = lengthHeader === null ? null : Number(lengthHeader);
    const transferEncoded = req.headers.has("transfer-encoding");
    const hasDeclaredBody = (declaredLength ?? 0) > 0 || transferEncoded;
    let capture: ReturnType<typeof captureBody> | undefined;
    let responseHeaders: Headers | null = null;
    const log = (status: number, note = "") => {
      if (!ACCESS_LOG) return;
      const details: Record<string, unknown> = {};
      if (LOG_HEADERS) details.headers = headersForLog(req.headers);
      if (LOG_BODY) {
        Object.assign(
          details,
          capture?.details() ?? {
            body: null,
            ...(incomingBody || hasDeclaredBody
              ? { bodyIncomplete: true }
              : {}),
          },
        );
      }
      if (LOG_RESPONSE_HEADERS) {
        details.responseHeaders = responseHeaders
          ? headersForLog(responseHeaders)
          : null;
      }
      console.log(
        [
          `${req.method} ${u.pathname}${LOG_QUERY ? u.search : ""}`,
          `-> ${status}`,
          bytes > 0 ? fmtBytes(bytes) : "",
          fmtDuration(performance.now() - started),
          note,
          LOG_HEADERS || LOG_BODY || LOG_RESPONSE_HEADERS
            ? JSON.stringify(details)
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    };

    if (
      lengthHeader !== null &&
      (!/^\d+$/.test(lengthHeader) ||
        !Number.isSafeInteger(declaredLength) ||
        transferEncoded)
    ) {
      log(400, "invalid-request-framing");
      return new Response("Bad Request", { status: 400 });
    }
    // Bun.serve does not expose GET/HEAD bodies and fetch cannot send them.
    // Reject declared payloads rather than silently forwarding an empty body.
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      (incomingBody !== null || hasDeclaredBody)
    ) {
      log(400, "unsupported-request-body");
      return new Response("GET and HEAD request bodies are not supported", {
        status: 400,
      });
    }
    const headers = filterHeaders(req.headers, true);
    if (LOG_BODY) capture = captureBody(incomingBody);
    try {
      const upstream = await fetch(UPSTREAM + u.pathname + u.search, {
        method: req.method,
        headers,
        body: capture?.stream ?? incomingBody,
        // Return redirects to the caller, never replay streamed uploads or
        // forward custom credentials to another origin.
        redirect: "manual",
        // Preserve the exact representation, including encoding, length,
        // digests, and cache validators. Also avoids inventing Accept-Encoding.
        decompress: false,
        // Propagate client disconnects: stops paying for upstream work the
        // client will never see, and makes "client-aborted" log notes truthful.
        signal: req.signal,
      });
      const resHeaders = filterHeaders(upstream.headers);
      // Fetch dechunks transfer-encoded bodies. A conflicting upstream length
      // must not survive after Transfer-Encoding is removed (RFC 9112 §6.3).
      if (upstream.headers.has("transfer-encoding")) {
        resHeaders.delete("content-length");
      }
      responseHeaders = resHeaders;
      let resBody = upstream.body;
      if (ACCESS_LOG && resBody) {
        // Pipe through an identity transform to observe completion: the log
        // line is emitted when the stream actually ends (or the client walks
        // away mid-stream), not when the response headers arrive. Chunks are
        // passed through untouched, so SSE stays chunk-by-chunk.
        const stream = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            bytes += chunk.byteLength;
            controller.enqueue(chunk);
          },
        });
        resBody.pipeTo(stream.writable).then(
          () => log(upstream.status),
          (err) => {
            if (req.signal.aborted) {
              log(upstream.status, "client-aborted");
            } else {
              log(upstream.status, "stream-error");
              console.error(
                `${req.method} ${u.pathname}: ${errorSummary(err)}`,
              );
            }
          },
        );
        resBody = stream.readable;
      } else {
        log(upstream.status);
      }
      return new Response(resBody, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: resHeaders,
      });
    } catch (err) {
      // Client disconnects mid-request are normal (especially for SSE); log
      // them as access lines only, without the error spam.
      if (req.signal.aborted) {
        log(502, "client-aborted");
      } else {
        log(502, "upstream-error");
        console.error(`${req.method} ${u.pathname}: ${errorSummary(err)}`);
      }
      return new Response("Bad Gateway", { status: 502 });
    }
  },
});

console.log(
  `relay listening on ${server.url.origin} -> ${displayUpstream.href.replace(/\/+$/, "")}`,
);
