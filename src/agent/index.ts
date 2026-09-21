/**
 * maypop.agent — the in-app conversational agent runtime.
 *
 * Bundles the `pi` agent loop (multi-turn tool calling, streaming, context
 * management) and drives the model through the app's existing `/app-api/ai`
 * proxy via pi-ai's openai-completions provider — the same provider, and the
 * same OpenRouter-backed endpoint, the studio uses. Apps supply a system
 * prompt and a set of read/write tools; the loop handles streaming markdown,
 * tool dispatch, and context compaction so every app's agent behaves the same.
 *
 * This module is loaded lazily by the core SDK (window.maypop.agent.create
 * dynamically imports it), so apps that never use an agent never download pi.
 *
 * The public surface below intentionally references only its own types — no
 * pi-* types appear in exported signatures — so the generated agent-v1.d.ts is
 * self-contained for app authors who don't have pi installed.
 */
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Model,
  TextContent,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import {
  convertMessages,
  streamSimple as streamSimpleOpenAICompletions,
} from "@earendil-works/pi-ai/api/openai-completions";

// ----------------------------------------------------------------- public API

/** Model tier — resolved to a concrete model server-side. */
export type AgentTier = "fast" | "smart";

/** Result an app tool may return — a bare string, or text plus structured
 *  details for the app's own UI/logging (not shown to the model). */
export interface AgentToolResult {
  text: string;
  details?: unknown;
  /** End the turn immediately after this tool instead of letting the model take
   *  another turn. Set it on a tool that hands off to the user — an interactive
   *  card, a final confirmation — so the loop doesn't tack on an empty trailing
   *  turn (which would render as a blank bubble and leave the indicator
   *  spinning). Leave it unset for ordinary read/write tools the model should
   *  keep reasoning from. */
  terminate?: boolean;
}

/**
 * One capability the agent can call. `parameters` is a JSON Schema object
 * describing the arguments; `execute` runs inside the app iframe, so it can
 * read and write app state (e.g. via maypop.kv) to actually do the work.
 */
export interface AgentToolDef {
  /** Tool name the model calls (snake_case, stable). */
  name: string;
  /** Short human-readable label for this tool's activity, shown by the app
   *  while the call runs (e.g. "Reading the board"). Surfaced on each tool call
   *  in the message view; when omitted, the SDK falls back to a humanized
   *  `name` so the app always has something non-empty to render. */
  label?: string;
  /** What it does and when to use it — written for the model. */
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  /** Run the call. Return text (and optional details) for the model. Throw to
   *  signal failure — the loop surfaces it to the model as an error result. */
  execute: (
    params: Record<string, unknown>,
  ) => Promise<string | AgentToolResult> | string | AgentToolResult;
}

/**
 * An image to show the model alongside a message:
 * - a `Blob`/`File` (a camera or file input's file, a canvas blob),
 * - a base64 `data:` URL (`FileReader.readAsDataURL`, `canvas.toDataURL`), or
 * - a fetchable URL — a drive file via `await maypop.drive.url(cid)` or a
 *   just-generated `ai.image` URL. The SDK fetches the bytes, so a third-party
 *   host must allow CORS; prefer drive/data URLs.
 */
export type AgentImageInput = Blob | string;

/** Options for {@link MaypopAgentSession.send}. */
export interface AgentSendOptions {
  /** Images for the model to look at with this message (it has vision — pass
   *  the image itself; never describe or transcribe an image into text as a
   *  workaround). Keep them user-initiated and few: images are large, and they
   *  persist in the stored transcript. */
  images?: AgentImageInput[];
}

/** A starter suggestion shown before/with the conversation. */
export interface AgentChip {
  /** Short tappable label. */
  label: string;
  /** The prompt sent when the chip is tapped. */
  prompt: string;
}

