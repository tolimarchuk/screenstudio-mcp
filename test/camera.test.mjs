// The camera director: layouts follow sentences, bookend the talk, clear the
// screen for zooms and keep the cutout camera away from the clicks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planLayouts } from "../dist/studio/camera.js";
import { checkLayouts } from "../dist/studio/pacing.js";
import { planEdit } from "../dist/studio/plan.js";
import { editOp, prepareOps } from "../dist/studio/editor/ops.js";

const click = (atMs, x, y = 0.5) => ({ atMs, endMs: atMs + 80, x, y, drag: false, button: "left" });
const phrase = (startMs, endMs, text) => ({ startMs, endMs, text, words: text.split(" ").length });

/**
 * An intro line, a long explanation over two clicks on the left, and a
 * sign-off. The explanation is one phrase of three sentences.
 */
const talk = {
  sourceDurationMs: 36000,
  clicks: [click(13000, 0.2), click(14500, 0.25)],
  speech: [
    phrase(500, 3300, "Hi, this is how we ship a release."),
    phrase(
      10000,
      20000,
      "Open the release page. Pick the build you want to ship from the list. Then hit publish.",
    ),
    phrase(30000, 34000, "That's it, thanks for watching."),
  ],
  sentences: [
    phrase(500, 3300, "Hi, this is how we ship a release."),
    phrase(10000, 11600, "Open the release page."),
    phrase(11800, 17000, "Pick the build you want to ship from the list."),
    phrase(17200, 20000, "Then hit publish."),
    phrase(30000, 34000, "That's it, thanks for watching."),
  ],
};
const edit = {
  slices: [{ sourceStartMs: 0, sourceEndMs: 36000, timeScale: 1 }],
  zooms: [{ sourceStartMs: 12500, sourceEndMs: 16500, zoom: 1.6 }],
};
const inside = (t, speech) => speech.some((p) => t > p.startMs && t < p.endMs);

test("full screen to open, cutout by default, screen only over the zoom, full screen to sign off", () => {
  const plan = planLayouts(talk, edit);
  assert.deepEqual(
    plan.stretches.map((s) => s.type),
    ["fullscreen-camera", "screen-only", "fullscreen-camera"],
  );
  const [open, zoom, signOff] = plan.stretches;
  assert.equal(open.sourceStartMs, 0);
  assert.ok(open.sourceEndMs >= 3300 && open.sourceEndMs < 10000);
  // Widened from the zoom to the pauses around its sentence, not to the whole phrase.
  assert.ok(zoom.sourceStartMs < 11800 && zoom.sourceStartMs > 11600, JSON.stringify(zoom));
  assert.ok(zoom.sourceEndMs > 17000 && zoom.sourceEndMs < 17200, JSON.stringify(zoom));
  // A real stretch of cutout camera between the opening and the zoom.
  assert.ok(zoom.sourceStartMs - open.sourceEndMs >= 6000);
  assert.ok(signOff.sourceStartMs <= 30000 && signOff.sourceEndMs === 36000);
  // The camera stands on the side away from the clicks.
  assert.equal(plan.side, 1);
  assert.equal(plan.config["defaultLayout.type"], "cutout-camera");
  assert.equal(plan.config["defaultLayout.cutoutCamera.cutoutCameraPositionX01"], 1);
  // Never mid-sentence, never churning.
  for (const s of plan.stretches) {
    assert.ok(!inside(s.sourceStartMs, talk.sentences), `starts mid-sentence at ${s.sourceStartMs}`);
    assert.ok(!inside(s.sourceEndMs, talk.sentences), `ends mid-sentence at ${s.sourceEndMs}`);
  }
  assert.deepEqual(checkLayouts(plan.stretches, edit.slices, talk.sentences), []);
  assert.ok(plan.notes.some((n) => /^0:00 cutout camera on the right \(clicks are on the left\)/.test(n)));
  assert.ok(plan.notes.some((n) => /^0:00 you full screen for the opening line \(2\.8s\)/.test(n)));
});

