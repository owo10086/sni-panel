import assert from "node:assert/strict";
import http from "node:http";
import { once, EventEmitter } from "node:events";
import { deflateSync, gzipSync } from "node:zlib";
import test from "node:test";
import express from "express";
import { createBoundedBodyParser } from "./requestBodyParser";

async function fixture(options: Parameters<typeof createBoundedBodyParser>[0] = {}) {
  const app = express();
  app.set("trust proxy", "loopback");
  const events = new EventEmitter();
  app.use((req, res, next) => {
    res.once("close", () => events.emit("closed"));
    setImmediate(() => events.emit("arrived"));
    next();
  });
  app.use(createBoundedBodyParser(options));
  app.post("/hold", (_req, res) => {
    events.emit("holding", res);
  });
  app.post("/", (req, res) => res.json({ size: req.body?.content?.length || 0 }));
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as import("node:net").AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/`, events,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

const jsonHeaders = { "Content-Type": "application/json" };
const largeBody = JSON.stringify({ content: "x".repeat(1024 * 1024 + 1) });

function gzipCommentPrefix(size: number) {
  const header = Buffer.from(gzipSync("{}").subarray(0, 10));
  header[3] = 0x10; // FCOMMENT: decoded body is still empty until the NUL.
  return Buffer.concat([header, Buffer.alloc(size, "x")]);
}

for (const mode of ["chunked", "gzip decoded", "gzip wire"]) {
  test(`${mode} uploads reserve large capacity before the remaining body is sent`, async () => {
    const compressed = mode !== "chunked";
    const f = await fixture({ maxLargeRequests: 1, timeoutMs: 5000 });
    const holding = once(f.events, "holding");
    const pending = fetch(`${f.url}hold`, { method: "POST", headers: jsonHeaders, body: largeBody });
    void pending.catch(() => {});
    const upload = http.request(f.url, {
      method: "POST", headers: { ...jsonHeaders, "Transfer-Encoding": "chunked", ...(compressed ? { "Content-Encoding": "gzip" } : {}) },
    });
    upload.on("error", () => {});
    try {
      const [heldResponse] = await holding;
      const result = once(upload, "response", { signal: AbortSignal.timeout(1000) });
      // Withhold the final 7 MB and the HTTP terminator. The prefix is not even
      // valid JSON yet, so admission must happen before buffering and parsing.
      const prefix = '{"content":"' + "x".repeat(1024 * 1024 + 64 * 1024);
      upload.write(mode === "gzip wire" ? gzipCommentPrefix(1024 * 1024 + 64 * 1024) : compressed ? gzipSync(prefix) : prefix);
      const [response] = await result;
      const incoming = response as http.IncomingMessage;
      assert.equal(incoming.statusCode, 429);
      assert.ok(Number(incoming.headers["retry-after"]) > 0);
      incoming.resume();
      await once(incoming, "end");
      assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: "{}" })).status, 200);
      // Small streaming/compressed Agent payloads need no large reservation.
      const small = await fetch(f.url, { method: "POST", headers: { ...jsonHeaders, "Content-Encoding": "gzip" }, body: gzipSync('{"content":"agent"}') });
      assert.equal(small.status, 200);
      assert.deepEqual(await small.json(), { size: 5 });
      // Refusing this upload must not release the first request's reservation.
      assert.equal(await rejectedWithoutUpload(f.url, Buffer.byteLength(largeBody)), 429);
      (heldResponse as express.Response).end();
      await (await pending).text();
      assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: largeBody })).status, 200);
    } finally { upload.destroy(); await f.close(); }
  });
}

test("compressed wire size is capped before the rest of a gzip header arrives", async () => {
  const f = await fixture();
  const upload = http.request(f.url, { method: "POST", headers: { ...jsonHeaders, "Content-Encoding": "gzip", "Transfer-Encoding": "chunked" } });
  upload.on("error", () => {});
  try {
    const result = once(upload, "response", { signal: AbortSignal.timeout(1000) });
    upload.write(gzipCommentPrefix(10 * 1024 * 1024 + 64 * 1024));
    const [incoming] = await result as [http.IncomingMessage];
    assert.equal(incoming.statusCode, 413);
    incoming.resume();
    await once(incoming, "end");
    assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: largeBody })).status, 200);
  } finally { upload.destroy(); await f.close(); }
});

test("large reception abort and subsequent close release capacity exactly once", async () => {
  const f = await fixture({ maxConcurrent: 1, maxLargeRequests: 1, maxLargeRequestsPerIp: 1 });
  const upload = http.request(f.url, { method: "POST", headers: { ...jsonHeaders, "Content-Length": String(Buffer.byteLength(largeBody)) } });
  upload.on("error", () => {});
  try {
    const arrived = once(f.events, "arrived");
    upload.write("{");
    await arrived;
    assert.equal(await rejectedWithoutUpload(f.url, Buffer.byteLength(largeBody)), 429);
    const closed = once(f.events, "closed");
    upload.destroy();
    await closed;
    const holding = once(f.events, "holding");
    const pending = fetch(`${f.url}hold`, { method: "POST", headers: jsonHeaders, body: largeBody });
    void pending.catch(() => {});
    const [heldResponse] = await holding;
    assert.equal(await rejectedWithoutUpload(f.url, Buffer.byteLength(largeBody)), 429);
    (heldResponse as express.Response).end();
    await (await pending).text();
    assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: largeBody })).status, 200);
  } finally { upload.destroy(); await f.close(); }
});

test("closing a response holding parsed large JSON frees its reservation", async () => {
  const f = await fixture({ maxLargeRequests: 1, maxLargeRequestsPerIp: 1 });
  const upload = http.request(`${f.url}hold`, { method: "POST", headers: jsonHeaders });
  upload.on("error", () => {});
  try {
    const holding = once(f.events, "holding");
    upload.end(largeBody);
    await holding;
    assert.equal(await rejectedWithoutUpload(f.url, Buffer.byteLength(largeBody)), 429);
    const closed = once(f.events, "closed");
    upload.destroy();
    await closed;
    assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: largeBody })).status, 200);
  } finally { upload.destroy(); await f.close(); }
});

test("gzip errors reject an unfinished upload and release large and reception capacity", async () => {
  const f = await fixture({ maxConcurrent: 1, maxLargeRequests: 1, maxLargeRequestsPerIp: 1 });
  const upload = http.request(f.url, { method: "POST", headers: { ...jsonHeaders, "Content-Encoding": "gzip", "Transfer-Encoding": "chunked" } });
  upload.on("error", () => {});
  try {
    const result = once(upload, "response", { signal: AbortSignal.timeout(1000) });
    const corrupt = gzipSync(JSON.stringify({ content: "x".repeat(2 * 1024 * 1024) }));
    corrupt[corrupt.length - 8] ^= 0xff; // Invalid CRC, after >1 MB decoded data.
    upload.write(corrupt);
    const [incoming] = await result as [http.IncomingMessage];
    assert.equal(incoming.statusCode, 400);
    incoming.resume();
    await once(incoming, "end");
    const invalid = await fetch(f.url, { method: "POST", headers: jsonHeaders, body: largeBody.slice(0, -1) });
    assert.equal(invalid.status, 400);
    await invalid.text();
    assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: largeBody })).status, 200);
  } finally { upload.destroy(); await f.close(); }
});

test("large slow uploads release reserved capacity after their timeout response", async () => {
  const f = await fixture({ maxConcurrent: 1, maxLargeRequests: 1, timeoutMs: 60 });
  const upload = http.request(f.url, { method: "POST", headers: { ...jsonHeaders, "Content-Length": String(Buffer.byteLength(largeBody)) } });
  upload.on("error", () => {});
  try {
    const result = once(upload, "response");
    upload.write("{");
    const [incoming] = await result as [http.IncomingMessage];
    assert.equal(incoming.statusCode, 408);
    incoming.resume();
    await once(incoming, "end");
    assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: largeBody })).status, 200);
  } finally { upload.destroy(); await f.close(); }
});

for (const [encoding, compress] of [["gzip", gzipSync], ["deflate", deflateSync]] as const) {
  test(`${encoding} large plugin payloads retain capacity until the response finishes`, async () => {
    const f = await fixture({ maxConcurrent: 1, maxLargeRequests: 1 });
    try {
      const headers = { ...jsonHeaders, "Content-Encoding": encoding };
      const body = compress(largeBody);
      const holding = once(f.events, "holding");
      const pending = fetch(`${f.url}hold`, { method: "POST", headers, body });
      void pending.catch(() => {});
      const [heldResponse] = await holding;
      assert.equal(await rejectedWithoutUpload(f.url, Buffer.byteLength(largeBody)), 429);
      assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: '{"content":"small-agent-report"}' })).status, 200);
      (heldResponse as express.Response).json({ ok: true });
      await (await pending).text();
      const response = await fetch(f.url, { method: "POST", headers, body });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { size: 1024 * 1024 + 1 });
    } finally { await f.close(); }
  });
}

async function holdBody(f: Awaited<ReturnType<typeof fixture>>) {
  const arrived = once(f.events, "arrived");
  const request = http.request(f.url, { method: "POST", headers: { ...jsonHeaders, "Content-Length": "100" } });
  request.on("error", () => {});
  request.write("{");
  await arrived;
  return request;
}

async function rejectedWithoutUpload(url: string, size: number) {
  const request = http.request(url, { method: "POST", headers: { ...jsonHeaders, "Content-Length": String(size) } });
  request.on("error", () => {});
  const result = once(request, "response");
  request.flushHeaders();
  const [response] = await result;
  const incoming = response as http.IncomingMessage;
  incoming.resume();
  await once(incoming, "end");
  request.destroy();
  return incoming.statusCode;
}

test("valid large uploads work; parse/size failures do not leak slots", async () => {
  const f = await fixture({ maxConcurrent: 1 });
  try {
    let response = await fetch(f.url, { method: "POST", headers: jsonHeaders, body: largeBody });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { size: 1024 * 1024 + 1 });
    response = await fetch(f.url, { method: "POST", headers: jsonHeaders, body: "{" });
    assert.equal(response.status, 400);
    // The server must reject the declared size without waiting for its body.
    assert.equal(await rejectedWithoutUpload(f.url, 10 * 1024 * 1024 + 1), 413);
    response = await fetch(f.url, { method: "POST", headers: jsonHeaders, body: "{}" });
    assert.equal(response.status, 200);
  } finally { await f.close(); }
});

test("in-flight body limit rejects before reading and releases on disconnect", async () => {
  const f = await fixture({ maxConcurrent: 1 });
  try {
    const held = await holdBody(f);
    const response = await fetch(f.url, { method: "POST", headers: jsonHeaders, body: "{}" });
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get("retry-after")) > 0);
    await response.text();
    const closed = once(f.events, "closed");
    held.destroy();
    await closed;
    assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: "{}" })).status, 200);
  } finally { await f.close(); }
});

test("slow body timeout terminates reader and frees capacity", async () => {
  const f = await fixture({ maxConcurrent: 1, timeoutMs: 60 });
  try {
    const held = await holdBody(f);
    const result = once(held, "response");
    const closed = once(f.events, "closed");
    const [response] = await result;
    assert.equal((response as http.IncomingMessage).statusCode, 408);
    (response as http.IncomingMessage).resume();
    await closed;
    assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: "{}" })).status, 200);
  } finally { await f.close(); }
});

test("large-body rate budget resets and does not throttle small Agent reports", async () => {
  let time = 1;
  const f = await fixture({ largeBodyLimit: 1, now: () => time });
  try {
    assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: largeBody })).status, 200);
    assert.equal(await rejectedWithoutUpload(f.url, Buffer.byteLength(largeBody)), 429);
    assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: "{}" })).status, 200);
    time += 60_000;
    assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: largeBody })).status, 200);
  } finally { await f.close(); }
});

test("chunked/compressed bodies cannot bypass the large JSON parse budget", async () => {
  for (const compressed of [false, true]) {
    const f = await fixture({ largeBodyLimit: 1 });
    const send = async (upload = true) => {
      const request = http.request(f.url, { method: "POST", headers: { ...jsonHeaders, "Transfer-Encoding": "chunked", ...(compressed ? { "Content-Encoding": "gzip" } : {}) } });
      const result = once(request, "response");
      request.on("error", () => {});
      // write() before end() deliberately forces chunked transfer encoding.
      if (upload) {
        request.write(compressed ? gzipSync(largeBody) : largeBody);
        request.end();
      } else {
        request.flushHeaders();
      }
      const [response] = await result;
      const incoming = response as http.IncomingMessage;
      incoming.resume();
      await once(incoming, "end");
      request.destroy();
      return incoming.statusCode;
    };
    try {
      assert.equal(await send(), 200);
      assert.equal(await send(false), 429, "exhausted budget must reject before reading/inflating another body");
    } finally { await f.close(); }
  }
});

test("large parsed bodies remain bounded while route handlers are awaiting work", async () => {
  const f = await fixture({ maxLargeRequests: 1 });
  try {
    const holding = once(f.events, "holding");
    const pending = fetch(`${f.url}hold`, { method: "POST", headers: jsonHeaders, body: largeBody });
    const [heldResponse] = await holding;
    assert.equal(await rejectedWithoutUpload(f.url, Buffer.byteLength(largeBody)), 429);
    assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: "{}" })).status, 200);
    (heldResponse as express.Response).json({ ok: true });
    await (await pending).text();
    assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: largeBody })).status, 200);
  } finally { await f.close(); }
});

test("per-IP reception admission leaves capacity for another trusted client", async () => {
  const f = await fixture({ maxConcurrent: 2, maxPerIp: 1 });
  try {
    const held = await holdBody(f);
    const rejected = await fetch(f.url, { method: "POST", headers: jsonHeaders, body: "{}" });
    assert.equal(rejected.status, 429);
    assert.ok(Number(rejected.headers.get("retry-after")) > 0);
    const other = await fetch(f.url, { method: "POST", headers: { ...jsonHeaders, "x-forwarded-for": "198.51.100.2" }, body: "{}" });
    assert.equal(other.status, 200);
    const closed = once(f.events, "closed");held.destroy();await closed;
    assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: "{}" })).status, 200);
  } finally { await f.close(); }
});

test("decompressed JSON size and URL-encoded form limits reject before handlers", async () => {
  const f = await fixture({ maxConcurrent: 1 });
  try {
    let response = await fetch(f.url, { method: "POST", headers: { ...jsonHeaders, "Content-Encoding": "gzip" }, body: gzipSync(JSON.stringify({ content: "x".repeat(10 * 1024 * 1024 + 1) })) });
    assert.equal(response.status, 413);
    response = await fetch(f.url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "content=" + "x".repeat(1024 * 1024 + 1) });
    assert.equal(response.status, 413);
    response = await fetch(f.url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "content=valid" });
    assert.equal(response.status, 200);assert.deepEqual(await response.json(), { size: 5 });
    assert.equal((await fetch(f.url, { method: "POST", headers: jsonHeaders, body: '{"content":"small-agent-report"}' })).status, 200);
  } finally { await f.close(); }
});
