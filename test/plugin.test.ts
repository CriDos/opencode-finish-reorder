import { test } from "node:test";
import assert from "node:assert/strict";
import plugin from "../src/index.ts";

async function callback() {
  let cb: ((draft: any) => void | Promise<void>) | undefined;
  const ctx = {
    session: {
      hook: async (_name: string, fn: (draft: any) => void | Promise<void>) => {
        cb = fn;
      },
    },
  };
  await plugin.setup(ctx as any);
  assert.ok(cb);
  return cb!;
}

const body = [
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"shell","arguments":"{}"}}]}}]}\n\n',
  "data: [DONE]\n\n",
].join("");

const draft = (providerID: string, type = "text/event-stream") => ({
  kind: "primary" as const,
  model: { providerID, id: "model" },
  request: new Request("http://localhost"),
  response: new Response(body, { headers: { "content-type": type } }),
});

test("reorders a blabla SSE response", async () => {
  const cb = await callback();
  const d = draft("blabla");
  const original = d.response;
  await cb(d);
  assert.notEqual(d.response, original);
  const text = await d.response.text();
  assert.ok(text.indexOf('"call_1"') < text.indexOf('"finish_reason":"stop"'), text);
});

test("leaves other providers alone", async () => {
  const cb = await callback();
  const d = draft("deepai");
  const original = d.response;
  await cb(d);
  assert.equal(d.response, original);
});

test("leaves non-SSE responses alone", async () => {
  const cb = await callback();
  const d = draft("blabla", "application/json");
  const original = d.response;
  await cb(d);
  assert.equal(d.response, original);
});

test("matches the content type case-insensitively", async () => {
  const cb = await callback();
  const d = draft("blabla", "Text/Event-Stream; charset=utf-8");
  const original = d.response;
  await cb(d);
  assert.notEqual(d.response, original);
});

test("cleans stale body headers and keeps status", async () => {
  const cb = await callback();
  const d = draft("blabla");
  d.response = new Response(body, {
    status: 201,
    statusText: "Created",
    headers: {
      "content-type": "text/event-stream",
      "content-length": "999",
      "content-encoding": "gzip",
      "transfer-encoding": "chunked",
    },
  });
  await cb(d);
  assert.equal(d.response.headers.get("content-length"), null);
  assert.equal(d.response.headers.get("content-encoding"), null);
  assert.equal(d.response.headers.get("transfer-encoding"), null);
  assert.equal(d.response.status, 201);
  assert.equal(d.response.statusText, "Created");
});

test("leaves a bodyless response alone", async () => {
  const cb = await callback();
  const d = draft("blabla");
  d.response = new Response(null, { headers: { "content-type": "text/event-stream" } });
  const original = d.response;
  await cb(d);
  assert.equal(d.response, original);
});

test("keeps an error status", async () => {
  const cb = await callback();
  const d = draft("blabla");
  d.response = new Response(body, { status: 500, headers: { "content-type": "text/event-stream" } });
  await cb(d);
  assert.equal(d.response.status, 500);
});
