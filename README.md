# opencode-finish-reorder

Holds a premature `finish_reason` until the end of an OpenAI-compatible SSE stream so OpenCode does not fail the whole turn with `OpenAI Chat received content after the finish reason`.

The bug: some gateways put `finish_reason` in the middle of the stream and keep sending text, reasoning or tool calls. OpenCode 2.2.5 tolerates late text and reasoning, but a tool call after `finish_reason` is fatal. This plugin moves the terminal marker to the end and leaves the content untouched.

## What it does

- Holds only `stop` and `tool_calls`; `length` and `content-filter` stay where they are, so a call the provider marked as truncated never executes.
- If the terminal chunk also carries content or starts a tool call, that payload is emitted first and only the finish marker is held.
- Re-emits the held finish before `[DONE]`, or at the end of the stream when `[DONE]` is missing.
- Does not parse or rewrite tool arguments; the existing bytes pass through in order.

## Install

```bash
git clone <this repo>
cd opencode-finish-reorder
npm install
npm run build
```

Then add the built directory to `~/.config/opencode/opencode.jsonc`, using an absolute path or a `file:///` URL:

```jsonc
{
  "plugins": ["file:///absolute/path/to/opencode-finish-reorder"]
}
```

Do not combine it with another plugin that drops content after the first `finish_reason`; that plugin would remove the late text this one is trying to preserve.

## Check

```bash
npm test
```

22 tests: premature stop before a tool call, normal finish, same-chunk content/tool-init split, `length`/`content-filter` staying in place, flush without `[DONE]`, last finish wins, empty finish ignored, a call that starts before a premature stop and continues after it, byte-boundary invariance, SSE framing, CRLF, strict latch, provider/content-type filters, header cleanup, bodyless and error responses.

Verified against a live gateway that emits `finish_reason: "stop"` before a late `write` tool call: a 3.6 KB argument payload arrived intact and the file was written, while the same turn failed before the plugin.

## Limits

- Only SSE and only the OpenAI Chat shape (`choices[0]`).
- No duplicate-id guard: if a gateway replays a complete tool call after the finish, it may run twice. The observed gateway does not do this.
- CR-only line endings are not split; real gateways use LF or CRLF.
- A stream that ends without `finish_reason` is untouched; the plugin never invents a finish.
- The plugin API is OpenCode 2 only; a major version may rename the hook.
- This is a client-side workaround, not a gateway fix.
