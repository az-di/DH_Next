import type { MemberRole, User } from "../types.ts";

// Plain-language role changes by name: "Sam is optional", "Sam and Priya are
// required", "make Theo optional", "optional: Sam, Priya". Names are matched
// against the group's users. Neither Photon nor Sendblue gives us contact
// names, so names come from "@planner I'm Sam" (or the mock's seeded users).
// Phone numbers are still handled by extractOptional in the coordinator.

export interface RoleStatement {
  /** As written: "Sam", "Sam P", or "me" for the sender. */
  names: string[];
  role: MemberRole;
}

const ROLE = String.raw`(optional|required|essential|needed|not required|not needed)`;
const toRole = (word: string): MemberRole => (/^(optional|not )/i.test(word) ? "optional" : "essential");

// Words that end a name list when walking back from "is optional": the
// request around it ("dinner next weekend, Sam is optional") and non-people.
const NOT_NAMES = new Set(
  [
    "sunday monday tuesday wednesday thursday friday saturday weekend week tonight today tomorrow",
    "morning afternoon evening night next this sometime at around on for with but so also and the a",
    "breakfast coffee boba tea brunch lunch dinner supper drinks drink beer beers bar movie film hike",
    "hiking game games call zoom facetime hang hangout plan",
    "everyone everybody anyone it that attendance rsvp",
  ]
    .join(" ")
    .split(" "),
);

const SELF = /^(i|me|myself)$/i;

/** Pulls role statements out of a message. `request` is what's left for the request parser. */
export function extractRoles(text: string): { request: string; statements: RoleStatement[] } {
  const statements: RoleStatement[] = [];
  const cuts: [number, number][] = [];

  // "optional: Sam, Priya" up to the end of the sentence.
  for (const m of text.matchAll(/\b(optional|required)\s*:\s*([^.;!?]+)/gi)) {
    const names = splitNames(m[2]);
    if (names) {
      statements.push({ names, role: toRole(m[1]) });
      cuts.push([m.index, m.index + m[0].length]);
    }
  }
  // "make Sam and Priya optional"
  for (const m of text.matchAll(new RegExp(String.raw`\bmake\s+([^.;!?]+?)\s+${ROLE}\b`, "gi"))) {
    const names = splitNames(m[1]);
    if (names && !overlapsAny(cuts, m.index)) {
      statements.push({ names, role: toRole(m[2]) });
      cuts.push([m.index, m.index + m[0].length]);
    }
  }
  // "Sam is optional", "Sam's optional", "Sam P and Priya are required", "I'm optional"
  for (const m of text.matchAll(new RegExp(String.raw`(?:\s+(?:is|are|am)|['’](?:s|re|m))\s+${ROLE}\b`, "gi"))) {
    if (overlapsAny(cuts, m.index)) continue;
    const found = namesBefore(text, m.index);
    if (found) {
      statements.push({ names: found.names, role: toRole(m[1]) });
      cuts.push([found.start, m.index + m[0].length]);
    }
  }

  let request = text;
  for (const [start, end] of cuts.sort((a, b) => b[0] - a[0])) request = request.slice(0, start) + request.slice(end);
  request = request.replace(/\s*[,;]\s*([.!?]|$)/g, "$1").replace(/\s{2,}/g, " ").replace(/^[\s,.;]+|[\s,;]+$/g, "");
  return { request, statements };
}

function overlapsAny(cuts: [number, number][], index: number) {
  return cuts.some(([start, end]) => index >= start && index < end);
}

const isNameWord = (word: string) => /^[\p{L}][\p{L}'.-]*$/u.test(word) && !NOT_NAMES.has(word.toLowerCase());

/** "Sam, Priya and Theo" → names, or null if any item doesn't look like a name. */
function splitNames(list: string): string[] | null {
  const items = list.split(/\s*(?:,\s*(?:and\s+)?|\s+and\s+|&)\s*/i).map((s) => s.trim()).filter(Boolean);
  const ok = items.length > 0 && items.every((item) => {
    const words = item.split(/\s+/);
    return words.length <= 2 && (SELF.test(item) || words.every(isNameWord));
  });
  return ok ? items : null;
}

/**
 * Walks back from `end` collecting a name list ("Sam Patel, Priya and Theo"),
 * stopping at sentence punctuation or a word that isn't a name.
 */
function namesBefore(text: string, end: number): { names: string[]; start: number } | null {
  // An initial keeps its dot ("Sam P."); any other punctuation is its own token and ends the list.
  const tokens = [...text.slice(0, end).matchAll(/\p{L}\.(?!\p{L})|[\p{L}][\p{L}'-]*|[,&]|[^\s\p{L},&]/gu)];
  const names: string[] = [];
  let start = end;
  let current: { words: string[]; start: number } | null = null;
  // A comma only continues the list once an "and" was seen ("Sam, Priya and Theo"),
  // so "dinner at Joe's, Sam is optional" stops at the comma.
  let sawAnd = false;
  const close = () => {
    if (current) names.unshift(current.words.join(" "));
    current = null;
  };

  for (let i = tokens.length - 1; i >= 0; i--) {
    const tok = tokens[i][0];
    const isAnd = tok === "&" || tok.toLowerCase() === "and";
    if (isAnd || tok === ",") {
      if (!current) break; // two separators in a row
      close();
      if (tok === "," && !sawAnd) break;
      sawAnd ||= isAnd;
      continue;
    }
    const nameLike = SELF.test(tok) || isNameWord(tok);
    if (!nameLike || (current && current.words.length === 2) || (current && SELF.test(tok))) break;
    current ??= { words: [], start: 0 };
    current.words.unshift(tok);
    current.start = tokens[i].index;
    start = current.start;
  }
  close();
  return names.length ? { names, start } : null;
}

export type NameMatch = { kind: "match"; user: User } | { kind: "ambiguous"; options: User[] } | { kind: "unknown" };

const norm = (s: string) => s.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();

/**
 * Matches a name as written against people's known names: an exact full name
 * first, then first name (plus an optional last-name prefix, "Sam P").
 */
export function resolveName(name: string, people: User[]): NameMatch {
  const wanted = norm(name);
  const named = people.filter((u): u is User & { name: string } => Boolean(u.name));
  const pick = (found: User[]): NameMatch | null =>
    found.length === 1 ? { kind: "match", user: found[0] } : found.length > 1 ? { kind: "ambiguous", options: found } : null;

  const exact = pick(named.filter((u) => norm(u.name) === wanted));
  if (exact) return exact;
  const [first, last] = wanted.split(" ");
  const partial = named.filter((u) => {
    const [f, ...rest] = norm(u.name).split(" ");
    return f === first && (last === undefined || rest.join(" ").startsWith(last));
  });
  return pick(partial) ?? { kind: "unknown" };
}

// Things people say after "I'm" that aren't names.
const NOT_INTRO = new Set(
  "free busy out in down good fine here back not sick late available optional required essential needed so ok okay sure going coming just still also the a in".split(" "),
);

/** "I'm Sam", "my name is Sam Patel", "call me Sam" → "Sam", else null. */
export function parseNameIntro(text: string): string | null {
  const m = /^(?:(?:hi|hey|hello)[,!]?\s+)?(?:i['’]?m|i am|my name is|call me|this is|it['’]s)\s+([\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'.-]*)?)\s*[.!]?$/iu.exec(
    text.trim(),
  );
  if (!m || m[1].split(/\s+/).some((w) => NOT_INTRO.has(w.toLowerCase()))) return null;
  return m[1]
    .split(/\s+/)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

export function isSelf(name: string) {
  return SELF.test(name.trim());
}
