// Pure helpers behind the planner, the editor and desktop input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { mergeSpans, subtractSpans, overlaps } from "../dist/studio/spans.js";
import { prepareOps } from "../dist/studio/editor/ops.js";
import { helperArgs } from "../dist/studio/desktop.js";
import { RESOURCES } from "../dist/mcp/resources.js";

test("spans merge across small gaps and subtract cuts", () => {
  const merged = mergeSpans(
    [
      { startMs: 500, endMs: 900 },
      { startMs: 0, endMs: 300 },
      { startMs: 1500, endMs: 1600 },
    ],
    200,
  );
  assert.deepEqual(merged, [
    { startMs: 0, endMs: 900 },
    { startMs: 1500, endMs: 1600 },
  ]);
  const cut = subtractSpans(
    [{ startMs: 0, endMs: 10000 }],
    [
      { startMs: 2000, endMs: 3000 },
      { startMs: 9800, endMs: 12000 },
    ],
    400,
  );
  assert.deepEqual(cut, [
    { startMs: 0, endMs: 2000 },
    { startMs: 3000, endMs: 9800 },
  ]);
  assert.deepEqual(subtractSpans([{ startMs: 0, endMs: 1000 }], [{ startMs: 900, endMs: 2000 }], 400), [
    { startMs: 0, endMs: 900 },
  ]);
  assert.ok(overlaps({ startMs: 5, endMs: 10 }, [{ startMs: 9, endMs: 20 }]));
  assert.ok(!overlaps({ startMs: 5, endMs: 10 }, [{ startMs: 10, endMs: 20 }]));
});

test("ops are checked against the recording before anything is applied", () => {
  const scene = {
    sourceMs: 10000,
    config: { cursor: { size: 48 } },
    captureSize: { width: 1000, height: 500 },
  };
  const [mask, config] = prepareOps(
    [
      {
        op: "addMask",
        startMs: 0,
        endMs: 2000,
        type: "sensitive-data",
        rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.5 }],
      },
      { op: "config", changes: { "cursor.size": 56 } },
    ],
    scene,
  );
  assert.deepEqual(mask.bounds, [{ x: 100, y: 100, width: 500, height: 250 }]);
  assert.deepEqual(config, { op: "config", partial: { cursor: { size: 56 } } });
  assert.throws(
    () =>
      prepareOps([{ op: "addZoom", startMs: 0, endMs: 20000, zoom: 1.5, target: { x: 0.5, y: 0.5 } }], scene),
    /inside the recording/,
  );
  assert.throws(
    () =>
      prepareOps(
        [
          {
            op: "setSlices",
            slices: [
              { startMs: 5000, endMs: 6000, speed: 1 },
              { startMs: 0, endMs: 1000, speed: 1 },
            ],
          },
        ],
        scene,
      ),
    /in order/,
  );
  assert.throws(
    () => prepareOps([{ op: "updateItem", track: "zooms", id: "a", fields: { id: "b" } }], scene),
    /prototypes/,
  );
});

test("desktop actions map to the native helper's arguments", () => {
  assert.deepEqual(helperArgs({ type: "click", x: 10, y: 20 }), ["10", "20"]);
  assert.deepEqual(helperArgs({ type: "drag", x: 1, y: 2, toX: 3, toY: 4 }), ["1", "2", "3", "4"]);
  assert.deepEqual(helperArgs({ type: "key", key: "k", modifiers: ["command", "shift"] }), [
    "k",
    "command,shift",
  ]);
  assert.deepEqual(helperArgs({ type: "key", key: "return" }), ["return"]);
  assert.deepEqual(helperArgs({ type: "focus" }), []);
});

test("every guidance resource ships with the package", async () => {
  const { files } = JSON.parse(await readFile("package.json", "utf8"));
  for (const path of [...Object.values(RESOURCES), "skills/screenstudio/SKILL.md"]) {
    await access(path);
    assert.ok(
      files.some((f) => (f.endsWith("/") ? path.startsWith(f) : path === f)),
      path,
    );
  }
});
