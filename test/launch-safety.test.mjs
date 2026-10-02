import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, utimes, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopAction, systemShortcut } from "../dist/studio/desktop.js";
import { isAppPage } from "../dist/cdp/page-finder.js";
import { mainProcess } from "../dist/studio/service.js";
import { codexBlock, withoutTable } from "../dist/cli/codex.js";
import { pruneState } from "../dist/studio/util.js";

test("system shortcuts are never sent; ordinary shortcuts are", () => {
  for (const [key, modifiers] of [
    ["space", ["command"]],
    ["tab", ["command"]],
    ["q", ["command"]],
    ["escape", ["command", "option"]],
    ["q", ["control", "command"]],
  ]) {
    assert.ok(systemShortcut(key, modifiers), `${modifiers.join("+")}+${key}`);
    assert.equal(desktopAction.safeParse({ type: "key", key, modifiers }).success, false);
  }
  for (const [key, modifiers] of [
    ["k", ["command"]],
    ["s", ["command", "shift"]],
    ["space", []],
    ["tab", []],
  ])
    assert.equal(desktopAction.safeParse({ type: "key", key, modifiers }).success, true, `${key}`);
});

test("only Screen Studio's own bundled page counts as the app", () => {
  assert.ok(
    isAppPage("file:///Applications/Screen%20Studio.app/Contents/Resources/app.asar/dist/index.html"),
  );
  assert.ok(
    isAppPage(
      "file:///Users/me/Applications/Screen%20Studio.app/Contents/Resources/app.asar/dist/index.html",
    ),
  );
  assert.ok(!isAppPage("https://evil.example/app.asar/dist/index.html"));
  assert.ok(!isAppPage("http://127.0.0.1/Screen%20Studio.app/Contents/Resources/app.asar/dist/index.html"));
  assert.ok(!isAppPage("file:///tmp/app.asar/dist/index.html"));
});

test("the running app is found wherever macOS put it", () => {
  const ps = [
    "/usr/sbin/cfprefsd agent",
    "/Users/me/Applications/Screen Studio.app/Contents/MacOS/Screen Studio --remote-debugging-port=9333",
    "/Users/me/Applications/Screen Studio.app/Contents/Frameworks/Screen Studio Helper.app/Contents/MacOS/Screen Studio Helper --type=gpu",
  ].join("\n");
  assert.deepEqual(mainProcess(ps, "/Applications/Screen Studio.app"), { port: 9333 });
  assert.deepEqual(
    mainProcess(
      "/Applications/Screen Studio.app/Contents/MacOS/Screen Studio",
      "/Applications/Screen Studio.app",
    ),
    {
      port: null,
    },
  );
  assert.equal(mainProcess("/usr/bin/other", "/Applications/Screen Studio.app"), null);
});

test("installing into Codex replaces only its own server table", () => {
  const before = [
    'model = "x"',
    "",
    "[mcp_servers.other]",
    'command = "o"',
    "",
    "[mcp_servers.screenstudio]",
    'command = "old"',
    "",
    "[mcp_servers.screenstudio.env]",
    'A = "1"',
    "",
    "[profiles.fast]",
    'model = "y"',
  ].join("\n");
  const kept = withoutTable(before);
  assert.ok(kept.includes("[mcp_servers.other]") && kept.includes("[profiles.fast]"));
  assert.ok(!kept.includes("screenstudio"));
  const block = codexBlock({ command: "npx", args: ["-y", "screenstudio-mcp@1.2.3", "serve"] });
  assert.match(
    block,
    /^\[mcp_servers\.screenstudio\]\ncommand = "npx"\nargs = \["-y", "screenstudio-mcp@1\.2\.3", "serve"\]/,
  );
  assert.equal(withoutTable(`${kept}\n\n${block}`), kept);
});

test("old previews and checkpoints are pruned; caches stay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ssmcp-prune-"));
  const id = "0b9f3f2e-1c1a-4c55-9e0f-3d1a2b3c4d5e";
  const files = {
    "old.png": 2,
    "new.png": 0.5,
    [`editor-${id}.json`]: 8,
    [`export-${id}.json`]: 3,
    "voice-cache.json": 30,
  };
  const now = Date.now();
  for (const [name, days] of Object.entries(files)) {
    await writeFile(join(dir, name), "x");
    const t = new Date(now - days * 86_400_000);
    await utimes(join(dir, name), t, t);
  }
  await pruneState(dir, now);
  assert.deepEqual((await readdir(dir)).sort(), [`export-${id}.json`, "new.png", "voice-cache.json"].sort());
});