/** Configuration for {@link MaypopAgent.create}. */
export interface CreateAgentConfig {
  /** The agent's instructions. */
  systemPrompt: string;
  /** Tier to run on. Defaults to `"smart"`. */
  model?: AgentTier;
  /** Tools the agent may call. */
  tools?: AgentToolDef[];
  /** Starter prompt chips. Plain strings become `{ label, prompt }`. */
  chips?: (string | AgentChip)[];
  /** Reasoning level. Defaults to `"off"`. */
  thinkingLevel?: "off" | "low" | "medium" | "high";
  /** Resume and persist this conversation by id. When set, the session loads
   *  any stored transcript on creation (await {@link MaypopAgentSession.ready})
   *  and saves after each turn, so it survives reloads and is listed by
   *  {@link MaypopAgentConversations}. Omit for an ephemeral chat that is never
   *  stored. Use a stable, unique id per conversation (e.g. crypto.randomUUID). */
  conversationId?: string;
}

/** Summary of one stored conversation, from {@link MaypopAgentConversations.list}. */
export interface AgentConversationSummary {
  /** The conversation id (as passed to {@link CreateAgentConfig.conversationId}). */
  id: string;
  /** Title derived from the first user message. */
  title: string;
  /** ISO timestamp of the last turn, or null if never saved a turn. */
  updatedAt: string | null;
  /** Number of visible messages in the transcript. */
  messageCount: number;
}

/** A stored conversation's full transcript, from {@link MaypopAgentConversations.get}. */
export interface AgentConversation {
  id: string;
  title: string;
  updatedAt: string | null;
  /** The transcript in the same view shape as {@link MaypopAgentSession.getMessages}. */
  messages: AgentMessageView[];
}

/** Manage stored chat history for the current viewer. Reachable as
 *  `maypop.agent.conversations` without loading the agent runtime. */
export interface MaypopAgentConversations {
  /** List the current viewer's stored conversations, newest first. */
  list(): Promise<AgentConversationSummary[]>;
  /** Read one stored conversation's transcript, or null if it doesn't exist. */
  get(id: string): Promise<AgentConversation | null>;
  /** Delete a stored conversation. */
  delete(id: string): Promise<void>;
}

/** A view of one transcript message, decoupled from pi internals. Messages stay
 *  in Pi's chronological order. To match Maypop Studio, group messages between
 *  user turns and render leading assistant text, then consolidated tool
 *  activity, then the final assistant response. `tool` messages are completion
 *  metadata for `toolCalls[].done`, not chat bubbles. */
export interface AgentMessageView {
  role: "user" | "assistant" | "tool";
  /** Concatenated text content. For assistant messages this is markdown — parse
   *  it incrementally while `streaming` is true. */
  text: string;
  /** Tool calls the assistant requested in this message, if any. Each carries a
   *  `label` (the tool's own `label`, or a humanized `name`) so the app can show
   *  a non-empty "doing X" affordance without maintaining its own name→label
   *  map, and `done` — true once the call's result is in — so the app can flip
   *  that affordance from a spinner to a completed state instead of leaving it
   *  loading forever. */
  toolCalls?: { name: string; arguments: unknown; label: string; done: boolean }[];
  /** Images attached to this message (base64 `data:` URLs, ready for an
   *  `<img src>`), if any. Render them with the user's bubble. */
  images?: string[];
  /** True while this message is still being streamed. */
  streaming?: boolean;
}

/** A live agent conversation. Re-read {@link getMessages} on every change. */
export interface MaypopAgentSession {
  /** Send a user message (starts or continues the conversation). Pass
   *  `{ images }` to let the model look at pictures — see
   *  {@link AgentSendOptions}. */
  send(text: string, options?: AgentSendOptions): void;
  /** Abort the in-flight turn, if any. */
  abort(): void;
  /** The full chronological transcript, including the in-flight streaming
   *  message. Preserve its per-turn leading text → tools → final response
   *  presentation order; do not hoist tool activity above the turn. */
  getMessages(): AgentMessageView[];
  /** True while a turn is streaming. */
  readonly streaming: boolean;
  /** The id this session persists under, or null when ephemeral. */
  readonly conversationId: string | null;
  /** Resolves once a resumed conversation's stored messages are loaded. For a
   *  fresh or ephemeral session it resolves immediately. */
  ready(): Promise<void>;
  /** The configured starter chips (normalized). */
  readonly chips: AgentChip[];
  /** Subscribe to "something changed" — re-read getMessages()/streaming. */
  subscribe(onChange: () => void): () => void;
}

