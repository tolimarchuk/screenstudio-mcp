// Planner fixes before launch: recordings with nothing to act on, phone-shaped
// captures in vertical frames, zoom levels in any order, speed caps, zoom rates
// of zero, and recipe defaults that fit their own length.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planEdit } from "../dist/studio/plan.js";
import { RECIPES, RECIPE_NAMES, recipeNotes } from "../dist/studio/recipes.js";
import { TARGETS, planLoop, variantProject } from "../dist/studio/deliver.js";
import { recipeForCheck } from "../dist/mcp/tools/plan.js";

const click = (atMs, x = 0.5, y = 0.5) => ({ atMs, endMs: atMs + 80, x, y, drag: false, button: "left" });

function recording(over = {}) {
  return {
    projectPath: "/x.screenstudio",
    sourceDurationMs: 60000,
    capture: { kind: "window", widthPt: 1440, heightPt: 900 },
    sessions: [{ startMs: 0, endMs: 60000, video: "" }],
    clicks: [click(5000, 0.2, 0.3), click(7000, 0.25, 0.32), click(24000, 0.7, 0.6), click(45000, 0.5, 0.8)],
    typing: [{ startMs: 25000, endMs: 30000, chars: 60, x: 0.7, y: 0.6 }],
    shortcuts: [],
    movement: [],
    screen: {
      changes: [{ atMs: 45300, score: 0.6, kind: "page" }],
      active: [{ startMs: 45200, endMs: 50500 }],
    },
    idle: [
      { startMs: 0, endMs: 4800 },
      { startMs: 9000, endMs: 23800 },
      { startMs: 31000, endMs: 44800 },
      { startMs: 50600, endMs: 59500 },
    ],
    ...over,
  };
}

const empty = () =>
  recording({
    sourceDurationMs: 20000,
    sessions: [{ startMs: 0, endMs: 20000, video: "" }],
    clicks: [],
    typing: [],
    screen: { changes: [], active: [] },
    idle: [{ startMs: 0, endMs: 20000 }],
  });

test("a recording with no actions plans without crashing and keeps the footage", () => {
  const plan = planEdit(empty());
  assert.deepEqual(plan.beats, []);
  assert.ok(plan.slices.length > 0, plan.summary);
  assert.ok(plan.pacing.playbackMs > 0);
  assert.equal(plan.zooms.length, 0);
  // Fitting it to a length has nothing to drop and says so instead of throwing.
  const fit = planEdit(empty(), { targetMs: 5000 });
  assert.equal(fit.fit.fitted, false);
  assert.deepEqual(fit.droppedBeats, []);
});

test("a loop of a recording with no actions fails with the friendly message", async () => {
  await assert.rejects(
    planLoop(empty(), {}, async () => {
      throw new Error("never asked to match frames");
    }),
    /no actions to loop/,
  );
});

const project = (crop) => ({
  version: 8,
  config: {
    output: { aspectRatio: 16 / 9, paddingRatio01: 0.08, avoidEmptyZoomArea: false },
    ...(crop ? { crop: { rect01: crop } } : {}),
    defaultLayout: {
      type: "camera-overlay",
      cutoutCamera: {
        cutoutCameraPositionX01: 0.5,
        cutoutCameraSizeRatio01: 1,
        cutoutCameraZoomedScale: 0.5,
      },
    },
    cursor: { size: 48 },
  },
  scenes: [
    {
      id: "s",
      slices: [
        { id: "a", sourceStartMs: 0, sourceEndMs: 10000, timeScale: 1 },
        { id: "b", sourceStartMs: 14000, sourceEndMs: 30000, timeScale: 1 },
      ],
      zooms: [],
    },
  ],
});

const planned = [
  {
    sourceStartMs: 16000,
    sourceEndMs: 21000,
    zoom: 2.2,
    follow: false,
    target: { x: 0.6, y: 0.4 },
    reason: "",
  },
];

