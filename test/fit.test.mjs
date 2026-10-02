// Fit to length, markers and retakes under pressure: the stop click stays out,
// different lines are not retakes, fitted edits pass their own pacing check,
// dropped beats are really gone, and fitting stays quick on long recordings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planEdit } from "../dist/studio/plan.js";
import { describeBeats, sameWords } from "../dist/studio/beats.js";

const click = (atMs, x = 0.5, y = 0.5) => ({ atMs, endMs: atMs + 80, x, y, drag: false, button: "left" });
const inSlices = (plan, t) => plan.slices.some((s) => t >= s.startMs && t <= s.endMs);

function recording(over = {}) {
  const sourceDurationMs = over.sourceDurationMs ?? 60000;
  return {
    projectPath: "/x.screenstudio",
    sourceDurationMs,
    capture: { kind: "window", widthPt: 1440, heightPt: 900 },
    sessions: [{ startMs: 0, endMs: sourceDurationMs, video: "" }],
    clicks: [],
    typing: [],
    shortcuts: [],
    movement: [],
    screen: { changes: [], active: [] },
    idle: [],
    ...over,
  };
}

/** Idle everywhere except around the given moments. */
function idleAround(busy, end) {
  const idle = [];
  let at = 0;
  for (const [s, e] of [...busy].sort((x, y) => x[0] - y[0])) {
    if (s - 200 > at) idle.push({ startMs: at, endMs: s - 200 });
    at = Math.max(at, e + 200);
  }
  if (at < end) idle.push({ startMs: at, endMs: end });
  return idle;
}

/** A small seeded random generator, so the fuzz cases are the same on every run. */
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

test("markers in keep mode never bring Screen Studio's stop click back", () => {
  const speech = [
    { startMs: 44000, endMs: 47000, text: "And here is the result of all of it.", words: 9 },
    { startMs: 48000, endMs: 54000, text: "That is the whole flow from start to end.", words: 9 },
  ];
  const clicks = [
    click(5000, 0.2, 0.3),
    click(24000, 0.7, 0.6),
    click(45000, 0.5, 0.8),
    click(59600, 0.95, 0.02),
  ];
  const a = recording({
    clicks,
    speech,
    markers: [
      { id: "m1", sourceMs: 4500 },
      { id: "m2", sourceMs: 23500 },
      { id: "m3", sourceMs: 43800 },
    ],
    idle: idleAround(
      [...clicks.map((c) => [c.atMs, c.endMs]), ...speech.map((p) => [p.startMs, p.endMs])],
      60000,
    ),
  });
  for (const plan of [planEdit(a), planEdit(a, { markers: "keep" })]) {
    assert.ok(plan.slices.at(-1).endMs <= 59600 - 400, JSON.stringify(plan.slices.at(-1)));
    assert.ok(!plan.pacing.issues.some((i) => i.code === "stop-click"), JSON.stringify(plan.pacing.issues));
  }
});

test("two different lines that share common words are not a retake", () => {
  assert.equal(sameWords("now we open the settings page and click the save button", "then we click save"), 0);
  assert.equal(
    sameWords(
      "first we open the settings page and click the save button",
      "then we click save on the new page",
    ),
    0,
  );
  // A real retake still matches, even with a different filler word up front.
  assert.ok(
    sameWords(
      "so now open the settings and pick a dark theme",
      "okay now open the settings and pick a dark theme",
    ) >= 0.99,
  );
  const clicks = [
    click(3000, 0.3, 0.3),
    click(9000, 0.4, 0.4),
    click(17000, 0.6, 0.6),
    click(26000, 0.6, 0.7),
  ];
  const speech = [
    {
      startMs: 2000,
      endMs: 6000,
      text: "first we open the settings page and click the save button",
      words: 11,
    },
    { startMs: 15500, endMs: 19000, text: "then we click save on the new page", words: 8 },
    { startMs: 24000, endMs: 28000, text: "and that is everything you need", words: 6 },
  ];
  const a = recording({
    sourceDurationMs: 32000,
    clicks,
    speech,
    markers: [
      { id: "m1", sourceMs: 1500 },
      { id: "m2", sourceMs: 15000 },
    ],
  });
  const plan = planEdit(a, { markers: "retake" });
  assert.ok(!plan.droppedBeats.some((d) => d.reason.startsWith("retake")), JSON.stringify(plan.droppedBeats));
  assert.ok(inSlices(plan, 17000));
});

