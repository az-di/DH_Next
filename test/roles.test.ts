import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRoles, parseNameIntro, resolveName } from "../src/plans/roles.ts";
import type { User } from "../src/types.ts";

const roles = (text: string) => extractRoles(text);

test("role statements in plain language", () => {
  assert.deepEqual(roles("dinner next weekend, Sam is optional"), {
    request: "dinner next weekend",
    statements: [{ names: ["Sam"], role: "optional" }],
  });
  assert.deepEqual(roles("Sam and Priya are required").statements, [{ names: ["Sam", "Priya"], role: "essential" }]);
  assert.deepEqual(roles("Sam, Priya and Theo are optional").statements, [
    { names: ["Sam", "Priya", "Theo"], role: "optional" },
  ]);
  assert.deepEqual(roles("make Theo optional").statements, [{ names: ["Theo"], role: "optional" }]);
  assert.deepEqual(roles("dinner friday optional: Sam, Priya"), {
    request: "dinner friday",
    statements: [{ names: ["Sam", "Priya"], role: "optional" }],
  });
  assert.deepEqual(roles("sam's optional").statements, [{ names: ["sam"], role: "optional" }]);
  assert.deepEqual(roles("Sam P is not required").statements, [{ names: ["Sam P"], role: "optional" }]);
  assert.deepEqual(roles("I'm optional").statements, [{ names: ["I"], role: "optional" }]);
});

test("role statements don't swallow the request", () => {
  assert.deepEqual(roles("dinner Friday Sam is optional"), {
    request: "dinner Friday",
    statements: [{ names: ["Sam"], role: "optional" }],
  });
  assert.deepEqual(roles("dinner at Joe's, Sam is optional").statements, [{ names: ["Sam"], role: "optional" }]);
  assert.deepEqual(roles("lunch tomorrow. Sam and Priya are required"), {
    request: "lunch tomorrow.",
    statements: [{ names: ["Sam", "Priya"], role: "essential" }],
  });
  assert.deepEqual(roles("dinner, attendance is optional"), { request: "dinner, attendance is optional", statements: [] });
  assert.deepEqual(roles("dinner next weekend"), { request: "dinner next weekend", statements: [] });
});

const user = (id: string, name: string | null): User => ({ id, phone: `+1555${id}`, name, timezone: null, createdAt: "" });
const people = [user("1", "Sam Lee"), user("2", "Sam Patel"), user("3", "Priya"), user("4", null)];

test("names match by full name, first name, or first name plus a last-name prefix", () => {
  assert.deepEqual(resolveName("priya", people), { kind: "match", user: people[2] });
  assert.deepEqual(resolveName("Sam Patel", people), { kind: "match", user: people[1] });
  assert.deepEqual(resolveName("Sam P", people), { kind: "match", user: people[1] });
  assert.deepEqual(resolveName("Sam P.", people), { kind: "match", user: people[1] });
  assert.deepEqual(resolveName("sam", people), { kind: "ambiguous", options: [people[0], people[1]] });
  assert.deepEqual(resolveName("Theo", people), { kind: "unknown" });
});

test("people can tell the bot their name", () => {
  assert.equal(parseNameIntro("I'm Sam"), "Sam");
  assert.equal(parseNameIntro("hi! my name is sam patel"), "Sam Patel");
  assert.equal(parseNameIntro("call me Theo."), "Theo");
  assert.equal(parseNameIntro("I'm free saturday"), null);
  assert.equal(parseNameIntro("im down"), null);
  assert.equal(parseNameIntro("I'm optional"), null);
  assert.equal(parseNameIntro("dinner next weekend"), null);
});
