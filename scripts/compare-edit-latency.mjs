// Compare an installed build with this checkout in the same open editor.
// node scripts/compare-edit-latency.mjs /path/to/installed/package [--edit]
// --edit temporarily changes styling, restores it, and captures both results.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { Context } from "../dist/mcp/context.js";
import { register } from "../dist/mcp/tools/editor.js";

const baseline = resolve(process.argv[2]);
const load = (file) => import(pathToFileURL(resolve(baseline, file)).href);
const [{ Context: OldContext }, { register: oldRegister }] = await Promise.all([
  load("dist/mcp/context.js"),
  load("dist/mcp/tools/editor.js"),
]);
function harness(context, registerTools) {
  const tools = new Map();
  registerTools({ registerTool: (name, schema, handler) => tools.set(name, { schema, handler }) }, context);
  return {
    context,
    async call(name, args) {
      const tool = tools.get(name);
      const result = await tool.handler(z.object(tool.schema.inputSchema).parse(args), {
        signal: new AbortController().signal,
      });
      if (result.isError) throw new Error(result.content[0].text);
      const value = JSON.parse(result.content[0].text);
      if (value.partial) throw new Error(value.error);
      return value;
    },
  };
}
const current = harness(new Context(), register);
const old = harness(new OldContext(), oldRegister);
const projectPath = await current.context.editor.current();
const original = await current.context.editor.raw(projectPath);
assert.equal(original.playing, false, "Pause playback before measuring editing.");
assert.equal(original.editRunning, false, "Wait for the current edit to finish.");
const measurements = {
  settings: { old: [], new: [] },
  apply: { old: [], new: [] },
  review: { old: [], new: [] },
};
async function timed(samples, fn) {
  const start = performance.now();
  const value = await fn();
  samples.push(performance.now() - start);
  return value;
}
// Alternate order so a warm app does not always favor one build.
for (let i = 0; i < 8; i++) {
  for (const name of i % 2 ? ["new", "old"] : ["old", "new"]) {
    const result = await timed(measurements.settings[name], () =>
      name === "old"
        ? old.call("screenstudio_editor_state", { projectPath, includeConfig: true })
        : current.call("screenstudio_edit_context", { projectPath, analyze: false }),
    );
    assert.deepEqual(result.config, original.config);
  }
}

