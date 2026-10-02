// The planner as a story editor: beats scored and given roles, fit to a target
// length, markers that start beats, retakes and chapters, and director's notes
// that explain every decision in playback time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planEdit } from "../dist/studio/plan.js";
import { checkLayouts, checkPacing, clock } from "../dist/studio/pacing.js";
import { sameWords } from "../dist/studio/beats.js";

const click = (atMs, x = 0.5, y = 0.5) => ({ atMs, endMs: atMs + 80, x, y, drag: false, button: "left" });

/** Three beats with dead air between them and a slow page load after the last click. */
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

const inSlices = (plan, t) => plan.slices.some((s) => t >= s.startMs && t <= s.endMs);
const speedAt = (plan, t) => plan.slices.find((s) => t >= s.startMs && t <= s.endMs)?.speed;

test("beats carry a score, a story role and a label", () => {
  const plan = planEdit(recording());
  assert.deepEqual(
    plan.beats.map((b) => [b.role, b.score, b.kept]),
    [
      ["setup", 3, true],
      ["demo", 4, true],
      ["payoff", 8, true],
    ],
  );
  assert.match(plan.beats[2].label, /click at \(0\.50, 0\.80\), page changes/);
  assert.deepEqual(plan.droppedBeats, []);
  assert.equal(plan.fit, undefined);
});

test("fit to length drops the lowest-value beats and keeps the payoff", () => {
  const plan = planEdit(recording(), { targetMs: 12000 });
  assert.ok(plan.pacing.playbackMs <= 12600, String(plan.pacing.playbackMs));
  assert.equal(plan.fit.fitted, true);
  assert.ok(inSlices(plan, 45000), "the payoff click is kept");
  assert.ok(plan.beats.find((b) => b.role === "payoff").kept);
  for (const c of [5000, 7000, 24000, 45000]) if (inSlices(plan, c)) assert.ok(speedAt(plan, c) <= 1.5);
  assert.ok(plan.droppedBeats.length > 0);
  for (const d of plan.droppedBeats) assert.match(d.reason, /lowest value \(score \d+/);
  // The setup beat, worth least, goes first.
  assert.equal(plan.droppedBeats[0].sourceStartMs, 5000);
  assert.ok(!inSlices(plan, 5000));
  assert.ok(plan.notes[0].startsWith("Fits 12.0s"), plan.notes[0]);
});

test("fit to length speeds up typing and waiting before dropping a beat that would fit that way", () => {
  // Without the setup beat the edit runs about 13.8s; faster waiting and shorter holds get it under 13.5s.
  const a = recording({ clicks: recording().clicks.slice(2) });
  const loose = planEdit(a);
  const plan = planEdit(a, { targetMs: 12900 });
  assert.ok(loose.pacing.playbackMs > 12900 * 1.05, String(loose.pacing.playbackMs));
  assert.deepEqual(plan.droppedBeats, []);
  assert.equal(plan.fit.fitted, true);
  assert.ok(plan.pacing.playbackMs < loose.pacing.playbackMs);
  assert.match(plan.fit && plan.notes[0], /holds shortened/);
});

test("a target that cannot be met is reported with the overshoot, never by dropping kept beats", () => {
  const plan = planEdit(recording(), { targetMs: 5000, keep: [{ startMs: 24000, endMs: 30000 }] });
  assert.equal(plan.fit.fitted, false);
  assert.ok(plan.fit.overshootMs > 0);
  assert.ok(inSlices(plan, 24000) && inSlices(plan, 45000));
  assert.match(plan.notes[0], /^Runs .* over 5\.0s/);
});

test("hook-demo-payoff suggests a cold open on the payoff's settled result, inside the kept footage", () => {
  const plan = planEdit(recording(), { structure: "hook-demo-payoff" });
  assert.equal(plan.beats.at(-1).role, "payoff");
  const { coldOpen } = plan;
  assert.ok(coldOpen, "a cold open");
  assert.ok(coldOpen.sourceStartMs >= 45300, "after the page change");
  // Inside one stretch of kept footage (neighbouring slices at different speeds join up).
  const pieces = [];
  for (const s of plan.slices)
    if (pieces.length && s.startMs - pieces.at(-1).endMs <= 1) pieces.at(-1).endMs = s.endMs;
    else pieces.push({ startMs: s.startMs, endMs: s.endMs });
  assert.ok(
    pieces.some((p) => coldOpen.sourceStartMs >= p.startMs && coldOpen.sourceEndMs <= p.endMs),
    JSON.stringify({ coldOpen, pieces }),
  );
  assert.equal(coldOpen.sourceEndMs - coldOpen.sourceStartMs, 1800);
  // Slices stay in source order: the cold open is a suggestion, not a reorder.
  for (let i = 1; i < plan.slices.length; i++) assert.ok(plan.slices[i].startMs >= plan.slices[i - 1].endMs);
  // The setup beat's lead-in is halved.
  const linear = planEdit(recording());
  assert.ok(plan.slices[0].startMs >= linear.slices[0].startMs);
});

test("director's notes explain cuts, speed-ups, zooms and the ending in playback time", () => {
  const plan = planEdit(recording());
  const timed = plan.notes.filter((n) => /^\d+:\d\d /.test(n));
  assert.ok(timed.length >= 6, plan.notes.join("\n"));
  const text = plan.notes.join("\n");
  for (const want of ["opens on the starting screen", "cut ", "plays at", "zoom 1.", "holds the end"])
    assert.ok(text.includes(want), want);
  // In playback order.
  const times = timed.map((n) =>
    n
      .split(" ")[0]
      .split(":")
      .reduce((m, s) => m * 60 + Number(s), 0),
  );
  for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1], timed.join("\n"));
  // Every sped-up stretch is explained.
  assert.equal(
    timed.filter((n) => n.includes(" plays at ")).length,
    plan.slices.filter((s) => s.speed > 1).length,
  );
  assert.equal(clock(61400), "1:01");
});

