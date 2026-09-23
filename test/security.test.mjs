import test, { describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { startWebServer } from "../src/server.mjs";

describe("Red-Team Security Compliance & Hardening Suite", () => {
  let tempRoot;
  let server;
  let baseUrl;
  let port;

  before(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sec-test-"));
    const agentsDir = path.join(tempRoot, "agents");
    fs.mkdirSync(path.join(agentsDir, "sec-agent", "inbox", "new"), { recursive: true });

    // Start server explicitly on ephemeral port with default 127.0.0.1
    server = startWebServer({ port: 0, amqRoot: tempRoot });
    await new Promise((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });

    const addr = server.address();
    port = addr.port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(() => {
    if (server) server.close();
    if (tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  function request(reqPath, headers = {}) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(reqPath, baseUrl);
      const options = {
        hostname: "127.0.0.1",
        port,
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: {
          Host: `127.0.0.1:${port}`,
          ...headers,
        },
      };

      const req = http.request(options, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      });
      req.on("error", reject);
      req.end();
    });
  }

  test("Vulnerability 1: Server must strictly bind to 127.0.0.1 (Loopback only)", () => {
    const addr = server.address();
    assert.strictEqual(addr.address, "127.0.0.1", "Must bind exclusively to 127.0.0.1 loopback interface");
  });

  test("Vulnerability 2: DNS Rebinding Protection rejects foreign Host headers", async () => {
    // Attack scenario: Attacker points evil-hacker.com to 127.0.0.1
    const res1 = await request("/api/status", { Host: "evil-hacker.com" });
    assert.strictEqual(res1.status, 403, "Should reject foreign host header");
    assert.ok(res1.body.includes("DNS rebinding protection"));

    // Attack scenario: Attacker uses custom port or subdomain
    const res2 = await request("/api/status", { Host: "attacker.domain:8505" });
    assert.strictEqual(res2.status, 403, "Should reject external host with port");

    // Attack scenario: Attacker uses LAN IP address
    const res3 = await request("/api/status", { Host: "192.168.1.50:8505" });
    assert.strictEqual(res3.status, 403, "Should reject non-loopback IP");

    // Valid loopback hosts must pass
    const resLocalhost = await request("/api/status", { Host: `localhost:${port}` });
    assert.strictEqual(resLocalhost.status, 200, "localhost must be permitted");

    const resIp = await request("/api/status", { Host: `127.0.0.1:${port}` });
    assert.strictEqual(resIp.status, 200, "127.0.0.1 must be permitted");
  });

  test("Vulnerability 3: Compliance security headers must be present on all responses", async () => {
    const res = await request("/");
    assert.strictEqual(res.headers["x-content-type-options"], "nosniff", "Must include nosniff");
    assert.strictEqual(res.headers["x-frame-options"], "DENY", "Must deny iframe embedding (anti-clickjacking)");
    assert.ok(res.headers["content-security-policy"].includes("frame-ancestors 'none'"), "CSP must disallow framing");
    assert.strictEqual(res.headers["referrer-policy"], "no-referrer", "Must suppress referrer leakage");
  });

  test("Vulnerability 4: System credential and dotfile probing must be strictly blocked (403)", async () => {
    const forbiddenProbes = [
      "/etc/passwd",
      "/etc/shadow",
      "/root/.bashrc",
      "/proc/self/environ",
      "/sys/class/net",
      ".ssh/id_rsa",
      ".ssh/id_ed25519",
      ".env",
      ".git/config",
      "credentials.json",
      "server.pem",
      "private.key",
      ".bash_history",
    ];

    for (const probe of forbiddenProbes) {
      const res = await request(`/api/file?path=${encodeURIComponent(probe)}`);
      assert.strictEqual(res.status, 403, `Probe for '${probe}' must return 403 Forbidden`);
      assert.ok(res.body.includes("denied") || res.body.includes("forbidden"));
    }
  });

  test("Vulnerability 5: Directory traversal escaping allowed root must be rejected (403)", async () => {
    const traversalProbes = [
      "../../../../../../etc/passwd",
      "../../../.ssh/id_rsa",
      "..%2f..%2f..%2fetc%2fpasswd",
      "/var/log/syslog",
    ];

    for (const probe of traversalProbes) {
      const res = await request(`/api/file?path=${probe}`);
      assert.strictEqual(res.status, 403, `Traversal attempt '${probe}' must be rejected with 403`);
    }
  });

  test("Vulnerability 6: Null-byte injection evasion must be rejected (403)", async () => {
    const nullByteProbes = [
      "/api/file?path=/etc/passwd%00.png",
      "/api/file?path=%00/etc/passwd",
    ];

    for (const probe of nullByteProbes) {
      const res = await request(probe);
      assert.strictEqual(res.status, 403, `Null byte probe '${probe}' must be rejected with 403`);
      assert.ok(res.body.includes("Null-byte"));
    }
  });

  test("Vulnerability 7: Git object parameter injection must be rejected", async () => {
    // Malicious commit SHA syntax
    const res1 = await request("/api/git-file?commit=HEAD;rm%20-rf%20/&path=README.md");
    assert.strictEqual(res1.status, 404, "Invalid commit SHA must not execute");

    // Traversal inside git path
    const res2 = await request("/api/git-file?commit=abcdef1&path=../../etc/passwd");
    assert.strictEqual(res2.status, 404, "Path traversal inside git ref must not resolve");
  });

  test("Vulnerability 8: CAS Blobstore path traversal evasion must not escape .agent-mail/blobs", async () => {
    const res = await request("/api/blob/../../etc/passwd");
    assert.strictEqual(res.status, 404, "Blob traversal must return 404");
  });
});
