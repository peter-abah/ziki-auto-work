import test from "node:test";
import assert from "node:assert/strict";
import { formatOwnerDecisions, latestDecision, parseOwnerDecisions } from "./decisions.js";

test("parses a confirm yes decision", () => {
  const decisions = parseOwnerDecisions([
    { id: "1", body: "**Decision from the owner:** Confirm #42: yes, go ahead.", authorName: "Peter" }
  ]);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.kind, "confirm");
  assert.equal(decisions[0]!.answer, true);
  assert.equal(decisions[0]!.author, "Peter");
});

test("parses merge no and rejects negatives correctly", () => {
  const decisions = parseOwnerDecisions([
    { id: "1", body: "**Decision from the owner:** Do not merge #42. Confirm it, yes." }
  ]);
  assert.equal(latestDecision(decisions, "merge")?.answer, false);
  assert.equal(latestDecision(decisions, "confirm")?.answer, true);
});

test("ignores ordinary comments", () => {
  assert.deepEqual(parseOwnerDecisions([{ id: "1", body: "Looks good to me." }]), []);
});

test("formats decisions for prompts", () => {
  const decisions = parseOwnerDecisions([{ id: "1", body: "**Decision from the owner:** Merge yes." }]);
  assert.match(formatOwnerDecisions(decisions), /merge: yes/);
});
