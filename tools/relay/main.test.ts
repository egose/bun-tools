import { expect, test } from "bun:test";
import { request as httpRequest } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";

type SeenRequest = {
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string;
};

async function withRelay(
  env: Record<string, string> | ((upstream: string) => Record<string, string>),
  run: (relay: {
    url: string;
    startup: string;
    requests: SeenRequest[];
    nextLine: () => Promise<string>;
    stop: () => Promise<void>;
    remainingOutput: () => Promise<string>;
    remainingErrors: () => Promise<string>;
  }) => Promise<void>,
  respond?: (body: string) => Response,
  handleRequest?: (req: Request) => Response | Promise<Response>,
) {
  const requests: SeenRequest[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (handleRequest) return handleRequest(req);
      const body = await req.text();
      const u = new URL(req.url);
      requests.push({
        path: u.pathname,
        query: u.search,
        headers: Object.fromEntries(req.headers),
        body,
      });
      return respond
        ? respond(body)
        : new Response(`echo:${body}`, {
            status: 201,
            headers: { "x-upstream": "yes" },
          });
    },
  });

  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts")], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      UPSTREAM: upstream.url.origin,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      ACCESS_LOG: "1",
      ACCESS_LOG_HEADERS: "0",
      ACCESS_LOG_BODY: "0",
      ACCESS_LOG_RESPONSE_HEADERS: "0",
      ACCESS_LOG_QUERY: "0",
      ACCESS_LOG_BODY_MAX_BYTES: "65536",
      ...(typeof env === "function" ? env(upstream.url.origin) : env),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const errors = new Response(proc.stderr).text();
  const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  let stopped = false;

  async function read() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Timed out reading relay output")),
            3000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function nextLine() {
    while (!buffered.includes("\n")) {
      const { done, value } = await read();
      if (done)
        throw new Error(`Relay exited before emitting a line: ${buffered}`);
      buffered += value;
    }
    const end = buffered.indexOf("\n");
    const line = buffered.slice(0, end);
    buffered = buffered.slice(end + 1);
    return line;
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    proc.kill();
    await proc.exited;
  }

  async function remainingOutput() {
    while (true) {
      const { done, value } = await read();
      if (done) return buffered;
      buffered += value;
    }
  }

  try {
    const startup = await nextLine();
    const match = startup.match(
      /^relay listening on (http:\/\/127\.0\.0\.1:\d+) -> /,
    );
    expect(match).not.toBeNull();
    await run({
      url: match![1]!,
      startup,
      requests,
      nextLine,
      stop,
      remainingOutput,
      remainingErrors: () => errors,
    });
  } finally {
    await stop();
    await errors;
    await upstream.stop(true);
  }
}

function detailsFrom(line: string): Record<string, unknown> {
  const start = line.indexOf(" {");
  expect(start).toBeGreaterThanOrEqual(0);
  return JSON.parse(line.slice(start + 1));
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for stream")),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function requestWithBody(
  url: string,
  method: string,
  body: string,
  headers: Record<string, string> = {
    "content-length": String(Buffer.byteLength(body)),
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () =>
        resolve({
          status: res.statusCode!,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("Request timed out")));
    req.end(body);
  });
}

test("default access logs omit request details and health probes", async () => {
  await withRelay({}, async ({ url, requests, nextLine }) => {
    expect(await (await fetch(`${url}/healthz`)).text()).toBe("ok\n");
    expect(await (await fetch(`${url}/readyz`)).text()).toBe("ok\n");

    const body = '{"message":"hello"}';
    const response = await fetch(`${url}/default?x=1`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
      },
      body,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-upstream")).toBe("yes");
    expect(await response.text()).toBe(`echo:${body}`);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toBe(body);
    expect(requests[0]?.headers.authorization).toBe("Bearer secret");

    const line = await nextLine();
    expect(line).toMatch(/^POST \/default -> 201 /);
    expect(line).not.toContain("?x=1");
    expect(line).not.toContain("Bearer secret");
    expect(line).not.toContain(body);
    expect(line).not.toContain(" {");
  });
});

