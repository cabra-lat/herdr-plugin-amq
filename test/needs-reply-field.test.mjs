import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sendMaildirMessage, replyMaildirMessage, findUnansweredAsks,
  readNeedsReply, parseMessage, serializeMessage,
} from "../src/protocol.mjs";

/**
 * `needs_reply`: a field with a schema, replacing a rule that was prose in a document.
 *
 * THE FAILURE THAT PROMOTED THIS. Tonight a message arrived that did not state what it wanted, it
 * received an acknowledgement-only answer, and it was caught by a human READING THE MAIL. Our
 * rule - "every action-requesting message must say so" - was never enforced anywhere; it was a
 * sentence agents were supposed to have read.
 *
 * The same failure wore a different costume all session on the board: six blocked cards reported
 * as carrying no next actor, where in most cases somebody WAS waiting on a decision. A card
 * waiting on a person is indistinguishable from a card nobody came back to, and both look like
 * "no actor".
 *
 * TWO DESIGN CONSTRAINTS, and the second is the one that would have destroyed the card.
 *
 * IT MUST BE A FIELD AND NOT A GATE. If a peer cannot report progress until its ask is answered,
 * a blocked peer becomes SILENT rather than blocked - the worst possible conversion, because
 * today a blocked peer at least appears on the board. So `needs_reply` never suppresses anything.
 * The failure direction of every consumer here is a redundant prompt, which is cheap.
 *
 * THE DEFAULT MUST BE SAFE WHEN UNSET. Absent means UNKNOWN, and unknown is read as MAYBE an ask.
 * It does not mean false. A field only ever set by disciplined senders is a field that will be
 * absent exactly when it is needed - which is the moment this field exists for.
 */
/** Find a delivered message by id wherever the mailbox put it. The maildir filename is
 *  NOT the message id - an early version of this file assumed it was and every arm that built a
 *  path from r.id failed with ENOENT for reasons that had nothing to do with the field. */
function headerOf(amqRoot, handle, id) {
  for (const folder of ["new", "cur"]) {
    const dir = path.join(amqRoot, "agents", handle, "inbox", folder);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      const { header } = parseMessage(fs.readFileSync(path.join(dir, file), "utf8"));
      if (header.id === id) return header;
    }
  }
  return null;
}

function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "needs-reply-"));
  const amqRoot = path.join(dir, ".agent-mail");
  for (const h of ["worker", "user"]) {
    fs.mkdirSync(path.join(amqRoot, "agents", h, "inbox", "new"), { recursive: true });
    fs.mkdirSync(path.join(amqRoot, "agents", h, "inbox", "cur"), { recursive: true });
  }
  return amqRoot;
}

describe("arm one: a message that never mentions the field is not thereby excused", () => {
  test("needs_reply is ABSENT from the record when the sender did not state it", () => {
    const amqRoot = root();
    const r = sendMaildirMessage(amqRoot, { from: "worker", to: "user", subject: "s", body: "b" });
    const header = headerOf(amqRoot, "user", r.id);
    assert.ok(header, "the message was delivered");
    assert.equal("needs_reply" in header, false,
      "absent, not false - a field defaulting to false would turn silence into a confident 'no'");
    assert.equal(readNeedsReply(header), null, "and the only reader reports UNKNOWN");
  });

  test("readNeedsReply maps only the two declared values, and treats junk as UNKNOWN", () => {
    // The bug being replaced was a consumer writing `card.x || 0` and turning an absent key into
    // a number. So the reader is total: true, false, or null, and there is no path to a boolean
    // that was not stated by the sender.
    assert.equal(readNeedsReply({ needs_reply: true }), true);
    assert.equal(readNeedsReply({ needs_reply: false }), false);
    assert.equal(readNeedsReply({}), null);
    assert.equal(readNeedsReply(null), null);
    assert.equal(readNeedsReply({ needs_reply: "yes" }), null, "a string is not a boolean");
    assert.equal(readNeedsReply({ needs_reply: 0 }), null, "zero is not false - that is the trap");
  });

  test("an UNSTATED ask is still doorbelled, and is REPORTED as unstated", () => {
    // The acceptance asks for the count of messages that arrived with the field absent, because a
    // field only disciplined senders set is a field that is absent exactly when it is needed.
    const amqRoot = root();
    sendMaildirMessage(amqRoot, { from: "worker", to: "user", subject: "unstated", body: "please look" });
    const asks = findUnansweredAsks(amqRoot, "user");
    const mine = asks.find((a) => a.subject === "unstated");
    assert.ok(mine, "an undeclared message is still an ask as far as this tool is concerned");
    assert.equal(mine.needs_reply, null, "reported as UNKNOWN, not as false");
    assert.equal(mine.declared, false, "and flagged as not explicitly declared");
  });

  test("an explicitly non-asking message is NOT an ask - or the field means nothing", () => {
    const amqRoot = root();
    sendMaildirMessage(amqRoot, {
      from: "worker", to: "user", subject: "fyi", body: "no action needed", needs_reply: false,
    });
    const asks = findUnansweredAsks(amqRoot, "user");
    assert.equal(asks.filter((a) => a.subject === "fyi").length, 0,
      "otherwise every message is an ask and the field carries no information");
  });
});

