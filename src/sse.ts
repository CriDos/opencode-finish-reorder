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
  let heldDone: string | null = null;
  let suppressBlank = false;
  let strict = false;
  let late = false;
  const calls = new Set<number>();
  const callArgs = new Set<number>();

  const emit = (controller: Controller, text: string | null) => {
    if (text !== null && text.length > 0) controller.enqueue(encoder.encode(text));
  };

  const track = (choice: any) => {
    const toolCalls = choice?.delta?.tool_calls;
    if (!Array.isArray(toolCalls)) return;
    for (const call of toolCalls) {
      const index = typeof call?.index === "number" ? call.index : -1;
      if (index < 0) continue;
      const hasName =
        typeof call?.id === "string" &&
        call.id !== "" &&
        typeof call?.function?.name === "string" &&
        call.function.name !== "";
      if (hasName) calls.add(index);
      if (typeof call?.function?.arguments === "string" && call.function.arguments.length > 0) {
        callArgs.add(index);
      }
    }
  };

  const incomplete = () => {
    for (const index of calls) if (!callArgs.has(index)) return true;
    return false;
  };

  const lateData = (choice: any) => {
    const delta = choice?.delta;
    return (
      Boolean(delta?.content) ||
      Boolean(delta?.reasoning_content) ||
      Boolean(delta?.reasoning) ||
      (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0) ||
      (Array.isArray(delta?.reasoning_details) && delta.reasoning_details.length > 0)
    );
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
    if (raw === "[DONE]") {
      if (held !== null && (late || incomplete())) {
        heldDone = line;
        suppressBlank = true;
        return null;
      }
      return release(line);
    }

    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      return line;
    }
    const choice = json?.choices?.[0];
    track(choice);
    if (held !== null && lateData(choice)) late = true;

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
      // The blank after the head must stay: it terminates the head event.
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
      if (heldDone !== null) {
        const eolDone = heldDone.endsWith("\r\n") ? "\r\n" : "\n";
        emit(
          controller,
          heldDone + (heldDone.endsWith("\n") ? eolDone : eolDone + eolDone),
        );
        heldDone = null;
      }
    },
  });
}