test("a retake cut ends after the phrase that runs across the marker", () => {
  const a = recording({
    sourceDurationMs: 30000,
    clicks: [click(3000, 0.3, 0.3), click(13000, 0.3, 0.3), click(22000, 0.6, 0.6)],
    speech: [
      {
        startMs: 1500,
        endMs: 9000,
        text: "Now open the settings panel and pick a dark theme for the editor.",
        words: 12,
      },
      { startMs: 10600, endMs: 11700, text: "hold on, again", words: 3 },
      {
        startMs: 11800,
        endMs: 15000,
        text: "Now open the settings panel and pick a dark theme for the editor.",
        words: 12,
      },
      { startMs: 20000, endMs: 24000, text: "That is all it takes.", words: 5 },
    ],
    markers: [{ id: "take-2", sourceMs: 11000 }],
  });
  const plan = planEdit(a, { markers: "retake" });
  assert.ok(
    plan.droppedBeats.some((d) => d.reason.startsWith("retake")),
    JSON.stringify(plan.droppedBeats),
  );
  // The phrase running across the marker goes whole, not cut at the marker.
  assert.ok(!inSlices(plan, 11000) && !inSlices(plan, 11500), JSON.stringify(plan.slices));
  assert.ok(inSlices(plan, 13000));
});

/** Ten clicks with dead air between them. */
const tenBeats = () => {
  const clicks = Array.from({ length: 10 }, (_, i) => click(3000 + i * 6000, 0.2 + i * 0.06, 0.4));
  return recording({
    clicks,
    idle: idleAround(
      clicks.map((c) => [c.atMs, c.endMs]),
      60000,
    ),
  });
};

test("a fitted edit passes its own pacing check", () => {
  const plan = planEdit(tenBeats(), { targetMs: 20000 });
  const errors = plan.pacing.issues.filter((i) => i.severity === "error");
  if (plan.fit.fitted) assert.deepEqual(errors, []);
  else assert.match(plan.notes[0], /pacing check|over/);
});

test("fuzz: fitted plans have no pacing errors and dropped beats are off screen", () => {
  const random = rng(7);
  let fitted = 0;
  for (let n = 0; n < 60; n++) {
    const end = 30000 + Math.round(random() * 60000);
    const clicks = [];
    for (let t = 1500 + random() * 2000; t < end - 3000; t += 1200 + random() * 7000)
      clicks.push(click(Math.round(t), random(), random()));
    const changes = clicks
      .filter(() => random() < 0.3)
      .map((c) => ({ atMs: c.atMs + 300, score: 0.6, kind: random() < 0.5 ? "page" : "region" }));
    const markers =
      random() < 0.5
        ? clicks.filter(() => random() < 0.2).map((c, i) => ({ id: `m${i + 1}`, sourceMs: c.atMs - 300 }))
        : undefined;
    const a = recording({
      sourceDurationMs: end,
      clicks,
      markers,
      screen: { changes, active: [] },
      idle: idleAround(
        clicks.map((c) => [c.atMs, c.endMs + 300]),
        end,
      ),
    });
    const mode = ["keep", "chapters", "retake"][Math.floor(random() * 3)];
    const targetMs = 8000 + Math.round(random() * 20000);
    const plan = planEdit(a, { targetMs, markers: mode });
    if (plan.fit.fitted) {
      fitted++;
      assert.deepEqual(
        plan.pacing.issues.filter((i) => i.severity === "error"),
        [],
        `case ${n}: ${plan.notes[0]}`,
      );
    }
    for (const b of plan.beats)
      if (!b.kept)
        assert.ok(
          !plan.slices.some((s) => s.startMs < b.sourceEndMs && s.endMs > b.sourceStartMs) ||
            b.actions.length === 0,
          `case ${n}: beat at ${b.sourceStartMs} is listed as cut but shown`,
        );
    for (const d of plan.droppedBeats) {
      const beat = plan.beats.find((b) => b.sourceStartMs === d.sourceStartMs);
      assert.equal(beat.kept, false, `case ${n}: dropped beat at ${d.sourceStartMs} still on screen`);
    }
  }
  assert.ok(fitted > 10, `only ${fitted} cases fitted`);
});

