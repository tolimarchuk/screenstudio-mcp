// The MCP surface: config validation, argument shapes, tool annotations,
// status features and the native helper's keyboard layout lookup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { validateConfigChange } from "../dist/studio/project.js";
import { configPartial } from "../dist/studio/editor/ops.js";
import { desktopAction, helperArgs, helperTimeoutMs } from "../dist/studio/desktop.js";
import { span } from "../dist/mcp/tool.js";
import { features, presetPaths } from "../dist/mcp/tools/app.js";

const config = () => ({
  animations: {
    screenMovementSpring: { stiffness: 200, damping: 45, mass: 2.5, clamp: true, precision: 0.002 },
    motionBlurAmount: 0.5,
  },
  captions: { hiddenShortcuts: {} },
  styles: {
    screenBorderRadius: 14,
    screenInset: { size: 0, origin01: { x: 0, y: 0 }, alpha: 0.5, color: "#000000" },
    shadow: { intensity: 0.5, distance: 25, angle: 45, blur: 20, isDirectional: true },
    background: {
      type: "system",
      color: "#4776e6",
      gradient: {
        start: { x: 0, y: 0 },
        end: { x: 1, y: 1 },
        stops: [
          { color: "#4776e6", at: 0 },
          { color: "#8e54e9", at: 1 },
        ],
      },
      systemName: "Sunset/sunset-4.jpg",
      image: null,
      blur: 0,
    },
  },
});

test("a whole config group is refused instead of landing under an undefined field", () => {
  assert.throws(
    () => validateConfigChange(config(), "styles", { screenBorderRadius: 10 }),
    /one field inside/,
  );
  assert.throws(() => configPartial(config(), { animations: { screenMovementSpring: { stiffness: -5 } } }));
});

test("a parent key is merged field by field and every nested rule still applies", () => {
  const c = config();
  assert.throws(() => validateConfigChange(c, "styles.shadow", { intensity: 99 }));
  assert.throws(() => validateConfigChange(c, "styles.shadow", { distance: -1e9 }));
  assert.throws(() => validateConfigChange(c, "styles.background", { type: "plaid" }));
  assert.throws(() => validateConfigChange(c, "styles.shadow", { glow: 1 }), /Unknown config field/);
  assert.throws(() => validateConfigChange(c, "styles.shadow", 3), /expects object/);
  const shadow = validateConfigChange(c, "styles.shadow", { intensity: 0.4 });
  assert.deepEqual(shadow, { ...c.styles.shadow, intensity: 0.4 });
  // An empty object changes nothing rather than emptying the group.
  assert.deepEqual(validateConfigChange(c, "styles.background", {}), c.styles.background);
  const p = configPartial(c, { "styles.shadow": { distance: 40 } });
  assert.equal(p.styles.shadow.distance, 40);
  assert.equal(p.styles.shadow.isDirectional, true);
});

test("fields inside a ruled object are checked by that object's rule", () => {
  const c = config();
  assert.throws(() => validateConfigChange(c, "animations.screenMovementSpring.stiffness", -5));
  assert.equal(validateConfigChange(c, "animations.screenMovementSpring.stiffness", 300), 300);
  assert.throws(() =>
    validateConfigChange(c, "styles.background.gradient.stops", [
      { color: "red", at: 0 },
      { color: "#000000", at: 1 },
    ]),
  );
  const p = configPartial(c, { "styles.background.gradient.end": { x: 1, y: 0 } });
  assert.deepEqual(p.styles.background.gradient.end, { x: 1, y: 0 });
  assert.equal(p.styles.background.gradient.stops.length, 2);
});

test("background gradients, inset origins and hidden shortcuts have exact rules", () => {
  const c = config();
  const gradient = {
    start: { x: 0, y: 0 },
    end: { x: 1, y: 1 },
    stops: [
      { color: "#ff7a59", at: 0 },
      { color: "#7b2ff7", at: 1 },
    ],
  };
  assert.deepEqual(validateConfigChange(c, "styles.background.gradient", gradient), gradient);
  assert.throws(() => validateConfigChange(c, "styles.background.gradient", {}));
  assert.throws(
    () =>
      validateConfigChange(c, "styles.background.gradient", {
        ...gradient,
        stops: [...gradient.stops].reverse(),
      }),
    /in order/,
  );
  assert.throws(() =>
    validateConfigChange(c, "styles.background.gradient", { ...gradient, stops: [gradient.stops[0]] }),
  );
  assert.throws(() => validateConfigChange(c, "styles.screenInset.origin01", { x: 2, y: 0 }));
  assert.deepEqual(validateConfigChange(c, "captions.hiddenShortcuts", { "cmd+tab": true }), {
    "cmd+tab": true,
  });
  assert.throws(() => validateConfigChange(c, "captions.hiddenShortcuts", { "cmd+tab": "yes" }));
});

