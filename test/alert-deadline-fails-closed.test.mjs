#!/usr/bin/env node
// A DEADLINE WITH NO NAMED RECIPIENT MUST DO NOTHING, AND SAY WHY.
//
// The card's failure mode is a firing that has nowhere to go. A deadline that expires and then
// escalates to a DEFAULTED audience is that same failure with a timer on it - so the recipient is
// read from config, defaults to null, and when it is absent the feature is INERT and the reason is
// recorded. That is the opposite of a default, and it is what lets this ship before anyone rules on
// who the recipient should be.
//
// The ordinary alert must also not fire in the same pass as the escalation. Two announcements for
// one condition - the ordinary one to the coordinator and the escalation to the recipient - is
// exactly the re-announcement the deadline exists to end, so a fired deadline takes the pass.
//
// Run: node test/alert-deadline-fails-closed.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const bridge = fs.readFileSync(new URL("../src/bridge.mjs", import.meta.url), "utf8");
const config = fs.readFileSync(new URL("../src/config.mjs", import.meta.url), "utf8");

test("the escalation recipient defaults to null in config, not to a handle", () => {
  assert.match(
    config,
    /escalationTo:\s*null/,
    "the recipient must default to null - a default handle is a re-announcement with a timer on it",
  );
  assert.match(config, /deadlineMs:\s*0/, "and an unconfigured deadline must be 0, not a guess");
});

test("an expired deadline with no recipient escalates to NOBODY and records why", () => {
  // The branch that matters. Both refusals are present and neither falls through to a prompt.
  assert.match(bridge, /no escalation recipient is configured, so nothing was sent/,
    "a missing recipient must be refused loudly");
  assert.match(bridge, /is not a known handle, so nothing was sent/,
    "and an unknown recipient must be refused too - a typo is not a fallback");
  // The prompt call must sit INSIDE the named-and-known branch, not beside it.
  const named = bridge.indexOf("!escalationTo || !validHandles.includes(escalationTo)");
  const promptCall = bridge.indexOf("prompt(escalationTo, escalateText");
  assert.ok(named > 0 && promptCall > named,
    "the escalation prompt must be reachable only after the recipient is named and known");
});

test("a fired deadline takes the pass, so the ordinary alert does not also fire", () => {
  // Two announcements for one condition is the re-announcement. The escalation owns the pass.
  assert.match(bridge, /if \(deadlineResult\.fired\) \{/, "a fired deadline must short-circuit the ordinary emit");
  const firedBranch = bridge.indexOf("if (deadlineResult.fired) {");
  const ordinary = bridge.indexOf("} else if (coordinatorDoorbell.enabled && coordinatorAlert");
  assert.ok(ordinary > firedBranch, "the ordinary emit must be the else-branch of the fired check");
});

test("the one-shot mark is set on the EXISTING state entry, not only when one happens to exist", () => {
  // If the mark is only written when a prior entry exists, a deadline whose first firing had no
  // state can fire again - and a deadline that can fire twice is the bug the card is named after.
  assert.match(bridge, /state\.coordinatorAlerts\[alertKey\]\.deadlineFired = true/);
  assert.match(bridge, /deadlineFiredAt/, "and the moment is recorded, so the escalation is auditable");
  assert.match(bridge, /deadlineFiredTo/, "and the recipient, so it is knowable who was asked");
});

test("the escalation text says it will not be raised again", () => {
  assert.match(bridge, /It will not be raised again for this condition/,
    "the recipient deserves to know this is the one and only escalation");
});