test("a beat that cannot be cut without cutting a phrase is not listed as dropped", () => {
  const a = recording({
    sourceDurationMs: 40000,
    clicks: [click(5000), click(28000, 0.7, 0.6), click(36000, 0.4, 0.4)],
    speech: [
      {
        startMs: 20000,
        endMs: 31000,
        text: "This explanation keeps going across the marker and the click.",
        words: 10,
      },
    ],
    markers: [
      { id: "m1", sourceMs: 4500 },
      { id: "m2", sourceMs: 26000 },
    ],
  });
  const plan = planEdit(a, { markers: "chapters", targetMs: 22000 });
  for (const d of plan.droppedBeats) {
    const beat = plan.beats.find((b) => b.sourceStartMs === d.sourceStartMs);
    assert.equal(beat.kept, false, JSON.stringify({ d, slices: plan.slices }));
  }
  // The sentence is never cut in the middle by a dropped beat.
  assert.ok(!plan.pacing.issues.some((i) => i.code === "mid-phrase-cut"), JSON.stringify(plan.pacing.issues));
});

test("fit to length stays quick on a 30-minute recording", () => {
  const clicks = Array.from({ length: 300 }, (_, i) =>
    click(3000 + i * 6000, (i % 7) / 7 + 0.05, (i % 5) / 5 + 0.1),
  );
  const end = 3000 + 300 * 6000 + 5000;
  const a = recording({
    sourceDurationMs: end,
    clicks,
    idle: idleAround(
      clicks.map((c) => [c.atMs, c.endMs]),
      end,
    ),
  });
  const t0 = performance.now();
  const plan = planEdit(a, { targetMs: 30000 });
  const ms = performance.now() - t0;
  assert.ok(ms < 3000, `${Math.round(ms)}ms`);
  assert.ok(plan.fit.playbackMs <= 30000 * 1.05, plan.notes[0]);
  assert.ok(plan.fit.playbackMs >= 30000 * 0.75, plan.notes[0]);
});

test("a page change counts for the beat that caused it, not the one before", () => {
  const beats = [
    {
      startMs: 10000,
      endMs: 10100,
      actions: [{ kind: "click", startMs: 10000, endMs: 10100, label: "click a" }],
    },
    {
      startMs: 12500,
      endMs: 12600,
      actions: [{ kind: "click", startMs: 12500, endMs: 12600, label: "click b" }],
    },
  ];
  const described = describeBeats(
    { screen: { changes: [{ atMs: 12800, score: 0.6, kind: "page" }], active: [] } },
    beats,
    { resultWindowMs: 3500 },
  );
  assert.ok(
    !described[0].scoreParts.some((p) => p.startsWith("page changes")),
    described[0].scoreParts.join(),
  );
  assert.ok(described[1].scoreParts.some((p) => p.startsWith("page changes")));
});

test("a chapter whose footage was cut is not placed at 0:00", () => {
  const a = recording({
    clicks: [click(5000, 0.2, 0.3), click(24000, 0.7, 0.6), click(45000, 0.5, 0.8)],
    typing: [{ startMs: 25000, endMs: 30000, chars: 60, x: 0.7, y: 0.6 }],
    screen: { changes: [{ atMs: 45300, score: 0.6, kind: "page" }], active: [] },
    idle: [
      { startMs: 0, endMs: 4800 },
      { startMs: 5300, endMs: 23800 },
      { startMs: 30300, endMs: 44800 },
      { startMs: 50600, endMs: 59500 },
    ],
    markers: [
      { id: "m1", sourceMs: 4800 },
      { id: "m2", sourceMs: 23800 },
    ],
  });
  const plan = planEdit(a, { markers: "chapters", targetMs: 9000 });
  assert.ok(
    plan.droppedBeats.some((d) => d.sourceStartMs === 5000),
    JSON.stringify(plan.droppedBeats),
  );
  assert.ok(!plan.notes.some((n) => /^0:00 chapter 1 starts/.test(n)), plan.notes.join("\n"));
  assert.ok(
    plan.notes.some((n) => /Chapter 1 \(marker m1\) was cut/.test(n)),
    plan.notes.join("\n"),
  );
});

test("voiced beats keep the hold stretched for their line", () => {
  const clicks = [click(5500, 0.3, 0.3), click(15500, 0.6, 0.6)];
  const a = recording({
    sourceDurationMs: 25000,
    clicks,
    markers: [
      { id: "m1", sourceMs: 5000 },
      { id: "m2", sourceMs: 15000 },
    ],
    idle: idleAround(
      clicks.map((c) => [c.atMs, c.endMs]),
      25000,
    ),
  });
  const plain = planEdit(a, { markers: "chapters" });
  assert.ok(!inSlices(plain, 12000), "idle hold is cut without voiced beats");
  const voiced = planEdit(a, { markers: "chapters", markerBeatsMs: [8000, 5000] });
  assert.ok(inSlices(voiced, 12000) && inSlices(voiced, 19500), JSON.stringify(voiced.slices));
});
