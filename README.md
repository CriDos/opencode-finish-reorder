# opencode-finish-reorder

Holds a premature `finish_reason` until the end of an OpenAI-compatible SSE stream so OpenCode does not fail the whole turn with `OpenAI Chat received content after the finish reason`.

The bug: some gateways put `finish_reason` in the middle of the stream and keep sending text, reasoning or tool calls. OpenCode 2.2.5 tolerates late text and reasoning, but a tool call after `finish_reason` is fatal. This plugin moves the terminal marker to the end and leaves the content untouched.

## What it does

- Holds only `stop` and `tool_calls`; `length` and `content-filter` stay where they are, so a call the provider marked as truncated never executes.
- If the terminal chunk also carries content or starts a tool call, that payload is emitted first and only the finish marker is held.
- Re-emits the held finish before `[DONE]`, or at the end of the stream when `[DONE]` is missing.
- If `[DONE]` arrives while a finish is held and the stream still has late data or an open tool call, the sentinel is held until the transport closes: bytes after it are emitted before the finish instead of being ignored. A complete finish is emitted at `[DONE]` as usual, so a healthy stream is not delayed.
- Does not parse or rewrite tool arguments; the existing bytes pass through in order.

## Install

```bash
git clone https://github.com/CriDos/opencode-finish-reorder
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

Restart OpenCode after building: plugins are loaded at startup, a rebuilt `dist` is not picked up by a running service.

Do not combine it with another plugin that drops content after the first `finish_reason`; that plugin would remove the late text this one is trying to preserve.

## Check

```bash
npm test
```

28 tests: premature stop before a tool call, normal finish, same-chunk content/tool-init split with valid SSE framing, `length`/`content-filter` staying in place, flush without `[DONE]`, last finish wins, empty finish ignored, a call that starts before a premature stop and continues after it, arguments after `[DONE]`, five parallel calls, duplicate `[DONE]`, a complete finish that is not held, byte-boundary invariance, CRLF, strict latch, provider/content-type filters, header cleanup, bodyless and error responses.

Verified against a live gateway that emits `finish_reason: "stop"` before a late `write` tool call: a 3.6 KB argument payload arrived intact and the file was written, while the same turn failed before the plugin.

## Limits

- Only SSE and only the OpenAI Chat shape (`choices[0]`).
- No duplicate-id guard: a replayed complete tool call is not deduped. OpenCode 2.2.5 rejects duplicate tool starts and fails the turn rather than running the call twice, but do not rely on that on other versions.
- A tool call that arrives with no arguments at all is passed through unchanged; the plugin cannot invent missing arguments.
- A non-held finish (`length`, `content-filter`, unknown) followed by a tool call still fails the turn. That is deliberate: a call the provider marked as truncated must not execute.
- If a gateway keeps the connection open after `[DONE]` on an incomplete stream, the turn waits for the transport timeout. The observed gateway closes promptly.
- CR-only line endings are not split; real gateways use LF or CRLF.
- A stream that ends without `finish_reason` is untouched; the plugin never invents a finish.
- The plugin API is OpenCode 2 only; a major version may rename the hook.
- This is a client-side workaround, not a gateway fix.