/** The `maypop.agent` namespace. */
export interface MaypopAgent {
  create(config: CreateAgentConfig): MaypopAgentSession;
  /** Stored chat history for the current viewer. */
  conversations: MaypopAgentConversations;
}

/**
 * Host hooks the core SDK passes in (it owns the session token + context). Not
 * called by apps directly.
 * @internal
 */
export interface AgentHost {
  /** Backend origin, e.g. `https://api.maypop.ai`. */
  apiBase: string;
  /** Current app session token (rotates), or null if revoked. */
  getToken: () => string | null;
  /** Scope check, e.g. `can("ai:use")`. */
  can: (scope: string) => boolean;
  /**
   * Chat-history persistence (optional). The core SDK backs these with its
   * per-viewer kv store; the session calls them when a `conversationId` is set.
   * `loadConversation` returns the stored raw pi messages to seed (or null);
   * `saveConversation` stores the turn after each `agent_end`. `view` is the
   * public transcript so the history list/read API can render without pi.
   */
  loadConversation?: (id: string) => Promise<unknown[] | null>;
  saveConversation?: (
    id: string,
    record: { title: string; messages: unknown[]; view: AgentMessageView[] },
  ) => Promise<void>;
}

// ------------------------------------------------------------------ internals

// Per-tier cost metadata (USD per 1M tokens). Only used for pi's usage
// accounting; mirrors the studio's proxy catalog.
const TIER_COST: Record<AgentTier, Model<"openai-completions">["cost"]> = {
  smart: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  fast: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/**
 * Build the synthetic pi model. `id` is the tier name the backend resolves
 * (not a raw provider model); `baseUrl` is the app AI gateway — the OpenAI SDK
 * appends `/chat/completions`, so we omit that suffix. `cache_control` markers
 * (compat: anthropic) are forwarded verbatim to OpenRouter for cache reads.
 */
function buildModel(tier: AgentTier, apiBase: string): Model<"openai-completions"> {
  return {
    id: tier,
    name: tier,
    api: "openai-completions",
    provider: "maypop",
    baseUrl: `${apiBase}/app-api/ai`,
    reasoning: true,
    input: ["text", "image"],
    cost: TIER_COST[tier],
    contextWindow: 200000,
    maxTokens: 64000,
    compat: { cacheControlFormat: "anthropic" },
  };
}

// ----------------------------------------------------------- stream functions

/**
 * Live stream function: a real app session, so call the AI gateway directly
 * through pi-ai's openai-completions provider, injecting the rotating app
 * token as the bearer key per call.
 */
function makeLiveStreamFn(host: AgentHost) {
  return (
    model: Model<string>,
    context: Context,
    options: { apiKey?: string } | undefined,
  ) =>
    streamSimpleOpenAICompletions(model as Model<"openai-completions">, context, {
      ...(options ?? {}),
      apiKey: host.getToken() ?? undefined,
    });
}

// ------------------------------------------------------------- image input

/** Read a Blob into pi image content (base64 bytes + mime type). */
function blobToImageContent(blob: Blob): Promise<ImageContent> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const comma = dataUrl.indexOf(",");
      // A typeless blob (some fetches, canvas edge cases) still yields a
      // parseable data URL header, e.g. "data:application/octet-stream;base64".
      const mimeType =
        blob.type || dataUrl.slice(5, dataUrl.indexOf(";")) || "image/png";
      resolve({ type: "image", data: dataUrl.slice(comma + 1), mimeType });
    };
    reader.onerror = () => reject(reader.error ?? new Error("could not read image"));
    reader.readAsDataURL(blob);
  });
}

/** Normalize one {@link AgentImageInput} into pi image content. `fetch`
 *  handles `data:` URLs natively, so every string input goes through it. */
async function toImageContent(input: AgentImageInput): Promise<ImageContent> {
  if (typeof input !== "string") return blobToImageContent(input);
  const res = await fetch(input);
  if (!res.ok) {
    throw new Error(`maypop.agent: could not fetch image (${res.status})`);
  }
  return blobToImageContent(await res.blob());
}

/** Build a multimodal user-message content array: the text (when non-empty)
 *  followed by the encoded images. */
