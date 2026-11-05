import { test } from "node:test";
import assert from "node:assert/strict";
import { createFinishReorder } from "../src/sse.ts";

async function run(chunks: Array<string | Uint8Array>): Promise<string> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
      }
      controller.close();
    },
  });
  return await new Response(stream.pipeThrough(createFinishReorder())).text();
}

const line = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

const finish = (reason: string) => line({ choices: [{ delta: {}, finish_reason: reason }] });

const call = (index: number, id: string, name: string, args: string) =>
  line({ choices: [{ delta: { tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }] } }] });

test("moves a premature finish after a late tool call", async () => {
  const text = await run([
    line({ choices: [{ delta: { reasoning_content: "thinking" } }] }),
    finish("stop"),
    call(0, "call_1", "shell", ""),
    line({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] } }] }),
    "data: [DONE]\n\n",
  ]);
  const toolAt = text.indexOf('"call_1"');
  const finishAt = text.indexOf('"finish_reason":"stop"');
  const doneAt = text.indexOf("[DONE]");
  assert.ok(toolAt !== -1 && finishAt !== -1 && doneAt !== -1, text);
  assert.ok(toolAt < finishAt, text);
  assert.ok(finishAt < doneAt, text);
});

test("leaves a finish in its normal place", async () => {
  const text = await run([
    line({ choices: [{ delta: { content: "ok" } }] }),
    finish("stop"),
    "data: [DONE]\n\n",
  ]);
  assert.ok(text.indexOf('"content":"ok"') < text.indexOf('"finish_reason":"stop"'), text);
  assert.ok(text.indexOf('"finish_reason":"stop"') < text.indexOf("[DONE]"), text);
});

test("does not move a length finish behind late content", async () => {
  const text = await run([
    line({ choices: [{ delta: { content: "ok" } }] }),
    finish("length"),
    line({ choices: [{ delta: { content: "late" } }] }),
    "data: [DONE]\n\n",
  ]);
  assert.ok(text.indexOf('"finish_reason":"length"') < text.indexOf('"content":"late"'), text);
});

test("flushes the held finish when the stream ends without [DONE]", async () => {
  const text = await run([finish("stop"), call(0, "call_1", "shell", '{"command":"ls"}')]);
  const finishAt = text.indexOf('"finish_reason":"stop"');
  assert.ok(text.indexOf('"call_1"') < finishAt, text);
});

test("keeps only the last finish reason", async () => {
  const text = await run([
    finish("stop"),
    call(0, "call_1", "shell", '{"command":"ls"}'),
    finish("tool_calls"),
    "data: [DONE]\n\n",
  ]);
  assert.ok(!text.includes('"finish_reason":"stop"'), text);
  assert.ok(text.indexOf('"call_1"') < text.indexOf('"finish_reason":"tool_calls"'), text);
});

test("splits a finish chunk that also carries content", async () => {
  const text = await run([
    line({ choices: [{ delta: { content: "A" }, finish_reason: "stop" }] }),
    line({ choices: [{ delta: { content: "B" } }] }),
    "data: [DONE]\n\n",
  ]);
  const a = text.indexOf('"content":"A"');
  const b = text.indexOf('"content":"B"');
  const f = text.indexOf('"finish_reason":"stop"');
  assert.ok(a !== -1 && b !== -1 && f !== -1, text);
  assert.ok(a < b, text);
  assert.ok(b < f, text);
});

test("splits a finish chunk that also starts a tool call", async () => {
  const text = await run([
    line({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", type: "function", function: { name: "shell", arguments: "" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }),
    line({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] } }] }),
    "data: [DONE]\n\n",
  ]);
  const init = text.indexOf('"call_1"');
  const args = text.indexOf("command");
  const f = text.indexOf('"finish_reason":"tool_calls"');
  assert.ok(init !== -1 && args !== -1 && f !== -1, text);
  assert.ok(init < args, text);
  assert.ok(args < f, text);
});

test("terminates an unterminated last line before the held finish", async () => {
  const text = await run([
    finish("stop"),
    `data: ${JSON.stringify({ choices: [{ delta: { content: "last" } }] })}`,
  ]);
  const last = text.indexOf('"content":"last"');
  const f = text.indexOf('"finish_reason":"stop"');
  assert.ok(last !== -1 && f !== -1, text);
  assert.ok(last < f, text);
  assert.ok(!text.includes("}}data:"), text);
  assert.ok(text.slice(last, f).includes("\n"), text);
});