test("request headers can be logged without the body", async () => {
  await withRelay({ ACCESS_LOG_HEADERS: "true" }, async ({ url, nextLine }) => {
    const response = await fetch(`${url}/headers`, {
      method: "POST",
      headers: { authorization: "Bearer example", "x-test": "header value" },
      body: "private body",
    });
    await response.text();

    const line = await nextLine();
    const details = detailsFrom(line);
    expect(details.headers).toMatchObject({
      authorization: "Bearer example",
      "x-test": "header value",
      host: new URL(url).host,
    });
    expect(details).not.toHaveProperty("body");
    expect(line).not.toContain("private body");
  });
});

test("request bodies can be logged without headers as one JSON log line", async () => {
  await withRelay(
    { ACCESS_LOG_BODY: "on" },
    async ({ url, requests, nextLine }) => {
      const body = 'first line\nsecond line: "世界"';
      const response = await fetch(`${url}/body`, {
        method: "POST",
        headers: { "x-test": "not logged" },
        body,
      });
      expect(await response.text()).toBe(`echo:${body}`);
      expect(requests[0]?.body).toBe(body);

      const details = detailsFrom(await nextLine());
      expect(details).toEqual({ body });
    },
  );
});

test("body logging is bounded without changing the forwarded body", async () => {
  await withRelay(
    {
      ACCESS_LOG_HEADERS: "1",
      ACCESS_LOG_BODY: "1",
      ACCESS_LOG_BODY_MAX_BYTES: "5",
    },
    async ({ url, requests, nextLine }) => {
      const body = "abc🙂XYZ";
      const response = await fetch(`${url}/truncated`, {
        method: "POST",
        headers: { "x-test": "both" },
        body,
      });
      expect(await response.text()).toBe(`echo:${body}`);
      expect(requests[0]?.body).toBe(body);

      const details = detailsFrom(await nextLine());
      expect(details.headers).toMatchObject({ "x-test": "both" });
      // The five-byte limit cuts through the emoji; don't log a broken code point.
      expect(details.body).toBe("abc");
      expect(details.bodyTruncated).toBe(true);
      expect(details).not.toHaveProperty("bodyIncomplete");
    },
  );
});

test("body logging records null for requests without a body", async () => {
  await withRelay({ ACCESS_LOG_BODY: "1" }, async ({ url, nextLine }) => {
    const response = await fetch(`${url}/no-body`);
    await response.text();
    expect(detailsFrom(await nextLine())).toEqual({ body: null });
  });
});

test("body logging leaves responses streaming", async () => {
  const release = Promise.withResolvers<void>();
  const encoder = new TextEncoder();
  await withRelay(
    { ACCESS_LOG_BODY: "1" },
    async ({ url, nextLine }) => {
      try {
        const response = await withTimeout(
          fetch(`${url}/stream`, { method: "POST", body: "request body" }),
        );
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let result = "";
        while (!result.includes("first\n")) {
          const chunk = await withTimeout(reader.read());
          expect(chunk.done).toBe(false);
          result += decoder.decode(chunk.value, { stream: true });
        }
        expect(result).toBe("first\n");

        release.resolve();
        while (true) {
          const chunk = await withTimeout(reader.read());
          if (chunk.done) break;
          result += decoder.decode(chunk.value, { stream: true });
        }
        expect(result).toBe("first\nsecond\n");
        expect(detailsFrom(await nextLine())).toEqual({ body: "request body" });
      } finally {
        release.resolve();
      }
    },
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("first\n"));
          },
          async pull(controller) {
            await release.promise;
            controller.enqueue(encoder.encode("second\n"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
});

test("body logging leaves request uploads streaming", async () => {
  const release = Promise.withResolvers<void>();
  const firstReceived = Promise.withResolvers<string>();
  const encoder = new TextEncoder();
  await withRelay(
    { ACCESS_LOG_BODY: "1" },
    async ({ url, nextLine }) => {
      const upload = fetch(`${url}/upload`, {
        method: "POST",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("first-"));
          },
          async pull(controller) {
            await release.promise;
            controller.enqueue(encoder.encode("second"));
            controller.close();
          },
        }),
      });
      // The fixture may close the connection if an assertion fails.
      upload.catch(() => {});
      try {
        expect(await withTimeout(firstReceived.promise)).toBe("first-");
        release.resolve();
        const response = await withTimeout(upload);
        expect(await response.text()).toBe("first-second");
        expect(detailsFrom(await nextLine())).toEqual({ body: "first-second" });
      } finally {
        release.resolve();
      }
    },
    undefined,
    async (req) => {
      const reader = req.body!.getReader();
      const decoder = new TextDecoder();
      let body = "";
      while (!body.includes("first-")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Upload ended before its first chunk");
        body += decoder.decode(chunk.value, { stream: true });
      }
      firstReceived.resolve(body);
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        body += decoder.decode(chunk.value, { stream: true });
      }
      return new Response(body);
    },
  );
});