describe("arm two: a declared ask answered with nothing is DETECTABLE", () => {
  test("an acknowledgement-only reply leaves the ask open", () => {
    // THE ARM. Today this thread looks handled: a reply exists, it says "ack", and nothing
    // anywhere records that the question was never answered.
    const amqRoot = root();
    const ask = sendMaildirMessage(amqRoot, {
      from: "user", to: "worker", subject: "which kind?", body: "is it pi or agy?", needs_reply: true,
    });
    replyMaildirMessage(amqRoot, { from: "worker", replyToId: ask.id, body: "ack, looking" });

    // The ask was delivered to WORKER, so that is the mailbox to query. An early version of this
    // arm asked user's mailbox and asserted the ask was missing - which it was, correctly, and
    // the assertion passed for entirely the wrong reason.
    const asks = findUnansweredAsks(amqRoot, "worker");
    const still = asks.find((a) => a.id === ask.id);
    assert.ok(still, "the ask must still be open - a reply is not an answer");
    assert.equal(still.needs_reply, true);
    assert.equal(still.declared, true);
  });

  test("an EMPTY reply is also not an answer", () => {
    const amqRoot = root();
    const ask = sendMaildirMessage(amqRoot, {
      from: "user", to: "worker", subject: "q", body: "which one?", needs_reply: true,
    });
    replyMaildirMessage(amqRoot, { from: "worker", replyToId: ask.id, body: "" });
    assert.ok(findUnansweredAsks(amqRoot, "worker").some((a) => a.id === ask.id),
      "the ask is in WORKER's inbox, because worker is who it was sent to");
  });

  test("a reply that DECLARES an answer closes the ask", () => {
    const amqRoot = root();
    const ask = sendMaildirMessage(amqRoot, {
      from: "user", to: "worker", subject: "q", body: "which one?", needs_reply: true,
    });
    replyMaildirMessage(amqRoot, {
      from: "worker", replyToId: ask.id, body: "pi - the brief declares it", answersAsk: true,
    });
    const open = findUnansweredAsks(amqRoot, "worker").filter((a) => a.id === ask.id);
    assert.equal(open.length, 0, "a declared answer closes it");
  });

  test("the reply records what the original asked for, so the audit is not guesswork", () => {
    const amqRoot = root();
    const ask = sendMaildirMessage(amqRoot, {
      from: "user", to: "worker", subject: "q", body: "which one?", needs_reply: true,
    });
    const reply = replyMaildirMessage(amqRoot, {
      from: "worker", replyToId: ask.id, body: "pi", answersAsk: true,
    });
    const header = headerOf(amqRoot, "user", reply.id);
    assert.ok(header, "the reply was delivered");
    assert.equal(header.asks_reply, true, "the reply records the state of the ask it answers");
    assert.equal(header.answers_ask.answered, true);
  });
});