test("ignores an empty finish reason", async () => {
  const text = await run([
    finish(""),
    finish("stop"),
    call(0, "call_1", "shell", "{}"),
    "data: [DONE]\n\n",
  ]);
  assert.ok(text.includes('"finish_reason":""'), text);
  assert.ok(text.indexOf('"call_1"') < text.indexOf('"finish_reason":"stop"'), text);
});

test("keeps a new tool call after the finish", async () => {
  const text = await run([
    call(0, "call_1", "shell", ""),
    finish("stop"),
    call(1, "call_2", "read", '{"path":"a"}'),
    "data: [DONE]\n\n",
  ]);
  const first = text.indexOf('"call_1"');
  const second = text.indexOf('"call_2"');
  const f = text.indexOf('"finish_reason":"stop"');
  assert.ok(first !== -1 && second !== -1 && f !== -1, text);
  assert.ok(first < second, text);
  assert.ok(second < f, text);
});

test("keeps args after a premature stop when the call started before it", async () => {
  const text = await run([
    call(0, "call_1", "write", ""),
    finish("stop"),
    call(0, "call_1", "write", '{"path":"a","content":"x"}'),
    "data: [DONE]\n\n",
  ]);
  assert.equal(text.split('"call_1"').length - 1, 2, text);
  assert.ok(text.includes("path"), text);
  assert.ok(text.includes("content"), text);
  assert.ok(text.indexOf("path") < text.indexOf('"finish_reason":"stop"'), text);
});

test("keeps args that arrive after [DONE] when the call started before the finish", async () => {
  const text = await run([
    call(0, "call_1", "subagent", ""),
    finish("stop"),
    "data: [DONE]\n\n",
    call(0, "call_1", "subagent", '{"agent":"general","description":"x","prompt":"y"}'),
  ]);
  const startAt = text.indexOf('"call_1"');
  const argsAt = text.indexOf("general");
  const finishAt = text.indexOf('"finish_reason":"stop"');
  const doneAt = text.indexOf("[DONE]");
  assert.ok(startAt !== -1 && argsAt !== -1 && finishAt !== -1 && doneAt !== -1, text);
  assert.ok(startAt < argsAt, text);
  assert.ok(argsAt < finishAt, text);
  assert.ok(finishAt < doneAt, text);
});

test("does not hold [DONE] on a complete finish", async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          [
            line({ choices: [{ delta: { content: "ok" } }] }),
            finish("stop"),
            "data: [DONE]\n\n",
          ].join(""),
        ),
      );
    },
  });
  const reader = source.pipeThrough(createFinishReorder()).getReader();
  const decoder = new TextDecoder();
  const collect = async () => {
    let out = "";
    for (;;) {
      const { value } = await reader.read();
      out += decoder.decode(value);
      if (out.includes('"finish_reason":"stop"')) return out;
    }
  };
  const first = await Promise.race([
    collect(),
    new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 200)),
  ]);
  reader.cancel();
  assert.notEqual(first, "timeout");
  assert.ok(first.includes('"finish_reason":"stop"'), first);
});

const events = (text: string) =>
  text
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .filter(Boolean);

const assertEvents = (text: string) => {
  const list = events(text);
  for (const event of list) {
    if (event === "data: [DONE]") continue;
    assert.ok(event.startsWith("data: "), event);
    assert.doesNotThrow(() => JSON.parse(event.slice(6)), event);
  }
  return list;
};

test("keeps the head event separate when the terminal chunk carries content", async () => {
  const text = await run([
    line({ choices: [{ delta: { content: "A" }, finish_reason: "stop" }] }),
    line({ choices: [{ delta: { content: "B" } }] }),
    "data: [DONE]\n\n",
  ]);
  const list = assertEvents(text);
  assert.equal(list.length, 4, text);
  assert.ok(text.indexOf('"content":"A"') < text.indexOf('"content":"B"'), text);
  assert.ok(text.indexOf('"content":"B"') < text.indexOf('"finish_reason":"stop"'), text);
});

