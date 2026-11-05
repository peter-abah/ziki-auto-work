import test from "node:test";
import assert from "node:assert/strict";
import { heuristicBidVote, heuristicCommentVote, resolveVotePolicy } from "./votes.js";

test("resolves vote policies with a safe agent default", () => {
  assert.equal(resolveVotePolicy(undefined), "agent");
  assert.equal(resolveVotePolicy("off"), "off");
  assert.equal(resolveVotePolicy("bogus" as unknown), "agent");
});

test("heuristics are opt-in and conservative", () => {
  assert.equal(heuristicBidVote("short"), false);
  assert.equal(heuristicBidVote("I will fix the header and add a regression test for the overflow."), true);
  assert.equal(heuristicCommentVote("The root cause is in header.dart:44."), true);
  assert.equal(heuristicCommentVote("Looks good to me."), false);
});