test("an early upstream response marks a partial logged upload", async () => {
  const release = Promise.withResolvers<void>();
  const firstReceived = Promise.withResolvers<void>();
  const encoder = new TextEncoder();
  await withRelay(
    { ACCESS_LOG_BODY: "1" },
    async ({ url, nextLine }) => {
      const upload = fetch(`${url}/early`, {
        method: "POST",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("first-"));
          },
          async pull(controller) {
            await release.promise;
            controller.enqueue(encoder.encode("second"));
            controller.close();
          },
        }),
      });
      upload.catch(() => {});
      try {
        await withTimeout(firstReceived.promise);
        const line = await nextLine();
        expect(line).toContain("-> 429");
        expect(detailsFrom(line)).toEqual({
          body: "first-",
          bodyIncomplete: true,
        });
      } finally {
        release.resolve();
      }
    },
    undefined,
    async (req) => {
      const chunk = await req.body!.getReader().read();
      if (chunk.done) throw new Error("Upload ended before its first chunk");
      firstReceived.resolve();
      return new Response("rejected", { status: 429 });
    },
  );
});

test("disabling access logs also disables header and body logging", async () => {
  await withRelay(
    {
      ACCESS_LOG: "off",
      ACCESS_LOG_HEADERS: "1",
      ACCESS_LOG_BODY: "1",
      ACCESS_LOG_RESPONSE_HEADERS: "1",
      ACCESS_LOG_QUERY: "1",
    },
    async ({ url, stop, remainingOutput }) => {
      const response = await fetch(`${url}/disabled`, {
        method: "POST",
        body: "secret",
      });
      await response.text();
      await Bun.sleep(50);
      await stop();
      expect(await remainingOutput()).toBe("");
    },
  );
});

test("redirects are returned without replaying uploads or leaking credentials", async () => {
  let targetRequests = 0;
  const target = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      targetRequests++;
      return new Response("must not be reached");
    },
  });
  try {
    await withRelay(
      {},
      async ({ url, nextLine }) => {
        for (const method of ["GET", "POST"]) {
          for (const status of [302, 303, 307]) {
            const response = await fetch(`${url}/${status}`, {
              method,
              redirect: "manual",
              headers: {
                authorization: "Bearer secret",
                cookie: "session=secret",
                "x-api-key": "secret",
              },
              body: method === "POST" ? "request body" : undefined,
            });
            expect(response.status).toBe(status);
            expect(response.headers.get("location")).toBe(
              `${target.url.origin}/destination`,
            );
            expect(await response.text()).toBe("redirect");
            expect(await nextLine()).toContain(`-> ${status}`);
          }
        }
        expect(targetRequests).toBe(0);
      },
      undefined,
      (req) =>
        new Response("redirect", {
          status: Number(new URL(req.url).pathname.slice(1)),
          headers: { location: `${target.url.origin}/destination` },
        }),
    );
  } finally {
    await target.stop(true);
  }
});