async function buildUserContent(
  text: string,
  images: AgentImageInput[],
): Promise<(TextContent | ImageContent)[]> {
  const content: (TextContent | ImageContent)[] = [];
  if (text) content.push({ type: "text", text });
  for (const image of images) content.push(await toImageContent(image));
  return content;
}

/** Turn a snake_case or camelCase tool name into a human-readable label, as a
 *  fallback when a tool didn't supply its own: `read_board` → "Read board". */
function humanizeToolName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return name;
  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
  return words.join(" ");
}

/** Adapt an app tool definition to a pi AgentTool. */
function adaptTool(def: AgentToolDef): AgentTool {
  return {
    name: def.name,
    label: def.label ?? humanizeToolName(def.name),
    description: def.description,
    parameters: def.parameters,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const result = await def.execute(params ?? {});
      const text = typeof result === "string" ? result : result.text;
      const details =
        typeof result === "string" ? {} : (result.details ?? {});
      // A tool can end the loop (e.g. a handoff/interactive card) by returning
      // terminate:true — pi reads it off the tool result and stops instead of
      // taking another, empty turn. Only forward it when set.
      const terminate = typeof result === "string" ? false : result.terminate === true;
      return {
        content: [{ type: "text", text }],
        details,
        ...(terminate ? { terminate: true } : {}),
      };
    },
    // pi's openai-completions provider passes `parameters` straight through as
    // the tool input_schema and does not run typebox validation, so a plain
    // JSON Schema object is accepted despite the AgentTool typing.
  } as unknown as AgentTool;
}

// Rough token estimate (~4 chars/token) over a transcript — good enough to
// decide when to start trimming. TODO: swap for pi's estimateContextTokens if
// it becomes a top-level export.
function estimateTokens(messages: AgentMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += JSON.stringify((m as { content?: unknown }).content ?? "").length;
  }
  return Math.ceil(chars / 4);
}

// Once the transcript would blow past the cache window, drop the bulky content
// of OLD tool-result messages (keeping the most recent third verbatim). Tool
// outputs are the heaviest and least useful once the model has moved on; the
// assistant/user turns that give the conversation its shape stay intact.
const CONTEXT_BUDGET_TOKENS = 150_000;

function makeTransformContext() {
  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    if (estimateTokens(messages) <= CONTEXT_BUDGET_TOKENS) return messages;
    const keepFrom = Math.floor((messages.length * 2) / 3);
    return messages.map((m, i) => {
      if (i >= keepFrom) return m;
      if ((m as { role?: string }).role === "tool") {
        return {
          ...m,
          content: [
            { type: "text", text: "[earlier tool result trimmed to fit context]" },
          ],
        } as AgentMessage;
      }
      return m;
    });
  };
}

function normalizeChips(chips: CreateAgentConfig["chips"]): AgentChip[] {
  if (!chips) return [];
  return chips.map((c) =>
    typeof c === "string"
      ? { label: c.length > 48 ? `${c.slice(0, 47)}…` : c, prompt: c }
      : c,
  );
}

/** Project a pi AgentMessage into the public view. `labelFor` resolves a tool's
 *  display label (the tool's own `label`, or a humanized name); a call is `done`
 *  once its id appears in `completedToolCallIds`. */
function toView(
  message: AgentMessage,
  streaming: boolean,
  labelFor: (name: string) => string,
  completedToolCallIds: Set<string>,
): AgentMessageView {
  const role = (message as { role?: string }).role;
  const rawContent = (message as { content?: unknown }).content;
  let text = "";
  const images: string[] = [];
  const toolCalls: {
    name: string;
    arguments: unknown;
    label: string;
    done: boolean;
  }[] = [];

  if (typeof rawContent === "string") {
    text = rawContent;
  } else if (Array.isArray(rawContent)) {
    for (const part of rawContent) {
      const p = part as {
        type?: string;
        text?: string;
        name?: string;
        arguments?: unknown;
        id?: string;
        data?: string;
        mimeType?: string;
      };
      if (p.type === "text" && typeof p.text === "string") text += p.text;
      else if (p.type === "image" && typeof p.data === "string") {
        images.push(`data:${p.mimeType ?? "image/png"};base64,${p.data}`);
      } else if (p.type === "toolCall" || p.type === "tool_call") {
        const name = p.name ?? "";
        toolCalls.push({
          name,
          arguments: p.arguments,
          label: labelFor(name),
          done: typeof p.id === "string" && completedToolCallIds.has(p.id),
        });
      }
    }
  }

  // pi tags tool results with role "toolResult" (not "tool"); fold it into the
  // public "tool" role so apps can hide it. Mislabeling it "user" — the old
  // fall-through — painted raw tool-result dumps into the transcript as if the
  // user had typed them (the agent guide tells apps to render only user +
  // assistant turns, which only works if the role is honest).
  const view: AgentMessageView = {
    role:
      role === "assistant"
        ? "assistant"
        : role === "tool" || role === "toolResult"
          ? "tool"
          : "user",
    text,
  };
  if (toolCalls.length > 0) view.toolCalls = toolCalls;
  if (images.length > 0) view.images = images;
  if (streaming) view.streaming = true;
  return view;
}

