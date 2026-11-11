const REQ_STRIP = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "keep-alive",
]);
const RES_STRIP = new Set(["connection", "transfer-encoding", "keep-alive"]);

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
    // process is up, readiness proves it is accepting connections.
    if (u.pathname === "/healthz" || u.pathname === "/readyz") {
      return new Response("ok\n");
    }
    const headers = new Headers();
    for (const [k, v] of req.headers.entries()) {
      if (!REQ_STRIP.has(k.toLowerCase())) headers.set(k, v);
    }
    try {
      const upstream = await fetch(UPSTREAM + u.pathname + u.search, {
        method: req.method,
        headers,
        body: req.body,
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
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: resHeaders,
      });
    } catch (err) {
      console.error(`${req.method} ${u.pathname}: ${err}`);
      return new Response("Bad Gateway", { status: 502 });
    }
  },
});

console.log(`relay listening on http://${hostname}:${port} -> ${UPSTREAM}`);