test("hop-by-hop and Connection-nominated headers are filtered in both directions", async () => {
  await withRelay(
    {},
    async ({ url, nextLine }) => {
      const response = await fetch(`${url}/headers`, {
        headers: {
          connection: "keep-alive, X-Request-Hop",
          "x-request-hop": "connection secret",
          "proxy-authorization": "Basic proxy-secret",
          te: "trailers",
          trailer: "x-later",
          authorization: "Bearer origin-token",
          "x-end-to-end": "keep",
        },
      });
      const received = (await response.json()) as Record<string, string>;
      for (const name of [
        "x-request-hop",
        "proxy-authorization",
        "te",
        "trailer",
      ]) {
        expect(received).not.toHaveProperty(name);
      }
      expect(received.authorization).toBe("Bearer origin-token");
      expect(received["x-end-to-end"]).toBe("keep");
      expect(received.host).not.toBe(new URL(url).host);
      for (const name of [
        "x-response-hop",
        "proxy-authenticate",
        "proxy-authentication-info",
        "te",
        "trailer",
        "upgrade",
      ]) {
        expect(response.headers.has(name)).toBe(false);
      }
      expect(response.headers.get("x-end-to-end")).toBe("keep");
      await nextLine();
    },
    undefined,
    (req) =>
      Response.json(Object.fromEntries(req.headers), {
        headers: {
          connection: "keep-alive, X-Response-Hop",
          "x-response-hop": "connection secret",
          "proxy-authenticate": 'Basic realm="proxy"',
          "proxy-authentication-info": "proxy-secret",
          te: "trailers",
          trailer: "x-later",
          upgrade: "websocket",
          "x-end-to-end": "keep",
        },
      }),
  );
});

test("known request lengths are preserved with and without body logging", async () => {
  const body = "123🙂";
  for (const logging of ["0", "1"]) {
    await withRelay(
      { ACCESS_LOG_BODY: logging },
      async ({ url, nextLine }) => {
        const response = await fetch(`${url}/requires-length`, {
          method: "POST",
          body,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          length: String(Buffer.byteLength(body)),
          transferEncoding: null,
          body,
        });
        await nextLine();
      },
      undefined,
      async (req) =>
        Response.json(
          {
            length: req.headers.get("content-length"),
            transferEncoding: req.headers.get("transfer-encoding"),
            body: await req.text(),
          },
          { status: req.headers.has("content-length") ? 200 : 411 },
        ),
    );
  }
});

test("zero-length GET requests are still forwarded", async () => {
  await withRelay({}, async ({ url, requests, nextLine }) => {
    const response = await fetch(`${url}/zero`, {
      headers: { "content-length": "0" },
    });
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("echo:");
    expect(requests[0]?.headers["content-length"]).toBe("0");
    await nextLine();
  });
});

test("gzip representations and validators remain unchanged with logging on or off", async () => {
  const compressed = Bun.gzipSync(new TextEncoder().encode("hello world"));
  const digest = `sha-256=:${new Bun.CryptoHasher("sha256").update(compressed).digest("base64")}:`;
  for (const logging of ["1", "0"]) {
    await withRelay(
      { ACCESS_LOG: logging },
      async ({ url, nextLine }) => {
        const response = await fetch(`${url}/gzip`, {
          decompress: false,
          headers: { "accept-encoding": "gzip" },
        });
        expect(response.headers.get("content-encoding")).toBe("gzip");
        expect(response.headers.get("content-length")).toBe(
          String(compressed.byteLength),
        );
        expect(response.headers.get("etag")).toBe('"compressed-entity"');
        expect(response.headers.get("content-digest")).toBe(digest);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(
          compressed,
        );
        if (logging === "1") await nextLine();
      },
      () =>
        new Response(compressed, {
          headers: {
            "content-encoding": "gzip",
            "content-length": String(compressed.byteLength),
            etag: '"compressed-entity"',
            "content-digest": digest,
          },
        }),
    );
  }
});

