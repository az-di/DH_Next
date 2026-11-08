import type { Plan } from "../types.ts";

// Decides which plan a DM to the bot is about. Someone can be in plans from several
// channels at once, and a DM carries no channel of its own. The rule throughout: act
// when the reply is unambiguous, otherwise ask, because a wrong guess can lock in a
// time or overwrite an answer. Pure, so every case is testable without a network.

/** One plan as seen by the person who sent the DM. */
export interface DmPlan {
  plan: Plan;
  isOrganizer: boolean;
  /** Whether they've already told us their times. */
  answered: boolean;
  /** How many options they can pick from. Zero unless they're the one choosing. */
  optionCount: number;
}

export type AnswerRoute = {
  kind: "answer";
  plan: Plan;
  /** Other plans it could have been for. Set when the bot inferred the plan, so the reply can say how to correct it. */
  others: Plan[];
};
export type PickRoute = { kind: "pick"; plan: Plan; option: number };
export type DmChoice = AnswerRoute | PickRoute;

export type DmRoute =
  | DmChoice
  | { kind: "pick_invalid"; plan: Plan; optionCount: number }
  /** About a plan that no longer takes answers. `others` are plans that still do, in case they meant one of those. */
  | { kind: "closed"; plan: Plan; others: Plan[] }
  | { kind: "ask"; choices: DmChoice[] }
  | { kind: "none" };

const isCollecting = (p: DmPlan) => p.plan.status === "collecting";
const isPicking = (p: DmPlan) => p.plan.status === "organizer_pick" && p.isOrganizer;
const newest = (plans: DmPlan[]) =>
  [...plans].sort((a, b) => a.plan.createdAt.localeCompare(b.plan.createdAt)).at(-1)!;

/** "2", "2.", "#2" or "option 2". Not "2 pm", which is a time. */
export function readNumber(text: string): number | null {
  const match = /^(?:option\s*)?#?(\d+)[.!)]?$/i.exec(text.trim().replace(/^[\s:,\-–—]+/, ""));
  return match ? Number(match[1]) : null;
}

/**
 * Plans whose activity the text names, and the text without those names. Whole words
 * only ("run" isn't in "brunch"), and longest first, so "dinner party" doesn't also
 * count as "dinner".
 */
export function findNamed<T extends DmPlan>(text: string, plans: T[]): { named: T[]; rest: string } {
  const names = [...new Set(plans.map((p) => p.plan.request.activity.trim().toLowerCase()))]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const found = new Set<string>();
  let rest = text.toLowerCase();
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const without = rest.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu"), " ");
    if (without === rest) continue;
    found.add(name);
    rest = without;
  }
  return { named: plans.filter((p) => found.has(p.plan.request.activity.trim().toLowerCase())), rest };
}

/** A number could be an option to pick or, less likely, an answer like "7". Null when it's neither. */
function routeNumber(number: number, scope: DmPlan[]): DmRoute | null {
  const choices: DmChoice[] = [
    ...scope.filter((p) => isPicking(p) && number >= 1 && number <= p.optionCount).map((p) => ({ kind: "pick" as const, plan: p.plan, option: number })),
    ...scope.filter(isCollecting).map((p) => ({ kind: "answer" as const, plan: p.plan, others: [] })),
  ];
  if (choices.length === 1) return choices[0];
  if (choices.length > 1) return { kind: "ask", choices };
  const picking = scope.filter(isPicking);
  if (!picking.length) return null;
  const { plan, optionCount } = newest(picking);
  return { kind: "pick_invalid", plan, optionCount };
}

const answerChoices = (plans: DmPlan[]): DmChoice[] => plans.map((p) => ({ kind: "answer", plan: p.plan, others: [] }));

/** A plain DM: works out the plan from what they said and which plans are waiting on them. */
export function routeDirect(text: string, plans: DmPlan[]): DmRoute {
  const { named, rest } = findNamed(text, plans);
  const scope = named.length ? named : plans;

  const number = readNumber(named.length ? rest : text);
  if (number !== null) {
    const route = routeNumber(number, scope);
    if (route) return route;
  }

  const collecting = scope.filter(isCollecting);
  const picking = scope.filter(isPicking);

  if (named.length) {
    if (collecting.length === 1) return { kind: "answer", plan: collecting[0].plan, others: [] };
    if (collecting.length > 1) return { kind: "ask", choices: answerChoices(collecting) };
    if (picking.length) {
      const { plan, optionCount } = newest(picking);
      return { kind: "pick_invalid", plan, optionCount };
    }
    // They named a plan that's past answers. Never save this to a different plan.
    const stillOpen = named.filter((p) => p.plan.status === "organizer_pick");
    return {
      kind: "closed",
      plan: newest(stillOpen.length ? stillOpen : named).plan,
      others: plans.filter(isCollecting).map((p) => p.plan),
    };
  }

  if (collecting.length === 1) return { kind: "answer", plan: collecting[0].plan, others: [] };
  if (collecting.length > 1) {
    const unanswered = collecting.filter((p) => !p.answered);
    if (unanswered.length !== 1) return { kind: "ask", choices: answerChoices(collecting) };
    const others = collecting.filter((p) => p !== unanswered[0]).map((p) => p.plan);
    return { kind: "answer", plan: unanswered[0].plan, others };
  }
  if (picking.length) {
    const { plan, optionCount } = newest(picking);
    return { kind: "pick_invalid", plan, optionCount };
  }
  const waiting = plans.filter((p) => p.plan.status === "organizer_pick");
  return waiting.length ? { kind: "closed", plan: newest(waiting).plan, others: [] } : { kind: "none" };
}

/** A reply to one of the bot's messages, which says exactly which plan it's about. */
export function routeReply(text: string, target: DmPlan): DmRoute {
  const { plan } = target;
  if (isCollecting(target)) return { kind: "answer", plan, others: [] };
  if (!isPicking(target)) return { kind: "closed", plan, others: [] };
  const number = readNumber(findNamed(text, [target]).rest);
  return number !== null && number >= 1 && number <= target.optionCount
    ? { kind: "pick", plan, option: number }
    : { kind: "pick_invalid", plan, optionCount: target.optionCount };
}
