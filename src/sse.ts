// Some OpenAI-compatible gateways put finish_reason in the middle of the stream
// and keep sending text, reasoning or tool calls afterwards. OpenCode 2.2.5
// tolerates late text and reasoning (#58851) but still fails the whole turn when
// a tool call arrives after finish_reason. Holding the terminal chunk until the
// stream ends makes the stream look normal without changing its content.
const HELD = new Set(["stop", "tool_calls"]);

type Controller = TransformStreamDefaultController<Uint8Array>;

export function createFinishReorder(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let held: string | null = null;
  let suppressBlank = false;
  let strict = false;

  const emit = (controller: Controller, text: string | null) => {
    if (text !== null && text.length > 0) controller.enqueue(encoder.encode(text));
  };

  const release = (line: string): string => {
    if (held === null) return line;
    const sep = held.endsWith("\r\n") ? "\r\n" : "\n";
    const out = held + sep + line;
    held = null;
    return out;
  };

  const terminalLine = (json: any, choice: any, reason: unknown, eol: string): string => {
    const out: any = { index: choice?.index ?? 0, delta: {}, finish_reason: reason };
    if (choice?.native_finish_reason !== undefined) {
      out.native_finish_reason = choice.native_finish_reason;
    }
    return "data: " + JSON.stringify({ ...json, choices: [out] }) + eol;
  };

  const rewrite = (line: string): string | null => {
    const eol = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const body = eol ? line.slice(0, -eol.length) : line;

    if (body.trim() === "") {
      if (suppressBlank) {
        suppressBlank = false;
        return null;
      }
      return line;
    }
    suppressBlank = false;

    const match = /^data:\s?(.*)$/.exec(body);
    if (!match) return line;

    const raw = match[1].trim();
    if (raw === "[DONE]") return release(line);

    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      return line;
    }
    const choice = json?.choices?.[0];

    const reason = choice?.finish_reason;
    if (reason == null || reason === "") return line;

    if (strict || !HELD.has(String(reason))) {
      held = null;
      strict = true;
      return line;
    }

    const payload = choice?.delta ?? choice?.message;
    if (payload && Object.keys(payload).length > 0) {
      // Keep content/tool-call deltas from the terminal chunk ahead of the finish.
      const head = JSON.parse(JSON.stringify(json));
      const headChoice = head.choices?.[0];
      if (headChoice) {
        headChoice.finish_reason = null;
        delete headChoice.native_finish_reason;
      }
      if (head.usage !== undefined) delete head.usage;
      held = terminalLine(json, choice, reason, eol);
      suppressBlank = true;
      return "data: " + JSON.stringify(head) + eol;
    }

    held = terminalLine(json, choice, reason, eol);
    suppressBlank = true;
    return null;
  };

  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      let i = pending.indexOf("\n");
      while (i !== -1) {
        const line = pending.slice(0, i + 1);
        pending = pending.slice(i + 1);
        emit(controller, rewrite(line));
        i = pending.indexOf("\n");
      }
    },
    flush(controller) {
      pending += decoder.decode();
      const tail = pending.length > 0 ? rewrite(pending) : null;
      if (tail !== null && tail.length > 0) {
        emit(controller, tail);
        if (!tail.endsWith("\n")) emit(controller, "\n");
      }
      if (held !== null) {
        const sep = held.endsWith("\r\n") ? "\r\n" : "\n";
        emit(controller, held + sep);
        held = null;
      }
    },
  });
}
