/** Compile-time model tier regressions, checked by the SDK declaration build. */
import "../../v1";

type ChatRequest = Parameters<Window["maypop"]["ai"]["chat"]>[0];
const acceptsChat = (request: ChatRequest) => request;

acceptsChat({ model: "lite", messages: [] });
acceptsChat({ model: "smart", messages: [] });
// Published apps pass the tier's earlier name; dropping it breaks their builds.
acceptsChat({ model: "fast", messages: [] });
// @ts-expect-error A raw provider model is not a tier.
acceptsChat({ model: "gpt-5-mini", messages: [] });

type AgentConfig = Parameters<Window["maypop"]["agent"]["create"]>[0];
const acceptsAgent = (config: AgentConfig) => config;

acceptsAgent({ systemPrompt: "x", model: "lite" });
acceptsAgent({ systemPrompt: "x", model: "smart" });
// Published agent apps pass the tier's earlier name too.
acceptsAgent({ systemPrompt: "x", model: "fast" });
// @ts-expect-error A raw provider model is not a tier.
acceptsAgent({ systemPrompt: "x", model: "gpt-5-mini" });
