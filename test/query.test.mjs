import test from "node:test";
import assert from "node:assert/strict";
import { parseQuery, matchesFilter } from "../src/store.mjs";

test("parseQuery - basic terms and status flags", () => {
  const q = parseQuery("is:unread has:attachment bug report", "user");
  assert.equal(q.isUnread, true);
  assert.equal(q.hasAttachment, true);
  assert.equal(q.hasImage, false);
  assert.deepEqual(q.terms, ["bug", "report"]);
});

test("parseQuery - from:me and to:me with account", () => {
  const q = parseQuery("from:me to:coordinator", "spotter");
  assert.deepEqual(q.from, ["spotter"]);
  assert.deepEqual(q.to, ["coordinator"]);
});

test("parseQuery - from:me with explicit persona overrides account=all", () => {
  const q = parseQuery("from:me", "all", "player-rig");
  assert.deepEqual(q.from, ["player-rig"]);
});

test("parseQuery - from:me fallback to user when account is all and persona is empty", () => {
  const q = parseQuery("from:me", "all", "");
  assert.deepEqual(q.from, ["user"]);
});

test("parseQuery - image filters and quoted tokens", () => {
  const q = parseQuery('has:image "memory leak" is:starred', "user");
  assert.equal(q.hasImage, true);
  assert.equal(q.isStarred, true);
  assert.deepEqual(q.terms, ["memory leak"]);
});

test("matchesFilter - matches sender and recipient", () => {
  const msg = {
    id: "m1",
    from: "spotter",
    to: ["coordinator", "qa"],
    subject: "validation pass",
    snippet: "all 14 checks passed",
    body: "verification report",
    hasImage: true,
    hasAttachment: true,
    isNew: true,
  };

  const q1 = parseQuery("from:spotter to:qa", "user");
  assert.equal(matchesFilter(msg, q1), true);

  const q2 = parseQuery("from:ballistics", "user");
  assert.equal(matchesFilter(msg, q2), false);
});

test("matchesFilter - matches status and attachments", () => {
  const msgWithImg = {
    id: "m2",
    from: "testkit",
    to: ["coordinator"],
    subject: "charts",
    hasImage: true,
    hasAttachment: true,
    isNew: false,
  };

  assert.equal(matchesFilter(msgWithImg, parseQuery("has:image", "user")), true);
  assert.equal(matchesFilter(msgWithImg, parseQuery("is:unread", "user")), false);

  const msgPlain = {
    id: "m3",
    from: "testkit",
    to: ["coordinator"],
    subject: "notice",
    hasImage: false,
    hasAttachment: false,
    isNew: true,
  };

  assert.equal(matchesFilter(msgPlain, parseQuery("has:attachment", "user")), false);
  assert.equal(matchesFilter(msgPlain, parseQuery("is:unread", "user")), true);
});

test("matchesFilter - fuzzy term matching", () => {
  const msg = {
    id: "m4",
    from: "coordinator",
    to: ["all"],
    subject: "Physics engine collision matrix",
    snippet: "Checking bullet penetration through composite armor",
    body: "",
  };

  assert.equal(matchesFilter(msg, parseQuery("collision", "user")), true);
  assert.equal(matchesFilter(msg, parseQuery("penetration", "user")), true);
  assert.equal(matchesFilter(msg, parseQuery("unrelatedqueryxyz", "user")), false);
});

test("matchesFilter - typo and fuzzy query matching for common misspellings", () => {
  const msg = {
    id: "m5",
    from: "spotter",
    to: ["range"],
    subject: "Mobile responsivity filter update",
    snippet: "Fixing search bar to occupy most of screen on mobile",
    body: "Ensure filters and highlighting work properly",
  };

  // Typo: "filtwr" -> "filter"
  assert.equal(matchesFilter(msg, parseQuery("filtwr", "user")), true);
  // Typo: "mobike" -> "mobile"
  assert.equal(matchesFilter(msg, parseQuery("mobike", "user")), true);
  // Typo: "sewrch" -> "search"
  assert.equal(matchesFilter(msg, parseQuery("sewrch", "user")), true);
});