test("a phone-shaped capture in a shorts frame gets no action or fill zooms", () => {
  const phone = { widthPt: 390, heightPt: 844 };
  const v = variantProject(project(), "shorts", TARGETS.shorts, { capture: phone, verticalZooms: planned });
  assert.deepEqual(v.project.scenes[0].zooms, []);
  assert.match(v.notes.join(" "), /already fills the 9:16 frame/);
  assert.ok(!/Added \d+ fixed zoom/.test(v.notes.join(" ")));

  // A wide capture cropped to a phone's shape fills the frame too.
  const cropped = variantProject(
    project({ x: 0.35, y: 0, width: 0.3, height: 1 }),
    "shorts",
    TARGETS.shorts,
    {
      capture: { widthPt: 1440, heightPt: 900 },
      verticalZooms: planned,
    },
  );
  assert.deepEqual(cropped.project.scenes[0].zooms, []);

  // A wide capture still gets both.
  const wide = variantProject(project(), "shorts", TARGETS.shorts, {
    capture: { widthPt: 1440, heightPt: 900 },
    verticalZooms: planned,
  });
  assert.ok(wide.project.scenes[0].zooms.some((z) => z.type === "manual"));
  assert.ok(wide.project.scenes[0].zooms.some((z) => z.type === "follow-click-groups"));
});

test("an unknown capture size adds no fill zooms rather than guessing 16:9", () => {
  const v = variantProject(project(), "portrait", TARGETS.portrait, {});
  assert.deepEqual(v.project.scenes[0].zooms, []);
  assert.match(v.notes.join(" "), /size is unknown/);
});

test("zoom levels in ascending order still choose the deepest level that fits", () => {
  const down = planEdit(recording(), { rules: { zoomLevels: [2, 1.5, 1.25] } });
  const up = planEdit(recording(), { rules: { zoomLevels: [1.25, 1.5, 2] } });
  assert.ok(down.zooms.length > 0);
  assert.deepEqual(
    up.zooms.map((z) => z.zoom),
    down.zooms.map((z) => z.zoom),
  );
  assert.ok(
    up.zooms.some((z) => z.zoom === 2),
    JSON.stringify(up.zooms),
  );
});

test("speeds never exceed the style's caps, nor 4x", () => {
  const a = recording({
    typing: [{ startMs: 25000, endMs: 33000, chars: 120, x: 0.7, y: 0.6 }],
    screen: {
      changes: [{ atMs: 45300, score: 0.6, kind: "page" }],
      active: [{ startMs: 45200, endMs: 56000 }],
    },
  });
  const capped = (plan, typing, wait) => {
    for (const s of plan.slices) {
      const cap = s.reason.startsWith("typing") ? typing : s.reason.startsWith("waiting") ? wait : 1;
      assert.ok(s.speed <= cap, `${s.reason} at ${s.speed}x over ${cap}x`);
      assert.ok(s.speed <= 4);
    }
  };
  for (const targetMs of [undefined, 12000]) {
    capped(planEdit(a, { rules: { typingSpeed: 1.4, waitSpeed: 1.6 }, targetMs }), 1.4, 1.6);
    capped(planEdit(a, { rules: { typingSpeed: 8, waitSpeed: 8 }, targetMs }), 4, 4);
  }
});

test("zoomsPerMinute 0 means no zooms", () => {
  const plan = planEdit(recording(), { rules: { zoomsPerMinute: 0 } });
  assert.equal(plan.zooms.length, 0);
  assert.ok(planEdit(recording()).zooms.length > 0);
});

test("recipe default targets fit the recipe's length", () => {
  for (const name of RECIPE_NAMES) {
    const r = RECIPES[name];
    for (const t of r.targets) {
      const { maxMs } = TARGETS[t];
      if (maxMs === undefined) continue;
      // Fit-to-length allows 5% over the target.
      if (r.plan.targetMs) assert.ok(maxMs >= r.plan.targetMs * 1.05, `${name}: ${t}`);
      else assert.ok(maxMs >= 60000, `${name}: ${t} (${maxMs}ms) is shorter than an unfitted edit`);
    }
  }
  for (const name of ["changelog", "docs-walkthrough"])
    assert.match(recipeNotes(RECIPES[name]).join(" "), /screenstudio_loop/, name);
});

test("a brand without a recipe is refused when checking", async () => {
  await assert.rejects(recipeForCheck({}, { brand: "acme" }), /brand needs a recipe/);
});
