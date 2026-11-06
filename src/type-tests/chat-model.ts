/** Compile-time chat tier regressions, checked by the SDK declaration build. */
import "../../v1";

type ChatRequest = Parameters<Window["maypop"]["ai"]["chat"]>[0];
const accepts = (request: ChatRequest) => request;

accepts({ model: "lite", messages: [] });
accepts({ model: "smart", messages: [] });
// Published apps pass the tier's earlier name; dropping it breaks their builds.
accepts({ model: "fast", messages: [] });

// @ts-expect-error A raw provider model is not a tier.
accepts({ model: "gpt-5-mini", messages: [] });
