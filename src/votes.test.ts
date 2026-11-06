import test from "node:test";
import assert from "node:assert/strict";
import { heuristicBidVote, heuristicCommentVote, resolveVotePolicy } from "./votes.js";
import { loadInitTemplates } from "./config-templates.js";

const templates = await loadInitTemplates();
const policy = templates.votes as { defaultPolicy: "agent"; bidMinChars: number; bidKeywords: string[]; commentKeywords: string[] };

test("resolves vote policies with a safe agent default", () => {
  assert.equal(resolveVotePolicy(undefined), "agent");
  assert.equal(resolveVotePolicy("off"), "off");
  assert.equal(resolveVotePolicy("bogus" as unknown), "agent");
  assert.equal(resolveVotePolicy(undefined, { defaultPolicy: "heuristic" }), "heuristic");
  assert.equal(resolveVotePolicy("off", { defaultPolicy: "heuristic" }), "off");
});

test("heuristics are opt-in and conservative", () => {
  assert.equal(heuristicBidVote("short", policy), false);
  assert.equal(heuristicBidVote("I will fix the header and add a regression test for the overflow.", policy), true);
  assert.equal(heuristicCommentVote("The root cause is in header.dart:44.", policy), true);
  assert.equal(heuristicCommentVote("Looks good to me.", policy), false);
});

test("heuristic thresholds and keywords come from policy", () => {
  const custom = { bidMinChars: 5, bidKeywords: ["zzz"], commentKeywords: ["qqq"], defaultPolicy: "agent" as const };
  assert.equal(heuristicBidVote("I will fix it", custom), false);
  assert.equal(heuristicBidVote("zzz here", custom), true);
  assert.equal(heuristicCommentVote("qqq found", custom), true);
  assert.throws(() => heuristicBidVote("anything", null), /votes.bidMinChars/);
});
