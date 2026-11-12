const REQ_STRIP = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "keep-alive",
]);
const RES_STRIP = new Set(["connection", "transfer-encoding", "keep-alive"]);

// Per-request access log on stdout; disable with ACCESS_LOG=0|false|off.
const ACCESS_LOG = !/^(0|false|off)$/i.test(process.env.ACCESS_LOG ?? "");

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function fmtDuration(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

const UPSTREAM = process.env.UPSTREAM?.replace(/\/+$/, "");
if (!UPSTREAM) {
  console.error(
    "UPSTREAM env var is required, e.g. UPSTREAM=https://api.example.com",
  );
  process.exit(1);
}

const port = Number(process.env.PORT) || 8787;
const hostname = process.env.HOST ?? "127.0.0.1";

Bun.serve({
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
    const log = (status: number, note = "") => {
      if (!ACCESS_LOG) return;
      console.log(
        [
          `${req.method} ${u.pathname}${u.search}`,
          `-> ${status}`,
          bytes > 0 ? fmtBytes(bytes) : "",
          fmtDuration(performance.now() - started),
          note,
        ]
          .filter(Boolean)
          .join(" "),
      );
    };
    const headers = new Headers();
    for (const [k, v] of req.headers.entries()) {
      if (!REQ_STRIP.has(k.toLowerCase())) headers.set(k, v);
    }
    try {
      const upstream = await fetch(UPSTREAM + u.pathname + u.search, {
        method: req.method,
        headers,
        body: req.body,
        // Propagate client disconnects: stops paying for upstream work the
        // client will never see, and makes "client-aborted" log notes truthful.
        signal: req.signal,
      });
      // Re-wrap so streaming bodies stay streaming (the ReadableStream is
      // piped through chunk-by-chunk, never buffered). Bun's fetch
      // decompresses gzip/br/zstd transparently but leaves content-encoding
      // on the headers; relaying it would make clients try to decode plain
      // text as gzip, so drop stale framing headers instead.
      const resHeaders = new Headers(upstream.headers);
      for (const k of RES_STRIP) resHeaders.delete(k);
      if (resHeaders.has("content-encoding")) {
        resHeaders.delete("content-encoding");
        resHeaders.delete("content-length");
      }
      let resBody = upstream.body;
      if (resBody) {
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
              console.error(`${req.method} ${u.pathname}: ${err}`);
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
        console.error(`${req.method} ${u.pathname}: ${err}`);
      }
      return new Response("Bad Gateway", { status: 502 });
    }
  },
});

console.log(`relay listening on http://${hostname}:${port} -> ${UPSTREAM}`);
