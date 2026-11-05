import { createFinishReorder } from "./sse.ts";

// Structural types for the OpenCode 2 plugin API. Kept local so the package has
// no runtime or peer dependency on @opencode/plugin and stays loadable by the host.
type HttpResponseDraft = {
  readonly kind: "primary" | "compaction" | "title" | "generate";
  readonly model?: { providerID: string; id: string };
  readonly request: Request;
  response: Response;
};

type PluginContext = {
  session: {
    hook(
      name: "http.response",
      callback: (draft: HttpResponseDraft) => void | Promise<void>,
    ): Promise<unknown>;
  };
};

// Scope to the gateway that inserts finish_reason mid-stream. Add provider ids
// here if another one starts doing the same.
const PROVIDERS = new Set(["blabla"]);

const plugin = {
  id: "opencode-finish-reorder",
  async setup(ctx: PluginContext) {
    await ctx.session.hook("http.response", (draft) => {
      if (!PROVIDERS.has(draft.model?.providerID ?? "")) return;
      const { response } = draft;
      if (!response.body) return;
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("text/event-stream")) return;

      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      headers.delete("transfer-encoding");

      draft.response = new Response(response.body.pipeThrough(createFinishReorder()), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    });
  },
};

export default plugin;
