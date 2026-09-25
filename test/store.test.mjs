import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sendAmqMessage } from "../src/store.mjs";

test("sendAmqMessage computes a canonical thread before delivery", () => {
  const amqRoot = fs.mkdtempSync(path.join(os.tmpdir(), "amq-store-test-"));
  try {
    const result = sendAmqMessage(amqRoot, {
      from: "coordinator",
      to: "qa",
      subject: "Canonical thread regression",
      body: "The dashboard must not crash while sending this message.",
    });
    assert.equal(result.ok, true, result.error || "sendAmqMessage failed");
  } finally {
    fs.rmSync(amqRoot, { recursive: true, force: true });
  }
});
