import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInbound } from "../src/messaging/inbound.ts";
import { isMentioned, stripMention } from "../src/messaging/mentions.ts";
import { parseVotes } from "../src/messaging/votes.ts";

const text = (t: string) => parseVotes({ text: t, reaction: null });

test("mention detection", () => {
  assert.ok(isMentioned("@planner dinner next weekend", "planner"));
  assert.ok(isMentioned("hey @Planner, drinks friday?", "planner"));
  assert.ok(!isMentioned("email planner@example.com", "planner"));
  assert.ok(!isMentioned("@plannerbot hi", "planner"));
  assert.equal(stripMention("@planner, dinner next weekend", "planner"), "dinner next weekend");
});

test("plain yes/no/maybe", () => {
  assert.deepEqual(text("yes"), [{ vote: "yes", optionNumber: null }]);
  assert.deepEqual(text("Nope!"), [{ vote: "no", optionNumber: null }]);
  assert.deepEqual(text("maybe"), [{ vote: "maybe", optionNumber: null }]);
  assert.deepEqual(text("👍"), [{ vote: "yes", optionNumber: null }]);
});

test("numbered replies", () => {
  assert.deepEqual(text("2"), [{ vote: "yes", optionNumber: 2 }]);
  assert.deepEqual(text("1 and 3"), [
    { vote: "yes", optionNumber: 1 },
    { vote: "yes", optionNumber: 3 },
  ]);
  assert.deepEqual(text("1 yes, 2 maybe"), [
    { vote: "yes", optionNumber: 1 },
    { vote: "maybe", optionNumber: 2 },
  ]);
  assert.deepEqual(text("no 2"), [{ vote: "no", optionNumber: 2 }]);
  assert.deepEqual(text("none"), [{ vote: "no", optionNumber: null, allOptions: true }]);
});

test("ordinary chat is not a vote", () => {
  assert.deepEqual(text("lol see you all there"), []);
  assert.deepEqual(text("I have 2 dogs"), []);
});

test("structured tapback payload", () => {
  const msg = parseInbound({
    content: "",
    message_handle: "h2",
    from_number: "+15550001111",
    group_id: "g1",
    reaction: "dislike",
    reply_to: { message_handle: "bot-msg-1" },
  });
  assert.deepEqual(parseVotes(msg), [
    { vote: "no", optionNumber: null, targetHandle: "bot-msg-1", quotedText: null },
  ]);
});

test("text-relayed tapback resolves option from quote", () => {
  const msg = parseInbound({
    content: "Questioned “Option 2: Sat Nov 1, 7:00 PM”",
    message_handle: "h3",
    from_number: "+15550001111",
    group_id: "g1",
  });
  const [vote] = parseVotes(msg);
  assert.equal(vote.vote, "maybe");
  assert.equal(vote.optionNumber, 2);
});

test("laugh tapback is ignored", () => {
  const msg = parseInbound({ content: "Laughed at “haha”", message_handle: "h", from_number: "+1" });
  assert.deepEqual(parseVotes(msg), []);
});