test("layout ops are valid editor ops that never overlap", () => {
  const plan = planLayouts(talk, edit, { config: { captions: { enableTranscript: true } } });
  for (const op of plan.ops) editOp.parse(op);
  const config = {
    defaultLayout: {
      type: "camera-overlay",
      cutoutCamera: {
        cutoutCameraPositionX01: 1,
        cutoutCameraSizeRatio01: 0.5,
        cutoutCameraZoomedScale: 0.8,
        cutoutCameraAspectRatio: null,
      },
    },
    camera: { enableFaceTracking: false, hideDuringSilenceMs: 2000, background: { edgeFalloff01: 0.2 } },
    captions: { enableTranscript: true, position01: { x: 0.5, y: 1 } },
  };
  prepareOps(plan.ops, {
    sourceMs: 36000,
    config,
    captureSize: { width: 1440, height: 900 },
    tracks: { layouts: [{ id: "old", sourceStartMs: 1000, sourceEndMs: 5000 }] },
  });
  assert.deepEqual(plan.config["captions.position01"], { x: 0.5, y: 0.93 });
});

test("the camera moves left when the clicks are on the right, and a LUT is toned down", () => {
  const plan = planLayouts({ ...talk, clicks: [click(13000, 0.8), click(14500, 0.9)] }, edit, {
    config: { camera: { lut: "warm", lutIntensity: 1 } },
  });
  assert.equal(plan.side, 0);
  assert.equal(plan.config["camera.lutIntensity"], 0.4);
  assert.equal(planLayouts(talk, edit, { side: 0 }).side, 0);
});

test("long talk with nothing to click gets a split screen; short stretches are dropped", () => {
  const plan = planLayouts(
    {
      sourceDurationMs: 60000,
      clicks: [click(50000, 0.3)],
      speech: [
        phrase(1000, 4000, "Welcome."),
        phrase(8000, 26000, "Let me explain the idea first, in detail."),
      ],
    },
    { slices: [{ sourceStartMs: 0, sourceEndMs: 60000, timeScale: 1 }], zooms: [] },
  );
  assert.ok(plan.stretches.some((s) => s.type === "split-screen" && s.sourceStartMs <= 8000));
  // A one-second zoom would flash the layout: no screen-only stretch for it.
  const short = planLayouts(talk, {
    slices: edit.slices,
    zooms: [{ sourceStartMs: 24000, sourceEndMs: 25000, zoom: 1.5 }],
  });
  assert.ok(!short.stretches.some((s) => s.type === "screen-only"));
  assert.ok(short.notes.some((n) => n.includes("too short for a layout change")));
});

test("no opening bookend when the first line runs over a click", () => {
  const plan = planLayouts({ ...talk, clicks: [click(2000, 0.2), ...talk.clicks] }, edit);
  assert.notEqual(plan.stretches[0].sourceStartMs, 0);
  assert.ok(plan.notes.some((n) => n.startsWith("No full-screen opening")));
});

test("planEdit with talkingHead plans layouts over its own cut and checks them", () => {
  const a = {
    projectPath: "/x.screenstudio",
    capture: { kind: "window", widthPt: 1440, heightPt: 900 },
    sessions: [{ startMs: 0, endMs: 36000, video: "" }],
    typing: [],
    shortcuts: [],
    movement: [],
    screen: { changes: [], active: [] },
    idle: [],
    ...talk,
  };
  const plan = planEdit(a, { talkingHead: true, tightenPausesMs: 350, speedUps: false });
  assert.ok(plan.layouts.stretches.length >= 2, JSON.stringify(plan.layouts));
  assert.ok(
    !plan.pacing.issues.some((i) => i.code.startsWith("layout-")),
    JSON.stringify(plan.pacing.issues),
  );
  assert.ok(plan.notes.some((n) => n.includes("cutout camera")));
});
