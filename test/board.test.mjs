import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  classifyStatus,
  parseStatusMd,
  loadBoard,
  addBoardTask,
  updateBoardTask,
  deleteBoardTask,
} from "../src/board.mjs";

describe("board.mjs Kanban module", () => {
  test("classifyStatus classifies states correctly", () => {
    assert.equal(classifyStatus("Feature X", "DONE 2026-09-22 — verified"), "done");
    assert.equal(classifyStatus("~~Struck item~~", "something"), "done");
    assert.equal(classifyStatus("Gate audit", "BLOQUEIO no CI"), "blocked");
    assert.equal(classifyStatus("Hazard check", "fatal fail in test"), "blocked");
    assert.equal(classifyStatus("Arm IK", "CAUSA ACHADA — em curso"), "in_progress");
    assert.equal(classifyStatus("Future role", "fila"), "backlog");
    assert.equal(classifyStatus("Unstarted", "pendente"), "backlog");
  });

  test("parseStatusMd extracts claimed tasks and table rows", () => {
    const sampleMd = `
# Bus STATUS — board

## EM VOO (claimed)

**CLAIMED by coordinator 2026-09-23T07:44Z** — inbox drained (4: range multiplayer DONE, spotter mao-strip OK); replied on-thread.
**CLAIMED by spotter 2026-09-23T08:00Z** — GPU strip verification in progress.

| Item | Dono | Estado |
|---|---|---|
| **Gate verify** | testkit | **DONE 2026-09-22T01:44Z — RESULT: PASS (exit 0)** |
| **Deadlock investigation** | testkit | **BLOQUEIO: self-deadlock in lock wrapper** |
| **Arm IK Phase 2** | player-rig | **FASE 1 DONE; em curso** |
| Fila stealth | player-rig | fila |
`;

    const tasks = parseStatusMd(sampleMd);
    assert.equal(tasks.length, 6);

    const claimed = tasks.filter((t) => t.source === "status_em_voo");
    assert.equal(claimed.length, 2);
    assert.equal(claimed[0].owner, "coordinator");
    assert.equal(claimed[0].status, "in_progress");

    const tableTasks = tasks.filter((t) => t.source === "status_table");
    assert.equal(tableTasks.length, 4);

    const doneTask = tableTasks.find((t) => t.title.includes("Gate verify"));
    assert.ok(doneTask);
    assert.equal(doneTask.status, "done");

    const blockedTask = tableTasks.find((t) => t.title.includes("Deadlock"));
    assert.ok(blockedTask);
    assert.equal(blockedTask.status, "blocked");

    const inProgTask = tableTasks.find((t) => t.title.includes("Arm IK"));
    assert.ok(inProgTask);
    assert.equal(inProgTask.status, "in_progress");

    const backlogTask = tableTasks.find((t) => t.title.includes("stealth"));
    assert.ok(backlogTask);
    assert.equal(backlogTask.status, "backlog");
  });

  test("loadBoard merges STATUS.md and custom task overlay", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "amq-board-test-"));
    const busDir = path.join(tmpDir, ".opencode", "bus");
    fs.mkdirSync(busDir, { recursive: true });

    const statusPath = path.join(busDir, "STATUS.md");
    fs.writeFileSync(
      statusPath,
      `# Board
## EM VOO (claimed)
**CLAIMED by range 2026-09-23T04:00Z** — arena spawn testing

| Item | Dono | Estado |
|---|---|---|
| **Inventory UI** | inventory-ux | **DONE** |
`
    );

    const amqRoot = path.join(tmpDir, ".agent-mail");
    fs.mkdirSync(amqRoot, { recursive: true });

    const board = loadBoard(tmpDir, amqRoot);
    assert.equal(board.stats.total, 2);
    assert.equal(board.columns.in_progress.length, 1);
    assert.equal(board.columns.done.length, 1);
    assert.ok(board.owners.includes("range"));
    assert.ok(board.owners.includes("inventory-ux"));

    // Add custom task
    const addRes = addBoardTask(tmpDir, amqRoot, {
      title: "New Custom Feature",
      owner: "spotter",
      status: "backlog",
      description: "Take high-res GPU screenshots",
    });
    assert.equal(addRes.ok, true);

    const boardAfterAdd = loadBoard(tmpDir, amqRoot);
    assert.equal(boardAfterAdd.stats.total, 3);
    assert.equal(boardAfterAdd.columns.backlog.length, 1);
    assert.equal(boardAfterAdd.columns.backlog[0].title, "New Custom Feature");

    // Move task
    const moveRes = updateBoardTask(tmpDir, amqRoot, addRes.task.id, { status: "done" });
    assert.equal(moveRes.ok, true);

    const boardAfterMove = loadBoard(tmpDir, amqRoot);
    assert.equal(boardAfterMove.columns.backlog.length, 0);
    assert.equal(boardAfterMove.columns.done.length, 2);

    // Delete task
    deleteBoardTask(tmpDir, amqRoot, addRes.task.id);
    const boardAfterDel = loadBoard(tmpDir, amqRoot);
    assert.equal(boardAfterDel.stats.total, 2);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("notifyTaskEvent and automailing creates AMQ notifications on task lifecycle", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "amq-board-notify-"));
    const amqRoot = path.join(tmpDir, ".agent-mail");
    fs.mkdirSync(amqRoot, { recursive: true });

    // 1. Add task assigned to 'spotter'
    const addRes = addBoardTask(tmpDir, amqRoot, {
      title: "Calibrate FOV Zoom",
      owner: "spotter",
      status: "backlog",
      description: "Verify FOV transitions in 1280x720",
      from: "coordinator",
    });
    assert.equal(addRes.ok, true);

    // Check that spotter received an assignment email in inbox/new
    const spotterInboxDir = path.join(amqRoot, "agents", "spotter", "inbox", "new");
    assert.ok(fs.existsSync(spotterInboxDir));
    const spotterFiles = fs.readdirSync(spotterInboxDir);
    assert.equal(spotterFiles.length, 1);

    const assignMsg = fs.readFileSync(path.join(spotterInboxDir, spotterFiles[0]), "utf8");
    assert.ok(assignMsg.includes("[AGboard] [ASSIGNED] Calibrate FOV Zoom"));
    assert.ok(assignMsg.includes("Calibrate FOV Zoom"));
    assert.ok(assignMsg.includes("herdr-amq task claim"));

    // 2. Claim task (spotter claims task -> in_progress)
    const claimRes = updateBoardTask(
      tmpDir,
      amqRoot,
      addRes.task.id,
      { status: "in_progress", owner: "spotter" },
      { from: "spotter" }
    );
    assert.equal(claimRes.ok, true);

    // Check that coordinator received a claimed email
    const coordInboxDir = path.join(amqRoot, "agents", "coordinator", "inbox", "new");
    assert.ok(fs.existsSync(coordInboxDir));
    let coordFiles = fs.readdirSync(coordInboxDir);
    assert.ok(coordFiles.length >= 1);

    const claimMsg = fs.readFileSync(path.join(coordInboxDir, coordFiles[coordFiles.length - 1]), "utf8");
    assert.ok(claimMsg.includes("[AGboard] [CLAIMED] Calibrate FOV Zoom"));

    // 3. Block task (spotter blocks task)
    const blockRes = updateBoardTask(
      tmpDir,
      amqRoot,
      addRes.task.id,
      { status: "blocked" },
      { from: "spotter", reason: "Missing GPU context on :99" }
    );
    assert.equal(blockRes.ok, true);

    coordFiles = fs.readdirSync(coordInboxDir);
    const blockMsg = fs.readFileSync(path.join(coordInboxDir, coordFiles[coordFiles.length - 1]), "utf8");
    assert.ok(blockMsg.includes("[AGboard] [BLOCKED] Calibrate FOV Zoom"));
    assert.ok(blockMsg.includes("Missing GPU context"));
    assert.ok(blockMsg.includes('"priority": "urgent"') || blockMsg.includes("TASK BLOCKED"));

    // 4. Complete task (spotter completes task)
    const doneRes = updateBoardTask(
      tmpDir,
      amqRoot,
      addRes.task.id,
      { status: "done" },
      { from: "spotter", proof: "strip verified 8 frames pass" }
    );
    assert.equal(doneRes.ok, true);

    coordFiles = fs.readdirSync(coordInboxDir);
    const doneMsg = fs.readFileSync(path.join(coordInboxDir, coordFiles[coordFiles.length - 1]), "utf8");
    assert.ok(doneMsg.includes("[AGboard] [COMPLETED] Calibrate FOV Zoom"));
    assert.ok(doneMsg.includes("strip verified 8 frames pass"));

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("global bus separates tasks by backlog, doing, blocked, done directories", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "amq-bus-dirs-test-"));
    const amqRoot = path.join(tmpDir, ".agent-mail");
    fs.mkdirSync(amqRoot, { recursive: true });

    // 1. Initial empty bus directories created
    const board = loadBoard(tmpDir, amqRoot);
    const busDir = board.busDir;
    assert.ok(fs.existsSync(path.join(busDir, "backlog")));
    assert.ok(fs.existsSync(path.join(busDir, "doing")));
    assert.ok(fs.existsSync(path.join(busDir, "blocked")));
    assert.ok(fs.existsSync(path.join(busDir, "done")));

    // 2. Add task to backlog
    const addRes = addBoardTask(tmpDir, amqRoot, {
      title: "Write Raycast Punchthrough Tests",
      owner: "ballistics",
      status: "backlog",
      description: "Ensure Recht-Ipson formula residual energy respects cert table",
      notify: false,
    });
    assert.equal(addRes.ok, true);
    const taskId = addRes.task.id;

    const backlogFile = path.join(busDir, "backlog", `${taskId}.md`);
    assert.ok(fs.existsSync(backlogFile), "Task file should exist in bus/backlog/");
    const backlogContent = fs.readFileSync(backlogFile, "utf8");
    assert.ok(backlogContent.includes("Write Raycast Punchthrough Tests"));
    assert.ok(backlogContent.includes("Recht-Ipson formula residual energy"));
    assert.ok(backlogContent.includes(`thread: "agboard/${taskId}"`));

    // 3. Move task to doing (in_progress)
    const moveDoingRes = updateBoardTask(tmpDir, amqRoot, taskId, { status: "in_progress" }, { notify: false });
    assert.equal(moveDoingRes.ok, true);

    assert.equal(fs.existsSync(backlogFile), false, "Old backlog file should be moved");
    const doingFile = path.join(busDir, "doing", `${taskId}.md`);
    assert.ok(fs.existsSync(doingFile), "Task file should now be in bus/doing/");

    // 4. Move task to blocked
    const moveBlockedRes = updateBoardTask(tmpDir, amqRoot, taskId, { status: "blocked" }, { notify: false });
    assert.equal(moveBlockedRes.ok, true);

    assert.equal(fs.existsSync(doingFile), false, "Old doing file should be moved");
    const blockedFile = path.join(busDir, "blocked", `${taskId}.md`);
    assert.ok(fs.existsSync(blockedFile), "Task file should now be in bus/blocked/");

    // 5. Move task to done
    const moveDoneRes = updateBoardTask(tmpDir, amqRoot, taskId, { status: "done" }, { notify: false });
    assert.equal(moveDoneRes.ok, true);

    assert.equal(fs.existsSync(blockedFile), false, "Old blocked file should be moved");
    const doneFile = path.join(busDir, "done", `${taskId}.md`);
    assert.ok(fs.existsSync(doneFile), "Task file should now be in bus/done/");

    // 6. Delete task unlinks file
    const delRes = deleteBoardTask(tmpDir, amqRoot, taskId);
    assert.equal(delRes.ok, true);
    assert.equal(fs.existsSync(doneFile), false, "Task file should be unlinked upon deletion");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

