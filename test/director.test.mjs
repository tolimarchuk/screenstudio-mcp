// The camera director at its edges: changes inside cut silence, long timelines,
// bookends after a trimmed start, overlaps whose winner is dropped, short
// minStretchMs, the first and last moments, and recordings with no camera.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planLayouts } from "../dist/studio/camera.js";
import { checkLayouts } from "../dist/studio/pacing.js";

const click = (atMs, x, y = 0.5) => ({ atMs, endMs: atMs + 80, x, y, drag: false, button: "left" });
const phrase = (startMs, endMs, text = "a sentence that goes on for a while") => ({
  startMs,
  endMs,
  text,
  words: text.split(" ").length,
});
const whole = (end) => [{ sourceStartMs: 0, sourceEndMs: end, timeScale: 1 }];

test("layout changes inside cut silence still count", () => {
  const speech = [phrase(500, 3500), phrase(6000, 9000), phrase(12000, 15000), phrase(18000, 21000)];
  const slices = speech.map((p) => ({
    sourceStartMs: p.startMs - 150,
    sourceEndMs: p.endMs + 150,
    timeScale: 1,
  }));
  const issues = checkLayouts(
    [
      { sourceStartMs: 4000, sourceEndMs: 10000, type: "screen-only" },
      { sourceStartMs: 10500, sourceEndMs: 16000, type: "split-screen" },
    ],
    slices,
    speech,
  );
  assert.ok(
    issues.some((i) => i.code === "layout-churn"),
    JSON.stringify(issues),
  );
});

test("a long timeline with a zoom per click merges into one stretch", () => {
  const clicks = Array.from({ length: 250 }, (_, i) => click(2000 + i * 3000, 0.3));
  const end = 2000 + 250 * 3000 + 3000;
  const zooms = clicks.map((c) => ({ sourceStartMs: c.atMs - 300, sourceEndMs: c.atMs + 1500 }));
  const plan = planLayouts({ sourceDurationMs: end, clicks, speech: [] }, { slices: whole(end), zooms });
  assert.equal(plan.stretches.length, 1, JSON.stringify(plan.stretches.slice(0, 3)));
  assert.deepEqual(checkLayouts(plan.stretches, whole(end), []), []);
});

test("bookends follow the first and last lines still in the edit", () => {
  const a = {
    sourceDurationMs: 36000,
    clicks: [click(13000, 0.2)],
    speech: [phrase(500, 3300), phrase(8000, 11000), phrase(20000, 24000), phrase(30000, 34000)],
  };
  const plan = planLayouts(a, {
    slices: [{ sourceStartMs: 5000, sourceEndMs: 36000, timeScale: 1 }],
    zooms: [],
  });
  const open = plan.stretches[0];
  assert.equal(open.type, "fullscreen-camera", JSON.stringify(plan.stretches));
  assert.equal(open.sourceStartMs, 5000);
  assert.ok(open.sourceEndMs >= 11000 && open.sourceEndMs < 13000, JSON.stringify(open));
});

test("a stretch trimmed for a winner that is then dropped gets its range back", () => {
  const a = {
    sourceDurationMs: 36000,
    clicks: [click(13000, 0.2)],
    speech: [phrase(500, 4000), phrase(10000, 20000), phrase(30000, 34000)],
  };
  const plan = planLayouts(a, { slices: whole(36000), zooms: [{ sourceStartMs: 1000, sourceEndMs: 3000 }] });
  const open = plan.stretches.find((s) => s.sourceStartMs === 0);
  assert.ok(open && open.type === "fullscreen-camera", JSON.stringify(plan.stretches));
  assert.ok(open.sourceEndMs >= 4000, JSON.stringify(open));
});

test("minStretchMs under 5s never lets layouts churn", () => {
  const a = {
    sourceDurationMs: 40000,
    clicks: [click(7000, 0.2), click(16000, 0.2), click(30000, 0.2)],
    speech: [phrase(0, 3000), phrase(6000, 12000), phrase(15000, 21000), phrase(24000, 40000)],
  };
  const edit = {
    slices: whole(40000),
    zooms: [
      { sourceStartMs: 6500, sourceEndMs: 11000 },
      { sourceStartMs: 15500, sourceEndMs: 20000 },
    ],
  };
  const plan = planLayouts(a, edit, { minStretchMs: 2000 });
  assert.deepEqual(
    checkLayouts(plan.stretches, edit.slices, a.speech).filter((i) => i.code === "layout-churn"),
    [],
    JSON.stringify(plan.stretches),
  );
  assert.ok(plan.notes.at(-1).includes("at least 5.0s apart"), plan.notes.at(-1));
});

test("the default layout never flashes at the start or end of the video", () => {
  const a = {
    sourceDurationMs: 30000,
    clicks: [click(2500, 0.2), click(20000, 0.2)],
    speech: [phrase(0, 1500), phrase(2000, 12000), phrase(14000, 30000)],
  };
  const plan = planLayouts(a, { slices: whole(30000), zooms: [{ sourceStartMs: 3000, sourceEndMs: 9000 }] });
  assert.equal(plan.stretches[0].sourceStartMs, 0, JSON.stringify(plan.stretches));
});

test("a recording with no camera gets no layouts", () => {
  const plan = planLayouts(
    { sourceDurationMs: 30000, clicks: [click(5000, 0.2)], speech: [phrase(500, 4000)], hasCamera: false },
    { slices: whole(30000), zooms: [] },
  );
  assert.deepEqual(plan.ops, []);
  assert.deepEqual(plan.stretches, []);
  assert.match(plan.notes[0], /No camera in this recording/);
});

test("captions are lifted when the plan turns them on, not only when they are on now", () => {
  const a = { sourceDurationMs: 30000, clicks: [], speech: [phrase(500, 4000)] };
  const off = planLayouts(
    a,
    { slices: whole(30000), zooms: [] },
    { config: { captions: { enableTranscript: false } } },
  );
  assert.equal(off.config["captions.position01"], undefined);
  const on = planLayouts(
    a,
    { slices: whole(30000), zooms: [] },
    { config: { captions: { enableTranscript: false } }, captionsOn: true },
  );
  assert.deepEqual(on.config["captions.position01"], { x: 0.5, y: 0.93 });
});
