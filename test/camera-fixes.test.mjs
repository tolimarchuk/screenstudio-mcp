// The camera director: stray clicks, the opening line, zoom stretches and the
// notes it writes about them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planLayouts } from "../dist/studio/camera.js";

const line = (startMs, endMs, text = "a sentence that goes on for a while") => ({
  startMs,
  endMs,
  text,
  words: text.split(" ").length,
});
const click = (atMs) => ({ atMs, endMs: atMs + 80, x: 0.3, y: 0.4, drag: false, button: "left" });
const whole = (end, zooms = []) => ({
  slices: [{ sourceStartMs: 0, sourceEndMs: end, timeScale: 1 }],
  zooms,
});
const covers = (plan, t, type = "fullscreen-camera") =>
  plan.stretches.some((s) => s.type === type && s.sourceStartMs <= t && s.sourceEndMs >= t);

test("when the screen could not be read, every click counts and no bookend covers one", () => {
  const sentences = [line(500, 4000), line(10000, 14000), line(29000, 34000)];
  const a = {
    sourceDurationMs: 40000,
    hasCamera: true,
    clicks: [click(1500), click(30500)],
    speech: sentences,
    sentences,
    screen: { changes: [], active: [], unavailable: "ffmpeg not found" },
  };
  const plan = planLayouts(a, whole(40000));
  assert.ok(!covers(plan, 1500), JSON.stringify(plan.stretches));
  assert.ok(!covers(plan, 30500), JSON.stringify(plan.stretches));
  assert.ok(!plan.stretches.some((s) => /stray click/.test(s.reason)));

  // One session unread: a click there counts; one in a session read fine with no change is stray.
  const split = {
    ...a,
    screen: {
      changes: [],
      active: [],
      unavailable: "session 1: ffmpeg failed",
      unread: [{ startMs: 20000, endMs: 40000 }],
    },
  };
  const per = planLayouts(split, whole(40000));
  assert.ok(!covers(per, 30500), JSON.stringify(per.stretches));
  assert.ok(covers(per, 1500), JSON.stringify(per.stretches));
});

test("the opening never joins the sign-off across a click the viewer needs to see", () => {
  const sentences = [line(500, 12000), line(13000, 16000)];
  const a = {
    sourceDurationMs: 22000,
    hasCamera: true,
    clicks: [click(10000)],
    speech: sentences,
    sentences,
    screen: { changes: [{ atMs: 10100, score: 0.5, kind: "page" }], active: [] },
  };
  const plan = planLayouts(a, whole(22000));
  assert.ok(!covers(plan, 10000), JSON.stringify(plan.stretches));
  assert.ok(!covers(plan, 10050), JSON.stringify(plan.stretches));
});

