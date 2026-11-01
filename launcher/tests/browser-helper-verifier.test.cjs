const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runBrowserHelperOperation, verifyConnectorWithBrowserHelper } = require("../electron/browser-helper-verifier.cjs");

test("scoped text operation forwards only the bounded text payload", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-helper-text-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "helper.cjs");
  fs.writeFileSync(script, `
    const input = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "ready" });
    input.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type !== "text") return;
      if (message.prompt !== "Translate five cues.") process.exit(2);
      if (message.effort !== "medium") process.exit(3);
      if (message.conversationKey !== "a".repeat(64)) process.exit(4);
      if (message.tools || message.environment_context || message.instructions) process.exit(5);
      send({ type: "result", id: message.id, value: { text: "{}" } });
    });
  `);
  const result = await runBrowserHelperOperation({
    helper: { executable: process.execPath, script },
    descriptorPath: "/runtime/launcher-browser.json",
    appName: "Vietsub",
    operation: "text",
    useTemporaryChats: false,
    payload: { prompt: "Translate five cues.", effort: "medium", conversationKey: "a".repeat(64) },
    logger: { info() {} },
  });
  assert.deepEqual(result.value, { text: "{}" });
});

test("scoped text operation stops its helper when the caller cancels", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-helper-cancel-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "helper.cjs");
  fs.writeFileSync(script, `
    const input = require("node:readline").createInterface({ input: process.stdin });
    process.stdout.write(JSON.stringify({ type: "ready" }) + "\\n");
    input.on("line", line => {
      if (JSON.parse(line).type === "shutdown") process.exit(0);
    });
  `);
  const controller = new AbortController();
  const pending = runBrowserHelperOperation({
    helper: { executable: process.execPath, script }, descriptorPath: "/runtime/launcher-browser.json",
    appName: "Vietsub", operation: "text", signal: controller.signal, logger: { info() {} },
  });
  setTimeout(() => controller.abort(new Error("caller stopped")), 20);
  await assert.rejects(pending, /caller stopped/);
});

test("scoped text operation forwards the bounded audit attachment", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-helper-attachment-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "helper.cjs");
  fs.writeFileSync(script, `
    const input = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "ready" });
    input.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type !== "text") return;
      if (message.attachment?.text !== "audit payload") process.exit(2);
      send({ type: "result", id: message.id, value: { text: "ok" } });
    });
  `);
  const result = await runBrowserHelperOperation({
    helper: { executable: process.execPath, script }, descriptorPath: "/runtime/launcher-browser.json",
    appName: "Vietsub", operation: "text", useTemporaryChats: false,
    payload: {
      prompt: "Audit.", effort: "medium", conversationKey: "a".repeat(64),
      attachment: { name: "longform-audit--0000000000000000.txt", text: "audit payload" },
    },
    logger: { info() {} },
  });
  assert.equal(result.value.text, "ok");
});

test("launcher verification delegates exact connector selection to the browser helper protocol", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-helper-verify-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "helper.cjs");
  fs.writeFileSync(script, `
    const input = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "ready" });
    input.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type !== "verify") return;
      if (message.config.appName !== "Codex Native2") process.exit(2);
      if (message.config.browserHostDescriptorPath !== "/runtime/launcher-browser.json") process.exit(3);
      send({ type: "result", id: message.id, text: message.config.appName });
    });
  `);

  const result = await verifyConnectorWithBrowserHelper({
    helper: { executable: process.execPath, script },
    descriptorPath: "/runtime/launcher-browser.json",
    appName: "Codex Native2",
    logger: { info() {} },
  });

  assert.deepEqual(result, { ok: true, appName: "Codex Native2" });
});

test("launcher verification consumes a helper input EOF after the result", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-helper-eof-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "helper.cjs");
  fs.writeFileSync(script, `
    const input = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "ready" });
    input.on("line", line => {
      const message = JSON.parse(line);
      if (message.type !== "verify") return;
      send({ type: "result", id: message.id, text: message.config.appName });
      process.stdin.destroy();
      setTimeout(() => process.exit(0), 100);
    });
  `);

  const result = await verifyConnectorWithBrowserHelper({
    helper: { executable: process.execPath, script },
    descriptorPath: "/runtime/launcher-browser.json",
    appName: "Codex Native2",
    logger: { info() {} },
  });

  assert.deepEqual(result, { ok: true, appName: "Codex Native2" });
});

test("launcher verification preserves the helper error class and correlation id", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-helper-error-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, "helper.cjs");
  fs.writeFileSync(script, `
    const input = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "ready" });
    input.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type !== "verify") return;
      send({
        type: "error",
        id: message.id,
        name: "ChatGptPersistentBrowserStateError",
        message: "connector proof cleanup failed",
      });
    });
  `);

  await assert.rejects(
    verifyConnectorWithBrowserHelper({
      helper: { executable: process.execPath, script },
      descriptorPath: "/runtime/launcher-browser.json",
      appName: "Codex Native2",
      logger: { info() {} },
    }),
    (error) => {
      assert.equal(error.name, "ChatGptPersistentBrowserStateError");
      assert.equal(error.message, "connector proof cleanup failed");
      assert.match(error.operationId, /^verify-[a-f0-9]{24}$/);
      return true;
    },
  );
});