// --------------------------------------------------------------------- session

class AgentSessionImpl implements MaypopAgentSession {
  readonly chips: AgentChip[];
  private readonly agent: Agent;
  private readonly listeners = new Set<() => void>();
  // The app-facing `streaming` flag, tracked from explicit agent_start/agent_end
  // events rather than read live off agent.state.isStreaming. See the subscribe()
  // wiring in the constructor for why the latter latches stale-true.
  private turnActive = false;
  // tool name -> display label, resolved once from the configured tools so the
  // message view can hand the app a non-empty label for every tool call.
  private readonly toolLabels: Map<string, string>;
  readonly conversationId: string | null;
  private readonly host: AgentHost;
  // Resolves once a resumed conversation's stored messages are seeded; immediate
  // for a fresh/ephemeral session.
  private readonly loadedPromise: Promise<void>;

  constructor(config: CreateAgentConfig, host: AgentHost) {
    this.chips = normalizeChips(config.chips);
    this.host = host;
    this.conversationId = config.conversationId ?? null;
    this.toolLabels = new Map(
      (config.tools ?? []).map((t) => [t.name, t.label ?? humanizeToolName(t.name)]),
    );
    const model = buildModel(config.model ?? "smart", host.apiBase);

    // The session calls the AI gateway directly with the app's own session
    // token (the provider registry is stubbed out of the bundle).
    const streamFn = makeLiveStreamFn(host);

    this.agent = new Agent({
      initialState: {
        systemPrompt: config.systemPrompt,
        model: model as Model<string>,
        thinkingLevel: config.thinkingLevel ?? "off",
        tools: (config.tools ?? []).map(adaptTool),
        messages: [],
      },
      getApiKey: () => host.getToken() ?? undefined,
      toolExecution: "sequential",
      transformContext: makeTransformContext(),
      streamFn: streamFn as Agent["streamFunction"],
    });

    // Drive the public `streaming` flag from explicit turn-lifecycle events, not
    // from agent.state.isStreaming. pi clears isStreaming inside finishRun() AFTER
    // it emits agent_end, with no further change notification — so an app that
    // reads `session.streaming` from inside its onChange handler latches the
    // stale `true` it saw on the agent_end notification, and its "thinking"
    // indicator spins forever. agent_start/agent_end are the honest signal.
    this.agent.subscribe((event) => {
      const type = (event as { type?: string }).type;
      if (type === "agent_start") this.turnActive = true;
      else if (type === "agent_end") {
        this.turnActive = false;
        this.persist();
      }
      this.emit();
    });

    // Resume a stored conversation: seed the agent's transcript before the
    // first turn. Only when nothing has been added yet, so a racing send()
    // doesn't get clobbered. Capture locals so the async closure doesn't read
    // possibly-unassigned `this` fields.
    const id = this.conversationId;
    const agent = this.agent;
    const emit = () => this.emit();
    this.loadedPromise =
      id && host.loadConversation
        ? (async () => {
            try {
              const messages = await host.loadConversation!(id);
              if (
                Array.isArray(messages) &&
                messages.length > 0 &&
                agent.state.messages.length === 0
              ) {
                agent.state.messages = messages as AgentMessage[];
                emit();
              }
            } catch (error) {
              console.error("maypop.agent: failed to load conversation", error);
            }
          })()
        : Promise.resolve();
  }

