import test from "node:test";
import assert from "node:assert/strict";
import { formatOwnerDecisions, latestDecision, parseOwnerDecisions } from "./decisions.js";

test("parses labelled confirm and merge decisions", () => {
  const decisions = parseOwnerDecisions([
    {
      id: "1",
      body: "**Decision from the owner:**\nConfirm #42: yes\nMerge: no",
      authorName: "Peter"
    }
  ]);
  assert.equal(decisions.length, 2);
  assert.equal(latestDecision(decisions, "confirm")?.answer, true);
  assert.equal(latestDecision(decisions, "merge")?.answer, false);
  assert.equal(decisions[0]!.author, "Peter");
});

test("ambiguous prose is not a decision", () => {
  const decisions = parseOwnerDecisions([
    { id: "1", body: "**Decision from the owner:** Do not only confirm, maybe merge yes." }
  ]);
  assert.deepEqual(decisions, []);
});

test("ignores comments without the marker", () => {
  assert.deepEqual(parseOwnerDecisions([{ id: "1", body: "Confirm: yes" }]), []);
});

test("later labelled decisions win", () => {
  const decisions = parseOwnerDecisions([
    { id: "1", body: "**Decision from the owner:**\nConfirm: no" },
    { id: "2", body: "**Decision from the owner:**\nConfirm: yes" }
  ]);
  assert.equal(latestDecision(decisions, "confirm")?.answer, true);
});

test("accepts bold labels", () => {
  const decisions = parseOwnerDecisions([
    { id: "1", body: "**Decision from the owner:**\n**Confirm:** yes" }
  ]);
  assert.equal(latestDecision(decisions, "confirm")?.answer, true);
});

test("formats decisions for prompts", () => {
  const decisions = parseOwnerDecisions([{ id: "1", body: "**Decision from the owner:**\nMerge=yes" }]);
  assert.match(formatOwnerDecisions(decisions), /merge: yes/);
});