test("rule overrides change the plan and the check that judges it", () => {
  const plan = planEdit(recording(), { rules: { zoomLevels: [1.4, 1.25] } });
  assert.ok(plan.zooms.length > 0);
  for (const z of plan.zooms) assert.ok(z.zoom <= 1.4, String(z.zoom));
  assert.equal(plan.pacing.issues.filter((i) => i.severity === "error").length, 0);
});

// ---------------------------------------------------------------- markers

test("a marker starts a new beat and keeps the moment after it", () => {
  const a = recording({
    clicks: [click(5000), click(6500), click(24000), click(45000)],
    markers: [
      { id: "m1", sourceMs: 6400 },
      { id: "m2", sourceMs: 15000 },
    ],
  });
  const plain = planEdit(a, { markers: "ignore" });
  const marked = planEdit(a);
  assert.equal(plain.beats.length, 3);
  assert.equal(marked.beats.length, 4);
  assert.equal(marked.beats[1].marker, "m1");
  assert.ok(!inSlices(plain, 15500), "dead air without a marker is cut");
  assert.ok(inSlices(marked, 15000) && inSlices(marked, 16400), JSON.stringify(marked.slices));
  assert.ok(marked.notes.some((n) => n.includes("2 markers start beats")));
});

test("marked beats are not dropped to fit a length in keep mode", () => {
  const a = recording({ markers: [{ id: "m1", sourceMs: 4800 }] });
  const keep = planEdit(a, { targetMs: 9000 });
  assert.ok(!keep.droppedBeats.some((d) => d.sourceStartMs === 5000));
  const chapters = planEdit(a, { targetMs: 9000, markers: "chapters" });
  assert.ok(chapters.droppedBeats.some((d) => d.sourceStartMs === 5000));
});

test("retake mode drops the take before a marker when the line is said again", () => {
  const a = recording({
    sourceDurationMs: 30000,
    sessions: [{ startMs: 0, endMs: 30000, video: "" }],
    clicks: [click(3000, 0.3, 0.3), click(13000, 0.3, 0.3), click(22000, 0.6, 0.6)],
    typing: [],
    screen: { changes: [], active: [] },
    idle: [],
    speech: [
      { startMs: 1500, endMs: 5000, text: "Now open the settings and pick a theme.", words: 8 },
      { startMs: 11500, endMs: 15000, text: "Now open the settings, and pick a theme.", words: 8 },
      { startMs: 20000, endMs: 24000, text: "That is all it takes.", words: 5 },
    ],
    markers: [
      { id: "take-1", sourceMs: 1000 },
      { id: "take-2", sourceMs: 11000 },
      { id: "end", sourceMs: 19500 },
    ],
  });
  const plan = planEdit(a, { markers: "retake" });
  const retake = plan.droppedBeats.find((d) => d.reason.startsWith("retake"));
  assert.ok(retake, JSON.stringify(plan.droppedBeats));
  assert.equal(retake.sourceStartMs, 1500);
  assert.ok(!inSlices(plan, 3000), JSON.stringify(plan.slices));
  assert.ok(inSlices(plan, 13000) && inSlices(plan, 22000));
  assert.ok(
    sameWords("Now open the settings and pick a theme.", "now OPEN the settings, and pick a theme") >= 0.99,
  );
  assert.equal(sameWords("Click the button.", "Something else entirely here."), 0);
});

test("chapters mode numbers each beat by the marker before it", () => {
  const a = recording({
    markers: [
      { id: "intro", sourceMs: 4500 },
      { id: "type", sourceMs: 23500 },
      { id: "ship", sourceMs: 44500 },
    ],
  });
  const plan = planEdit(a, { markers: "chapters" });
  assert.deepEqual(
    plan.beats.map((b) => b.chapter),
    [1, 2, 3],
  );
  assert.equal(plan.notes.filter((n) => / chapter \d starts/.test(n)).length, 3);
});

// ---------------------------------------------------------------- layout checks

test("layout checks catch churn and changes inside a sentence", () => {
  const slices = [{ sourceStartMs: 0, sourceEndMs: 40000, timeScale: 1 }];
  const speech = [{ startMs: 10000, endMs: 16000, text: "This sentence keeps going." }];
  const issues = checkLayouts(
    [
      { sourceStartMs: 2000, sourceEndMs: 5000, type: "screen-only" },
      { sourceStartMs: 12000, sourceEndMs: 30000, type: "split-screen" },
    ],
    slices,
    speech,
  );
  const codes = issues.map((i) => i.code);
  assert.ok(codes.includes("layout-churn"));
  assert.ok(codes.includes("layout-mid-phrase"));
  // Stretches at the very start and end of the video change nothing the viewer sees there.
  assert.deepEqual(
    checkLayouts(
      [
        { sourceStartMs: 0, sourceEndMs: 9000, type: "fullscreen-camera" },
        { sourceStartMs: 32000, sourceEndMs: 40000, type: "fullscreen-camera" },
      ],
      slices,
      speech,
    ),
    [],
  );
  const report = checkPacing(
    { slices, zooms: [], layouts: [{ sourceStartMs: 12000, sourceEndMs: 14000, type: "screen-only" }] },
    { clicks: [], typing: [], sourceDurationMs: 40000, speech },
  );
  assert.ok(report.issues.some((i) => i.code === "layout-mid-phrase"));
});