const get = (object, key) => key.split(".").reduce((o, k) => o[k], object);
const changes = {
  "styles.screenBorderRadius": original.config.styles.screenBorderRadius === 20 ? 18 : 20,
  "styles.background.color": original.config.styles.background.color === "#1e2824" ? "#17231d" : "#1e2824",
  "styles.shadow.intensity": original.config.styles.shadow.intensity === 0.45 ? 0.4 : 0.45,
  "styles.shadow.distance": original.config.styles.shadow.distance === 30 ? 25 : 30,
  "styles.shadow.blur": original.config.styles.shadow.blur === 24 ? 20 : 24,
  "cursor.size": original.config.cursor.size === 50 ? 48 : 50,
  "cursor.hideNotMovingAfterMs": original.config.cursor.hideNotMovingAfterMs === 1600 ? 1500 : 1600,
  "cursor.stopMovementInLastPartMs": original.config.cursor.stopMovementInLastPartMs === 900 ? 800 : 900,
  "animations.motionBlurAmount": original.config.animations.motionBlurAmount === 0.45 ? 0.5 : 0.45,
};
const expected = structuredClone(original.config);
for (const [key, value] of Object.entries(changes)) {
  const parts = key.split(".");
  const field = parts.pop();
  parts.reduce((o, k) => o[k], expected)[field] = value;
}
const frames = {};
let originalFrame;
let visiblePixelsChanged = false;
let ownedGeneration = original.editGeneration;
let restored = true;
if (process.argv.includes("--edit")) {
  originalFrame = await current.context.editor.frame(projectPath, original.playheadMs);
  try {
    for (let i = 0; i < 3; i++) {
      for (const name of i % 2 ? ["new", "old"] : ["old", "new"]) {
        const before = await current.context.editor.raw(projectPath);
        assert.equal(
          before.editGeneration,
          ownedGeneration,
          "The person changed the project; stop measuring.",
        );
        assert.deepEqual(before.config, original.config);
        assert.deepEqual(before.scenes, original.scenes);
        restored = false;
        const result = await timed(measurements.apply[name], () =>
          (name === "old" ? old : current).call("screenstudio_editor_apply", {
            projectPath,
            ops: [{ op: "config", changes }],
            save: false,
            ...(name === "new" ? { expectedGeneration: ownedGeneration } : {}),
          }),
        );
        assert.ok(result.pacing, "Both paths must retain their pacing check.");
        const after = await current.context.editor.raw(projectPath);
        ownedGeneration = after.editGeneration;
        assert.deepEqual(
          after.config,
          expected,
          "The complete config must match, including camera and crop.",
        );
        assert.deepEqual(after.scenes, original.scenes, "Cuts, zooms, layouts and masks must stay intact.");
        const frame = await timed(measurements.review[name], () =>
          current.context.editor.frame(projectPath, original.playheadMs),
        );
        frames[name] = frame.path;
        assert.ok(Math.abs(frame.playheadMs - original.playheadMs) <= 1);
        if (original.config.styles.background.type === "color") {
          assert.equal(
            frame.data.equals(originalFrame.data),
            false,
            "The preview did not redraw the changed background.",
          );
          visiblePixelsChanged = true;
        }
        console.log(
          JSON.stringify({
            trial: i + 1,
            build: name,
            applyMs: Math.round(measurements.apply[name].at(-1)),
            reviewMs: Math.round(measurements.review[name].at(-1)),
          }),
        );
        const undo = await current.context.editor.apply(
          projectPath,
          undefined,
          [
            {
              op: "config",
              changes: Object.fromEntries(
                Object.keys(changes).map((key) => [key, get(original.config, key)]),
              ),
            },
          ],
          undefined,
          { expectedGeneration: ownedGeneration },
        );
        assert.equal(undo.partial, undefined, undo.error);
        const reset = await current.context.editor.raw(projectPath);
        ownedGeneration = reset.editGeneration;
        assert.deepEqual(reset.config, original.config);
        assert.deepEqual(reset.scenes, original.scenes);
        restored = true;
      }
    }
  } finally {
    if (!restored) {
      // Restore only our values, preserving any newer manual adjustments.
      const state = await current.context.editor.raw(projectPath);
      const restore = Object.fromEntries(
        Object.entries(changes)
          .filter(([key, value]) => get(state.config, key) === value)
          .map(([key]) => [key, get(original.config, key)]),
      );
      if (Object.keys(restore).length) {
        const result = await current.context.editor.apply(
          projectPath,
          undefined,
          [{ op: "config", changes: restore }],
          undefined,
          { expectedGeneration: state.editGeneration },
        );
        assert.equal(result.partial, undefined, result.error);
      }
    }
  }
  const final = await current.context.editor.raw(projectPath);
  assert.deepEqual(final.config, original.config);
  assert.deepEqual(final.scenes, original.scenes);
  await current.context.editor.frame(projectPath, original.playheadMs);
  if (!original.dirty) await current.context.editor.save(projectPath);
}
function summary(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = sorted.length / 2;
  return {
    samples: values.map(Math.round),
    medianMs: Math.round(
      sorted.length % 2 ? sorted[Math.floor(middle)] : (sorted[middle - 1] + sorted[middle]) / 2,
    ),
    minMs: Math.round(sorted[0]),
    maxMs: Math.round(sorted.at(-1)),
  };
}
const results = {};
if (measurements.apply.old.length) {
  measurements.editAndReview = Object.fromEntries(
    ["old", "new"].map((name) => [
      name,
      measurements.apply[name].map((ms, i) => ms + measurements.review[name][i]),
    ]),
  );
}
for (const [stage, samples] of Object.entries(measurements)) {
  if (!samples.old.length) continue;
  results[stage] = { old: summary(samples.old), new: summary(samples.new) };
  results[stage].speedup = +(results[stage].old.medianMs / results[stage].new.medianMs).toFixed(2);
}
console.log(
  JSON.stringify(
    {
      baselineVersion: JSON.parse(await readFile(resolve(baseline, "package.json"), "utf8")).version,
      results,
      checks: {
        sameSettings: true,
        sameTimeline: true,
        restored: true,
        settingsChanged: process.argv.includes("--edit") ? Object.keys(changes).length : 0,
        visiblePixelsChanged,
      },
      frames,
    },
    null,
    2,
  ),
);