test("unknown content encodings are not removed", async () => {
  const bytes = new Uint8Array([0, 255, 1, 128]);
  await withRelay(
    {},
    async ({ url, nextLine }) => {
      const response = await fetch(`${url}/opaque`, { decompress: false });
      expect(response.headers.get("content-encoding")).toBe("custom-coding");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      await nextLine();
    },
    () =>
      new Response(bytes, { headers: { "content-encoding": "custom-coding" } }),
  );
});

test("HEAD and 304 responses retain representation metadata", async () => {
  await withRelay(
    {},
    async ({ url, nextLine }) => {
      for (const method of ["HEAD", "GET"]) {
        const response = await fetch(`${url}/metadata`, {
          method,
          decompress: false,
        });
        expect(response.status).toBe(method === "HEAD" ? 200 : 304);
        expect(response.headers.get("content-encoding")).toBe("gzip");
        expect(response.headers.get("etag")).toBe('"compressed-entity"');
        if (method === "HEAD")
          expect(response.headers.get("content-length")).toBe("31");
        expect((await response.arrayBuffer()).byteLength).toBe(0);
        await nextLine();
      }
    },
    undefined,
    (req) =>
      new Response(null, {
        status: req.method === "HEAD" ? 200 : 304,
        headers: {
          "content-encoding": "gzip",
          etag: '"compressed-entity"',
          ...(req.method === "HEAD" ? { "content-length": "31" } : {}),
        },
      }),
  );
});

test("client encoding negotiation is preserved without injecting Accept-Encoding", async () => {
  await withRelay({}, async ({ url, requests, nextLine }) => {
    await (await fetch(`${url}/encoding`, { decompress: false })).text();
    expect(requests[0]?.headers["accept-encoding"]).toBeUndefined();
    await nextLine();
    await (
      await fetch(`${url}/encoding`, {
        decompress: false,
        headers: { "accept-encoding": "gzip" },
      })
    ).text();
    expect(requests[1]?.headers["accept-encoding"]).toBe("gzip");
    await nextLine();
  });
});

test("query secrets are forwarded but omitted from default logs", async () => {
  await withRelay({}, async ({ url, requests, nextLine }) => {
    await (await fetch(`${url}/query?api_key=private-query-secret`)).text();
    expect(requests[0]?.query).toBe("?api_key=private-query-secret");
    const line = await nextLine();
    expect(line).toContain("GET /query -> 201");
    expect(line).not.toContain("api_key");
    expect(line).not.toContain("private-query-secret");
  });
});

test("query logging can be explicitly enabled", async () => {
  await withRelay({ ACCESS_LOG_QUERY: "true" }, async ({ url, nextLine }) => {
    await (await fetch(`${url}/query?x=1&x=2`)).text();
    expect(await nextLine()).toContain("GET /query?x=1&x=2 -> 201");
  });
});

test("response header logging includes Retry-After and repeated cookies", async () => {
  const headers = new Headers({
    "retry-after": "42",
    "cf-ray": "example-ray",
    connection: "x-hop",
    "x-hop": "private",
  });
  headers.append("set-cookie", "a=1; Path=/");
  headers.append("set-cookie", "b=2; Path=/");
  await withRelay(
    { ACCESS_LOG_RESPONSE_HEADERS: "on" },
    async ({ url, nextLine }) => {
      const response = await fetch(`${url}/rate-limit`);
      expect(response.status).toBe(429);
      expect(response.headers.getSetCookie()).toEqual([
        "a=1; Path=/",
        "b=2; Path=/",
      ]);
      await response.text();
      const details = detailsFrom(await nextLine());
      expect(details).not.toHaveProperty("headers");
      expect(details).not.toHaveProperty("body");
      expect(details.responseHeaders).toMatchObject({
        "retry-after": "42",
        "cf-ray": "example-ray",
        "set-cookie": ["a=1; Path=/", "b=2; Path=/"],
      });
      expect(details.responseHeaders).not.toHaveProperty("connection");
      expect(details.responseHeaders).not.toHaveProperty("x-hop");
    },
    () => new Response("rate limited", { status: 429, headers }),
  );
});

