#!/usr/bin/env node
// A test run that reports ZERO tests is not a pass, and node:test will happily exit 0
// for it.
//
// This is not hypothetical. Twice tonight a test file containing
// `mkdirSync("/proc/...", {recursive: true})` HUNG - mkdir does not fail there, it blocks
// - and the runner reported "tests 1, pass 0, fail 0, cancelled 1" with exit code 0. In
// CI that is a green build that executed nothing. A comment in the test file was not
// enough; this is.
//
// Fails the run when:
//   - no test passed and none failed      -> nothing executed, or everything was cancelled
//   - anything was cancelled or timed out -> a file that never finished
//   - a per-file block reported zero tests -> one file silently contributed nothing
import { spawn } from "node:child_process";
import { globSync } from "node:fs";

const args = process.argv.slice(2);
const files = args.length ? args : globSync("test/*.test.mjs");

const child = spawn(process.execPath, ["--test", ...files], {
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, HERDR_DISABLE_PROMPT: "1" },
});

let out = "";
child.stdout.on("data", (d) => {
  const s = d.toString();
  out += s;
  process.stdout.write(s);
});

child.on("close", (code) => {
  const num = (label) => {
    // Matches both the default reporter ("ℹ tests 9") and TAP ("# tests 9").
    const m = new RegExp(`(?:^|\\n)\\s*(?:#|ℹ)\\s*${label}\\s+(\\d+)`).exec(out);
    return m ? Number(m[1]) : null;
  };
  const tests = num("tests");
  const pass = num("pass");
  const fail = num("fail");
  const cancelled = num("cancelled");
  const skipped = num("skipped");

  const problems = [];
  if (pass === null || tests === null) {
    problems.push("could not parse the test summary - refusing to call an unparsed run green");
  } else {
    if ((pass === 0 && fail === 0) || tests === 0) {
      problems.push(`zero tests executed (tests=${tests} pass=${pass} fail=${fail}) - this is a silent no-op, not a pass`);
    }
    if (cancelled && cancelled > 0) {
      problems.push(`${cancelled} test(s) cancelled or timed out - a file did not finish`);
    }
    // A test file that declares NO tests is counted by node as exactly one passing
    // "test" - the file itself. So `tests === files.length` is the tell for a file that
    // registered nothing, and it exits 0. Verified: an empty file reports "tests 1
    // pass 1" and a plain `node --test` returns 0. A run where the total does not exceed
    // the file count has at least one file contributing nothing.
    if (files.length > 0 && tests <= files.length) {
      problems.push(
        `tests=${tests} does not exceed file count=${files.length}: at least one test file declared no tests ` +
          `(node counts an empty file as one passing test, and exits 0)`
      );
    }
  }

  if (problems.length) {
    console.error(`\n✗ TEST GUARD: ${problems.join("; ")}`);
    process.exit(1);
  }
  console.log(`\n✓ test guard: tests=${tests} pass=${pass} fail=${fail}${skipped ? ` skipped=${skipped}` : ""}`);
  process.exit(code ?? 1);
});