test("the opening line stops at a long pause or typing, and never hides it", () => {
  const sentences = [line(500, 1000, "Hi."), line(19000, 21000), line(41000, 46000)];
  const a = {
    sourceDurationMs: 50000,
    hasCamera: true,
    clicks: [click(40000)],
    typing: [{ startMs: 3000, endMs: 18000, chars: 120, x: 0.5, y: 0.5 }],
    shortcuts: [],
    speech: sentences,
    sentences,
    screen: {
      changes: [
        { atMs: 3200, score: 0.2, kind: "region" },
        { atMs: 40200, score: 0.5, kind: "page" },
      ],
      active: [],
    },
  };
  const plan = planLayouts(a, whole(50000));
  for (const t of [3000, 10000, 17900])
    assert.ok(!covers(plan, t), `${t}: ${JSON.stringify(plan.stretches)}`);
  assert.ok(!plan.stretches.some((s) => /opening line \(2\d/.test(s.reason)));
  // Silence alone stops it too.
  const quiet = planLayouts(
    { ...a, typing: [], screen: { changes: [a.screen.changes[1]], active: [] } },
    whole(50000),
  );
  assert.ok(
    !quiet.stretches.some((s) => /for the opening line \(/.test(s.reason)),
    JSON.stringify(quiet.stretches),
  );
});

test("a click whose answer merged into a change just before it is not stray", () => {
  const sentences = [line(500, 4500), line(5000, 12000)];
  const base = {
    sourceDurationMs: 20000,
    hasCamera: true,
    clicks: [click(1500)],
    speech: sentences,
    sentences,
  };
  const merged = planLayouts(
    { ...base, screen: { changes: [{ atMs: 1400, score: 0.4, kind: "page" }], active: [] } },
    whole(20000),
  );
  assert.ok(!covers(merged, 1500), JSON.stringify(merged.stretches));
  assert.ok(!merged.stretches.some((s) => /stray click/.test(s.reason)));
  // Motion right after the click, under the change threshold, answers it too.
  const moving = planLayouts(
    { ...base, screen: { changes: [], active: [{ startMs: 1600, endMs: 2000 }] } },
    whole(20000),
  );
  assert.ok(!covers(moving, 1500), JSON.stringify(moving.stretches));
  // So does typing right after it (a field took focus).
  const typed = planLayouts(
    {
      ...base,
      typing: [{ startMs: 2200, endMs: 3000, chars: 8, x: 0.3, y: 0.4 }],
      screen: { changes: [], active: [] },
    },
    whole(20000),
  );
  assert.ok(!covers(typed, 1500), JSON.stringify(typed.stretches));
});

test("snapping a zoom's stretch inward never shrinks it below a layout change", () => {
  const sentences = [line(3000, 6400), line(6900, 9500), line(10000, 14000)];
  const a = { sourceDurationMs: 30000, hasCamera: true, clicks: [], speech: sentences, sentences };
  const plan = planLayouts(a, whole(30000, [{ sourceStartMs: 5000, sourceEndMs: 11000 }]), {
    bookends: false,
    splitScreen: false,
  });
  const only = plan.stretches.find((s) => s.type === "screen-only");
  assert.ok(only, JSON.stringify(plan));
  assert.ok(only.sourceEndMs - only.sourceStartMs >= 5000, JSON.stringify(only));
  assert.ok(only.sourceStartMs <= 5000 && only.sourceEndMs >= 11000, JSON.stringify(only));
});

test("the notes say when a layout change lands mid-sentence", () => {
  const sentences = [line(1000, 40000)];
  const a = {
    sourceDurationMs: 45000,
    hasCamera: true,
    clicks: [click(30000)],
    speech: sentences,
    sentences,
  };
  const plan = planLayouts(a, whole(45000, [{ sourceStartMs: 15000, sourceEndMs: 25000 }]), {
    bookends: false,
    splitScreen: false,
  });
  assert.ok(!plan.notes.some((n) => n.includes("never jolted mid-word")), plan.notes.join("\n"));
  assert.ok(
    plan.notes.some((n) => /except at 0:15, 0:25/.test(n)),
    plan.notes.join("\n"),
  );
  // With every edge in a pause, the promise stands.
  const calm = planLayouts(
    { ...a, sentences: [line(1000, 14000), line(16000, 24000), line(26000, 40000)] },
    whole(45000, [{ sourceStartMs: 15000, sourceEndMs: 25000 }]),
    { bookends: false, splitScreen: false },
  );
  assert.ok(
    calm.notes.some((n) => n.includes("never jolted mid-word")),
    calm.notes.join("\n"),
  );
});

test("notes fit short opening lines and recordings with no speech", () => {
  const sentences = [line(500, 1000, "Hi."), line(3000, 9000)];
  const a = {
    sourceDurationMs: 20000,
    hasCamera: true,
    clicks: [click(2000)],
    speech: sentences,
    sentences,
    screen: { changes: [{ atMs: 2100, score: 0.5, kind: "page" }], active: [] },
  };
  const plan = planLayouts(a, whole(20000));
  assert.ok(
    plan.notes.includes("No full-screen opening: the first line is under 2s."),
    plan.notes.join("\n"),
  );
  assert.ok(!plan.notes.some((n) => n.includes("runs over a click")));

  const silent = planLayouts(
    { sourceDurationMs: 30000, hasCamera: true, clicks: [], speech: [], sentences: [] },
    whole(30000, [{ sourceStartMs: 8000, sourceEndMs: 16000 }]),
  );
  const text = silent.notes.join("\n") + silent.stretches.map((s) => s.reason).join("\n");
  assert.ok(!text.includes("pauses between sentences around it"), text);
  assert.ok(!text.includes("in the pause after the sentence"), text);
  assert.ok(text.includes("no speech to follow"), text);
});