test("keeps the head event separate when the terminal chunk starts a tool call", async () => {
  const text = await run([
    line({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", type: "function", function: { name: "shell", arguments: "" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }),
    line({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] } }] }),
    "data: [DONE]\n\n",
  ]);
  assertEvents(text);
  assert.ok(text.indexOf('"call_1"') < text.indexOf("command"), text);
  assert.ok(text.indexOf("command") < text.indexOf('"finish_reason":"tool_calls"'), text);
});

test("keeps five parallel calls complete and ordered", async () => {
  const chunks = [
    [0, "call_0"], [1, "call_1"], [2, "call_2"], [3, "call_3"], [4, "call_4"],
  ].map(([index, id]) => call(Number(index), String(id), "subagent", ""));
  const args = [0, 1, 2, 3, 4].map((index) =>
    line({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: `{"n":${index}}` } }] } }] }),
  );
  const text = await run([...chunks, ...args, finish("tool_calls"), "data: [DONE]\n\n"]);
  assertEvents(text);
  for (const index of [0, 1, 2, 3, 4]) {
    assert.ok(text.includes(`\"id\":\"call_${index}\"`), text);
    assert.ok(text.includes(`{\\"n\\":${index}}`), text);
  }
  const finishAt = text.indexOf('"finish_reason":"tool_calls"');
  for (const index of [0, 1, 2, 3, 4]) {
    assert.ok(text.indexOf(`{\\"n\\":${index}}`) < finishAt, text);
  }
});

test("emits a single [DONE] when the gateway sends it twice", async () => {
  const text = await run([
    call(0, "call_1", "shell", ""),
    finish("stop"),
    "data: [DONE]\n\n",
    "data: [DONE]\n\n",
    call(0, "call_1", "shell", '{"command":"ls"}'),
  ]);
  assert.equal(text.split("[DONE]").length - 1, 1, text);
  assert.ok(text.indexOf("command") < text.indexOf('"finish_reason":"stop"'), text);
});

test("is invariant to chunk boundaries", async () => {
  const stream = [
    line({ choices: [{ delta: { reasoning_content: "think" } }] }),
    finish("stop"),
    call(0, "call_1", "shell", ""),
    line({ choices: [{ delta: { content: "héllo 😀" } }] }),
    "data: [DONE]\n\n",
  ].join("");
  const whole = await run([stream]);
  const bytes = new TextEncoder().encode(stream);
  for (let i = 1; i < bytes.length; i++) {
    assert.equal(await run([bytes.slice(0, i), bytes.slice(i)]), whole, `split@${i}`);
  }
  assert.equal(await run([...bytes].map((b) => Uint8Array.of(b))), whole, "byte-by-byte");
});

test("keeps event framing valid", async () => {
  const text = await run([
    line({ choices: [{ delta: { content: "ok" } }] }),
    finish("stop"),
    call(0, "call_1", "shell", '{"command":"ls"}'),
    "data: [DONE]\n\n",
  ]);
  const events = text.replace(/\r\n/g, "\n").split("\n\n").filter(Boolean);
  for (const event of events) {
    if (event === "data: [DONE]") continue;
    assert.ok(event.startsWith("data: "), event);
    assert.doesNotThrow(() => JSON.parse(event.slice(6)), event);
  }
  assert.equal(events.filter((event) => event.includes('"finish_reason":"stop"')).length, 1, text);
});

test("preserves CRLF framing", async () => {
  const stream = [
    line({ choices: [{ delta: { content: "ok" } }] }),
    finish("stop"),
    call(0, "call_1", "shell", '{"command":"ls"}'),
    "data: [DONE]\n\n",
  ].join("").replace(/\n/g, "\r\n");
  const text = await run([stream]);
  assert.ok(text.includes("\r\n\r\n"), text);
  assert.ok(text.indexOf('"call_1"') < text.indexOf('"finish_reason":"stop"'), text);
});

test("stays strict after a length finish", async () => {
  const text = await run([
    line({ choices: [{ delta: { content: "ok" } }] }),
    finish("length"),
    call(0, "call_1", "shell", ""),
    finish("stop"),
    line({ choices: [{ delta: { content: "late" } }] }),
    "data: [DONE]\n\n",
  ]);
  assert.ok(text.indexOf('"finish_reason":"length"') < text.indexOf('"call_1"'), text);
  assert.ok(text.indexOf('"finish_reason":"stop"') < text.indexOf('"content":"late"'), text);
});
