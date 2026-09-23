/** Compile-time decisions API regressions, checked by the SDK declaration build. */
import "../../v1";

type DecisionRequest = Parameters<Window["maypop"]["ai"]["decide"]>[0];
type DecisionResponse = Awaited<ReturnType<Window["maypop"]["ai"]["decide"]>>;
const accepts = (request: DecisionRequest) => request;

accepts({
  state: "My checkout page shows a blank screen after I click Pay.",
  questions: {
    is_bug: {
      type: "noul",
      instructions: "Is the customer reporting a software defect?",
      criteria: { true: "describes broken behaviour", false: "asks a question" },
    },
  },
});
accepts({
  state: { customer_tier: "enterprise", ticket: "Blank screen after Pay." },
  session_id: "ticket-42",
  questions: {
    team: {
      type: "choice",
      instructions: "Which team should own this ticket?",
      criteria: { payments: "checkout or billing", frontend: "rendering", account: "login" },
    },
    urgency: {
      type: "score",
      instructions: "How urgent is this ticket?",
      criteria: ["Can wait", "This week", "Blocking revenue now"],
    },
  },
});
accepts({ state: ["a", { b: 1 }], questions: { q: { type: "noul", instructions: { ask: "x" }, criteria: { true: "t", false: "f" } } } });

// @ts-expect-error `questions` is required.
accepts({ state: "x" });
// @ts-expect-error `state` is required.
accepts({ questions: {} });
// @ts-expect-error A score's criteria are an ordered list of levels, not a map.
accepts({ state: "x", questions: { q: { type: "score", instructions: "i", criteria: { low: "l" } } } });
// @ts-expect-error A noul needs both sides.
accepts({ state: "x", questions: { q: { type: "noul", instructions: "i", criteria: { true: "t" } } } });
// @ts-expect-error Unknown question types are rejected.
accepts({ state: "x", questions: { q: { type: "rank", instructions: "i", criteria: ["a"] } } });

const read = (response: DecisionResponse) => {
  const a = response.answers.q;
  if (a.type === "noul") return a.noul > 0.5;
  if (a.type === "choice") return a.probabilities?.[a.choice] ?? a.confidence;
  return a.score + (a.legend?.["0"]?.length ?? 0) + response.usage.cost;
};
void read;
