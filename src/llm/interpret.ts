import { parsePreferencesWithRules } from "../plans/preferences.ts";
import { extractRoles } from "../plans/roles.ts";
import type { Interpretation } from "./brain.ts";
import { parseConstraintWithRules, parseRequestWithRules, requestFullyUnderstood } from "./rules.ts";

/**
 * The rule-based reading of an @mention, and whether it's confident enough
 * to skip Claude. Order matters: a standing preference ("no mornings") before
 * a one-off ("not this Saturday"), and role statements are pulled out before
 * the rest is read as a request.
 */
export function interpretWithRules(
  text: string,
  opts: { now: Date; timezone: string },
): { result: Interpretation; confident: boolean } {
  const update = parsePreferencesWithRules(text);
  if (update) return { result: { kind: "preference", update }, confident: true };

  const windows = parseConstraintWithRules(text, opts);
  if (windows) return { result: { kind: "constraint", windows }, confident: true };

  const { request: rest, statements: roles } = extractRoles(text);
  if (roles.length && !rest.replace(/[\s.,!?]/g, "")) return { result: { kind: "roles", roles }, confident: true };

  const request = parseRequestWithRules(rest, opts);
  if (request) return { result: { kind: "request", request, roles }, confident: requestFullyUnderstood(rest) };
  return { result: roles.length ? { kind: "roles", roles } : { kind: "other" }, confident: false };
}