test("a null field with no known shape takes plain values only", () => {
  assert.throws(
    () => validateConfigChange(config(), "styles.background.image", { path: "/x.png" }),
    /no known shape/,
  );
  assert.equal(validateConfigChange(config(), "styles.background.image", null), null);
});

test("keep and drop spans must end after they start", () => {
  assert.ok(span.safeParse({ startMs: 0, endMs: 1000 }).success);
  assert.ok(!span.safeParse({ startMs: 12000, endMs: 8000 }).success);
  assert.ok(!span.safeParse({ startMs: 5000, endMs: 5000 }).success);
});

test("scroll can aim at a point in the window, and typing gets time for its length", () => {
  assert.deepEqual(helperArgs({ type: "scroll", lines: -3 }), ["-3"]);
  assert.deepEqual(helperArgs({ type: "scroll", lines: 5, x: 200, y: 300 }), ["5", "200", "300"]);
  assert.ok(desktopAction.safeParse({ type: "scroll", lines: 5, x: 200, y: 300 }).success);
  assert.ok(!desktopAction.safeParse({ type: "scroll", lines: 5, x: 200 }).success);
  assert.equal(helperTimeoutMs({ type: "click", x: 1, y: 1 }, 3), 80000);
  assert.equal(helperTimeoutMs({ type: "type", text: "hi" }, 1), 80000);
  const long = { type: "type", text: "x".repeat(2000) };
  // Worst case per character is about 25ms + 190ms x pace.
  for (const pace of [0.5, 1, 3]) assert.ok(helperTimeoutMs(long, pace) > 2000 * (25 + 190 * pace));
});

test("status reports the editing features this server has", () => {
  assert.equal(features.maskEditing, true);
  assert.equal(features.layoutTimelineEditing, true);
  assert.equal(features.transcriptGeneration, true);
  assert.equal(features.voiceoverGeneration, false);
});

test("a preset can only be applied by a path the presets list returned", () => {
  const paths = presetPaths([{ name: "Brand", path: "/p/brand.json" }, { path: "/p/dark.json" }]);
  assert.ok(paths.has("/p/brand.json") && paths.has("/p/dark.json"));
  assert.ok(!paths.has("/p/other.json"));
});

test("tools that discard work or go online say so", async () => {
  const client = new Client({ name: "annotations", version: "1" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: ["dist/mcp/main.js"], stderr: "pipe" }),
  );
  try {
    const { tools } = await client.listTools();
    const hints = (name) => tools.find((t) => t.name === name).annotations;
    assert.equal(hints("screenstudio_record_control").destructiveHint, true);
    assert.equal(hints("screenstudio_narrate").openWorldHint, true);
    assert.equal(hints("screenstudio_transcript_generate").openWorldHint, true);
    assert.equal(hints("screenstudio_music").destructiveHint, false);
  } finally {
    await client.close();
  }
});

const helper = new URL("../native/desktop-helper", import.meta.url).pathname;
const nativeReady =
  process.platform === "darwin" &&
  (await access(helper).then(
    () => true,
    () => false,
  ));

test("shortcuts follow the keyboard layout, not US key positions", { skip: !nativeReady }, async () => {
  const run = promisify(execFile);
  const resolve = async (...args) => JSON.parse((await run(helper, ["resolve-key", ...args])).stdout);
  // On AZERTY the US "a" and "z" positions are Q and W: Cmd+A by position would quit the app.
  assert.deepEqual(await resolve("a", "command", "com.apple.keylayout.French"), {
    keyCode: 12,
    modifiers: ["command"],
  });
  assert.equal((await resolve("z", "command", "com.apple.keylayout.French")).keyCode, 13);
  // Digits need Shift on AZERTY.
  assert.deepEqual(await resolve("1", "", "com.apple.keylayout.French"), {
    keyCode: 18,
    modifiers: ["shift"],
  });
  // QWERTZ swaps z and y, so undo would become redo.
  assert.equal((await resolve("z", "command", "com.apple.keylayout.German")).keyCode, 16);
  assert.equal((await resolve("z", "command", "com.apple.keylayout.US")).keyCode, 6);
  assert.equal((await resolve("return")).keyCode, 36);
  await assert.rejects(
    run(helper, ["resolve-key", "z", "", "com.apple.keylayout.Russian"]),
    /not on the current/,
  );
});