test("upstream credentials are not logged and path prefixes are preserved", async () => {
  await withRelay(
    (upstream) => {
      const configured = new URL(upstream);
      configured.username = "demo-user";
      configured.password = "private-password";
      configured.pathname = "/base/";
      return { UPSTREAM: configured.href };
    },
    async ({ url, startup, requests, nextLine }) => {
      expect(startup).not.toContain("demo-user");
      expect(startup).not.toContain("private-password");
      expect(startup).toEndWith("/base");
      await (await fetch(`${url}/chat?x=1`)).text();
      expect(requests[0]?.path).toBe("/base/chat");
      expect(requests[0]?.query).toBe("?x=1");
      expect(requests[0]?.headers.authorization).toBe(
        `Basic ${Buffer.from("demo-user:private-password").toString("base64")}`,
      );
      await nextLine();
      await (
        await fetch(`${url}/chat`, {
          headers: { authorization: "Bearer caller-token" },
        })
      ).text();
      expect(requests[1]?.headers.authorization).toBe("Bearer caller-token");
      await nextLine();
    },
  );
});

test("GET and HEAD payloads are rejected instead of silently dropped", async () => {
  await withRelay(
    { ACCESS_LOG_BODY: "1" },
    async ({ url, requests, nextLine }) => {
      for (const method of ["GET", "HEAD"]) {
        const response = await requestWithBody(
          `${url}/unsupported`,
          method,
          "hello",
        );
        expect(response.status).toBe(400);
        expect(requests).toHaveLength(0);
        const line = await nextLine();
        expect(line).toContain("unsupported-request-body");
        expect(detailsFrom(line)).toEqual({ body: null, bodyIncomplete: true });
      }
    },
  );
});

test("chunked GET payloads are rejected", async () => {
  await withRelay({}, async ({ url, requests, nextLine }) => {
    const response = await requestWithBody(
      `${url}/unsupported`,
      "GET",
      "hello",
      {
        "transfer-encoding": "chunked",
      },
    );
    expect(response.status).toBe(400);
    expect(requests).toHaveLength(0);
    expect(await nextLine()).toContain("unsupported-request-body");
  });
});

test("malformed and conflicting request framing is rejected", async () => {
  await withRelay({}, async ({ url, requests }) => {
    const cases: Record<string, string>[] = [
      { "content-length": "invalid" },
      { "content-length": "5", "transfer-encoding": "chunked" },
    ];
    for (const headers of cases) {
      const response = await requestWithBody(
        `${url}/framing`,
        "POST",
        "hello",
        headers,
      );
      expect(response.status).toBe(400);
      expect(requests).toHaveLength(0);
    }
  });
});

