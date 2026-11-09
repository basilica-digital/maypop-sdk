/** Compile-time model tier regressions, checked by the SDK declaration build. */
import "../../v1";

type ChatRequest = Parameters<Window["maypop"]["ai"]["chat"]>[0];
const acceptsChat = (request: ChatRequest) => request;

acceptsChat({ model: "lite", messages: [] });
acceptsChat({ model: "smart", messages: [] });

// @ts-expect-error "fast" is not a chat tier; the lowest-cost tier is "lite".
acceptsChat({ model: "fast", messages: [] });
// @ts-expect-error A raw provider model is not a tier.
acceptsChat({ model: "gpt-5-mini", messages: [] });

type AgentConfig = Parameters<Window["maypop"]["agent"]["create"]>[0];
const acceptsAgent = (config: AgentConfig) => config;

acceptsAgent({ systemPrompt: "x", model: "lite" });
acceptsAgent({ systemPrompt: "x", model: "smart" });

// @ts-expect-error "fast" is not an agent tier; the lowest-cost tier is "lite".
acceptsAgent({ systemPrompt: "x", model: "fast" });
// @ts-expect-error A raw provider model is not a tier.
acceptsAgent({ systemPrompt: "x", model: "gpt-5-mini" });