  ready(): Promise<void> {
    return this.loadedPromise;
  }

  // Persist the conversation after a turn ends. No-op for an ephemeral session
  // (no conversationId) or a host without a store. Stores the raw pi messages
  // (to resume) plus the public view (so the history API can render without pi).
  private persist(): void {
    const id = this.conversationId;
    if (!id || !this.host.saveConversation) return;
    const view = this.getMessages();
    const firstUser = view.find((m) => m.role === "user");
    const title = (firstUser?.text ?? "").trim().slice(0, 80) || "New chat";
    const messages = this.agent.state.messages as unknown[];
    void this.host
      .saveConversation(id, { title, messages, view })
      .catch((error) => {
        console.error("maypop.agent: failed to save conversation", error);
      });
  }

  send(text: string, options?: AgentSendOptions): void {
    const images = options?.images ?? [];
    if (!this.agent.state.isStreaming) {
      // Reflect the new turn immediately so the UI shows activity before the
      // first agent_start arrives (image encoding adds an async hop before the
      // prompt call); agent_end (or the failure path below) clears it.
      this.turnActive = true;
      this.emit();
    }
    void (async () => {
      const message = {
        role: "user",
        // Plain text stays a bare string so stored transcripts keep their
        // pre-image shape; images promote the content to a multimodal array.
        content:
          images.length === 0 ? text : await buildUserContent(text, images),
        timestamp: Date.now(),
      } as AgentMessage;
      // Re-checked after the (possibly async) build: a turn that started in
      // the meantime takes the message as steering input instead.
      if (this.agent.state.isStreaming) {
        this.agent.steer(message);
        return;
      }
      await this.agent.prompt(message);
    })().catch((error) => {
      console.error("maypop.agent: prompt failed", error);
      // A prompt (or image read) that throws before the loop emits agent_end
      // would otherwise leave the turn stuck active — clear it ourselves.
      this.turnActive = false;
      this.emit();
    });
  }

  abort(): void {
    this.agent.abort();
    // pi emits agent_end on a clean abort, but clear eagerly in case teardown
    // races ahead of that event.
    this.turnActive = false;
    this.emit();
  }

  get streaming(): boolean {
    return this.turnActive;
  }

  getMessages(): AgentMessageView[] {
    const state = this.agent.state;
    const labelFor = (name: string) => this.labelFor(name);
    // A tool call is done once its result message has arrived. Collect those ids
    // so each call view reports done vs still-running, and the app can flip its
    // "doing X…" spinner to a completed state instead of looping forever.
    const completedToolCallIds = new Set<string>();
    for (const m of state.messages) {
      const mm = m as { role?: string; toolCallId?: unknown };
      if (mm.role === "toolResult" && typeof mm.toolCallId === "string") {
        completedToolCallIds.add(mm.toolCallId);
      }
    }
    const views = state.messages.map((m) =>
      toView(m, false, labelFor, completedToolCallIds),
    );
    if (
      state.isStreaming &&
      state.streamingMessage &&
      state.messages[state.messages.length - 1] !== state.streamingMessage
    ) {
      views.push(toView(state.streamingMessage, true, labelFor, completedToolCallIds));
    }
    // Drop truly-empty assistant turns: no text and no tool calls. pi emits one
    // as a dead trailing turn (and momentarily at the start of a stream); it
    // carries nothing and would render as a blank bubble. Tool-call-only turns
    // (empty text but with toolCalls) are kept so the app can show the activity.
    return views.filter(
      (v) =>
        v.role !== "assistant" ||
        v.text.trim().length > 0 ||
        (v.toolCalls?.length ?? 0) > 0,
    );
  }

  private labelFor(name: string): string {
    return this.toolLabels.get(name) ?? humanizeToolName(name);
  }

  subscribe(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => {
      this.listeners.delete(onChange);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/**
 * Create an agent session. Called by the core SDK's `maypop.agent.create`
 * facade (which supplies the host hooks).
 * @internal
 */
export function createAgentSession(
  config: CreateAgentConfig,
  host: AgentHost,
): MaypopAgentSession {
  if (!host.can("ai:use")) {
    throw new Error("maypop/forbidden: missing scope for ai:use");
  }
  return new AgentSessionImpl(config, host);
}