test("transfer-encoded responses do not retain conflicting lengths", async () => {
  const upstream = createTcpServer((socket) => {
    socket.once("data", () =>
      socket.end(
        "HTTP/1.1 200 OK\r\nContent-Length: 100\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
      ),
    );
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address();
  if (!address || typeof address === "string")
    throw new Error("Missing upstream TCP address");
  try {
    await withRelay(
      {
        UPSTREAM: `http://127.0.0.1:${address.port}`,
        ACCESS_LOG_RESPONSE_HEADERS: "1",
      },
      async ({ url, nextLine }) => {
        const response = await fetch(`${url}/chunked`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-length")).not.toBe("100");
        expect(await response.text()).toBe("hello");
        expect(
          detailsFrom(await nextLine()).responseHeaders,
        ).not.toHaveProperty("content-length");
      },
    );
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("upstream failures do not log URL credentials or query secrets", async () => {
  const upstream = createTcpServer((socket) => socket.destroy());
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address();
  if (!address || typeof address === "string")
    throw new Error("Missing upstream TCP address");
  try {
    await withRelay(
      {
        UPSTREAM: `http://demo-user:private-password@127.0.0.1:${address.port}`,
        ACCESS_LOG_RESPONSE_HEADERS: "1",
      },
      async ({ url, startup, nextLine, stop, remainingErrors }) => {
        const response = await fetch(
          `${url}/failure?api_key=private-query-secret`,
        );
        expect(response.status).toBe(502);
        expect(await response.text()).toBe("Bad Gateway");
        const line = await nextLine();
        expect(detailsFrom(line)).toEqual({ responseHeaders: null });
        await stop();
        const output = `${startup}\n${line}\n${await remainingErrors()}`;
        expect(output).toContain("GET /failure");
        expect(output).not.toContain("demo-user");
        expect(output).not.toContain("private-password");
        expect(output).not.toContain("private-query-secret");
      },
    );
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("client disconnects cancel upstream streams with access logging on or off", async () => {
  for (const logging of ["1", "0"]) {
    const disconnected = Promise.withResolvers<void>();
    await withRelay(
      { ACCESS_LOG: logging },
      async ({ url, nextLine, stop, remainingOutput }) => {
        const response = await fetch(`${url}/cancel`);
        const reader = response.body!.getReader();
        expect((await withTimeout(reader.read())).done).toBe(false);
        await reader.cancel();
        await withTimeout(disconnected.promise);
        if (logging === "1") {
          expect(await nextLine()).toContain("client-aborted");
        } else {
          await stop();
          expect(await remainingOutput()).toBe("");
        }
      },
      undefined,
      (req) => {
        req.signal.addEventListener("abort", () => disconnected.resolve());
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: first\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    );
  }
});

for (const [label, env, message] of [
  ["missing upstream", { UPSTREAM: "" }, "UPSTREAM env var is required"],
  [
    "invalid upstream",
    { UPSTREAM: "not-a-url" },
    "UPSTREAM must be an absolute HTTP(S) URL",
  ],
  [
    "file upstream",
    { UPSTREAM: "file:///tmp/opencode" },
    "UPSTREAM must use http:// or https://",
  ],
  [
    "upstream query",
    { UPSTREAM: "http://example.com/base?key=private" },
    "UPSTREAM must not include a query string or fragment",
  ],
  [
    "empty upstream query",
    { UPSTREAM: "http://example.com/base?" },
    "UPSTREAM must not include a query string or fragment",
  ],
  [
    "upstream fragment",
    { UPSTREAM: "http://example.com/base#private" },
    "UPSTREAM must not include a query string or fragment",
  ],
  ["invalid port", { PORT: "abc" }, "PORT must be an integer from 0 to 65535"],
  [
    "out of range port",
    { PORT: "65536" },
    "PORT must be an integer from 0 to 65535",
  ],
] as const) {
  test(`${label} is rejected at startup`, async () => {
    const proc = Bun.spawn(
      [process.execPath, join(import.meta.dir, "main.ts")],
      {
        env: {
          ...process.env,
          UPSTREAM: "http://127.0.0.1",
          PORT: "0",
          ACCESS_LOG: "1",
          ACCESS_LOG_BODY: "0",
          ...env,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain(message);
    expect(stderr).not.toContain("private");
  });
}

test("invalid body log limits fail at startup", async () => {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts")], {
    env: {
      ...process.env,
      ACCESS_LOG: "1",
      ACCESS_LOG_BODY: "1",
      ACCESS_LOG_BODY_MAX_BYTES: "0",
      UPSTREAM: "http://127.0.0.1:1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(exitCode).toBe(1);
  expect(stderr).toContain(
    "ACCESS_LOG_BODY_MAX_BYTES must be a positive integer",
  );
});
