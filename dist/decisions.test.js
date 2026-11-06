import test from "node:test";
import assert from "node:assert/strict";
import { formatOwnerDecisions, latestDecision, parseOwnerDecisions } from "./decisions.js";
const policy = {
    marker: "**Decision from the owner:**",
    kinds: ["confirm", "merge"],
    trueWords: ["yes", "y", "true"],
    falseWords: ["no", "n", "false"]
};
function parse(comments) {
    return parseOwnerDecisions(comments, policy);
}
test("parses labelled confirm and merge decisions", () => {
    const decisions = parse([
        {
            id: "1",
            body: "**Decision from the owner:**\nConfirm #42: yes\nMerge: no",
            authorName: "Peter"
        }
    ]);
    assert.equal(decisions.length, 2);
    assert.equal(latestDecision(decisions, "confirm")?.answer, true);
    assert.equal(latestDecision(decisions, "merge")?.answer, false);
    assert.equal(decisions[0].author, "Peter");
});
test("ambiguous prose is not a decision", () => {
    const decisions = parse([
        { id: "1", body: "**Decision from the owner:** Do not only confirm, maybe merge yes." }
    ]);
    assert.deepEqual(decisions, []);
});
test("ignores comments without the marker", () => {
    assert.deepEqual(parse([{ id: "1", body: "Confirm: yes" }]), []);
});
test("later labelled decisions win", () => {
    const decisions = parse([
        { id: "1", body: "**Decision from the owner:**\nConfirm: no" },
        { id: "2", body: "**Decision from the owner:**\nConfirm: yes" }
    ]);
    assert.equal(latestDecision(decisions, "confirm")?.answer, true);
});
test("accepts bold labels", () => {
    const decisions = parse([
        { id: "1", body: "**Decision from the owner:**\n**Confirm:** yes" }
    ]);
    assert.equal(latestDecision(decisions, "confirm")?.answer, true);
});
test("formats decisions for prompts", () => {
    const decisions = parse([{ id: "1", body: "**Decision from the owner:**\nMerge=yes" }]);
    assert.match(formatOwnerDecisions(decisions), /merge: yes/);
});
test("marker and vocabulary come from policy", () => {
    const custom = { marker: "[DECIDE]", kinds: ["ship"], trueWords: ["go"], falseWords: ["stop"] };
    const decisions = parseOwnerDecisions([{ id: "1", body: "[DECIDE]\nShip: go" }], custom);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].text, "Ship: go");
    assert.deepEqual(parseOwnerDecisions([{ id: "1", body: "[DECIDE]\nShip: go" }], policy), []);
    assert.throws(() => parseOwnerDecisions([{ id: "1", body: "x" }], null), /decisions.marker/);
});
//# sourceMappingURL=decisions.test.js.map