describe("arm three: a card waiting on a person is distinguishable from an abandoned one", () => {
  test("the same distinction is available for board cards, and it is a REPORT not an alert", () => {
    // This is the board-shaped half. A blocked card whose next actor is a person is a standing
    // obligation; a blocked card with no next actor is somebody not coming back. They look
    // identical in every field the alert reads, which is why six of them read as "no actor".
    //
    // It is a report and NOT an alert, deliberately. Alerting on it would page lanes about a
    // decision only the human can make, and an alert that fires on ordinary queue latency is an
    // alert everyone learns to ignore - after which the next real one is missed too.
    const classify = (card) => {
      if (card.status !== "blocked") return "not-blocked";
      if (Array.isArray(card.depends_on) && card.depends_on.length) return "waiting-on-card";
      if (card.next_actor && card.next_actor !== card.owner) return "waiting-on-person-or-lane";
      if (card.next_actor === card.owner) return "self-routed";
      return "no-actor";
    };
    assert.equal(classify({ status: "blocked", owner: "a", next_actor: "user" }), "waiting-on-person-or-lane");
    assert.equal(classify({ status: "blocked", owner: "a" }), "no-actor");
    assert.equal(classify({ status: "blocked", owner: "a", next_actor: "a" }), "self-routed");
    assert.equal(classify({ status: "blocked", owner: "a", next_actor: "b", depends_on: ["t1"] }), "waiting-on-card");
    assert.notEqual(classify({ status: "blocked", owner: "a", next_actor: "user" }),
      classify({ status: "blocked", owner: "a" }),
      "the two cases this card exists to separate must not collapse together");
  });
});

describe("the field is a field, not a gate", () => {
  test("declaring needs_reply does not suppress delivery, and the message still arrives", () => {
    // The constraint that would have destroyed the card. A gate here would make a peer silent
    // while blocked, which is strictly worse than the acknowledgement-only reply we are fixing.
    const amqRoot = root();
    const r = sendMaildirMessage(amqRoot, {
      from: "worker", to: "user", subject: "q", body: "?", needs_reply: true,
    });
    assert.ok(headerOf(amqRoot, "user", r.id), "an ask is still delivered; needs_reply never suppresses anything");
  });

  test("serializeMessage round-trips the field without inventing one", () => {
    const withField = serializeMessage({ id: "m1", from: "a", to: "b", body: "x", needs_reply: true });
    assert.equal(readNeedsReply(parseMessage(withField).header), true);
    const without = serializeMessage({ id: "m2", from: "a", to: "b", body: "x" });
    assert.equal("needs_reply" in parseMessage(without).header, false);
  });
});

describe("red arm: the consumer this card replaces, pinned so it cannot come back", () => {
  // The idiom being retired, defined once at module scope. An earlier version of this file
  // declared it inside the first test and the second test then failed with "oldRead is not
  // defined" - which is the test suite's own version of the bug this card is about: a fact
  // stated in one place and assumed present in another.
  const oldRead = (header) => header?.needs_reply || false;

  test("the OLD idiom (x || false) turns silence into a confident 'no reply needed'", () => {
    // This is the bug, written out and asserted, so that reintroducing the idiom fails a test
    // instead of passing review. Every version of the old rule read the field the way that idiom
    // reads it, and the consequence is the failure the card exists to prevent: a sender who
    // forgot the field produces a message that reads as "definitely needs no reply", and it
    // therefore never surfaces - at exactly the moment the field was needed.
    for (const header of [{}, { needs_reply: null }, { needs_reply: 0 }, { needs_reply: undefined }]) {
      assert.equal(oldRead(header), false, "the old idiom answers definitively where nobody spoke");
      assert.equal(readNeedsReply(header), null, "and the new reader declines to answer");
    }
  });

  test("so the two disagree EXACTLY where the bug lives, which is the test's whole point", () => {
    const silent = {};
    assert.notEqual(oldRead(silent), readNeedsReply(silent),
      "if these ever agree again, the field has stopped protecting anything");
    // And on a real ask, both agree - the disagreement must be confined to the ambiguous case,
    // or the reader is simply broken rather than careful.
    const asked = { needs_reply: true };
    assert.equal(oldRead(asked), readNeedsReply(asked));
    const declared = { needs_reply: false };
    assert.equal(oldRead(declared), readNeedsReply(declared));
  });

  test("findUnansweredAsks is WIDE where the old rule was narrow", () => {
    // The old rule counted only messages that announced themselves. The new one counts every
    // message that did not explicitly say it needs no reply, which is why an undeclared ask is
    // still an ask. A narrow reader would make the field a reward for remembering to set it.
    const amqRoot = root();
    sendMaildirMessage(amqRoot, { from: "worker", to: "user", subject: "quiet", body: "no flags at all" });
    const asks = findUnansweredAsks(amqRoot, "user");
    assert.equal(asks.length, 1);
    assert.equal(asks[0].declared, false, "included, and reported as not declared");
  });
});
