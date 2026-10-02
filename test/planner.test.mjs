// The planner keeps its promises: the caller's drops stay dropped, results and
// typing stay readable, the stop click never shows, and every plan passes the
// same pacing check the agent will run on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPacing } from "../dist/studio/pacing.js";
import { planEdit } from "../dist/studio/plan.js";
import { LOOKS, STYLES } from "../dist/studio/styles.js";

const STYLE_NAMES = ["calm", "balanced", "snappy"];

function analysis(over) {
  const sourceDurationMs = over.sourceDurationMs ?? 30000;
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

const click = (atMs, x = 0.5, y = 0.5) => ({ atMs, endMs: atMs + 80, x, y, drag: false, button: "left" });
const inSlice = (plan, t) => plan.slices.find((s) => t >= s.startMs && t <= s.endMs);
const overlapsSlice = (plan, span) =>
  plan.slices.some((s) => s.startMs < span.endMs && s.endMs > span.startMs);
const codes = (report) => report.issues.map((i) => i.code);

/** Idle stretches between the given busy moments, the way the analyzer builds them. */
function idleAround(busy, sourceDurationMs) {
  const idle = [];
  let at = 0;
  for (const b of [...busy].sort((x, y) => x.startMs - y.startMs)) {
    if (b.startMs - at >= 800) idle.push({ startMs: at, endMs: b.startMs });
    at = Math.max(at, b.endMs);
  }
  if (sourceDurationMs - at >= 800) idle.push({ startMs: at, endMs: sourceDurationMs });
  return idle;
}

test("removeFillers removes every filler and the plan does not flag its own filler cuts", () => {
  const fillers = Array.from({ length: 9 }, (_, i) => ({
    startMs: 1500 + i * 3000,
    endMs: 1800 + i * 3000,
    text: " um",
  }));
  const a = analysis({
    idle: [{ startMs: 0, endMs: 30000 }],
    speech: [
      { startMs: 500, endMs: 9500, text: "First part of the talk.", words: 20 },
      { startMs: 10500, endMs: 19500, text: "Second part of the talk.", words: 20 },
      { startMs: 20500, endMs: 29500, text: "Third part of the talk.", words: 20 },
    ],
    fillers,
  });
  for (const style of STYLE_NAMES) {
    const plan = planEdit(a, { style, removeFillers: true });
    for (const f of fillers) assert.ok(!overlapsSlice(plan, f), `${style}: filler at ${f.startMs} kept`);
    assert.ok(plan.summary.includes("9 of 9 fillers"), plan.summary);
    assert.ok(!codes(plan.pacing).includes("mid-phrase-cut"), JSON.stringify(plan.pacing.issues));
    assert.notEqual(plan.pacing.verdict, "too fast", JSON.stringify(plan.pacing.issues));
  }
});

test("the caller's drops are never rejoined", () => {
  const clicks = Array.from({ length: 16 }, (_, i) => click(1000 + i * 1500, 0.3 + (i % 3) * 0.05));
  const drop = [
    { startMs: 8100, endMs: 8800 },
    { startMs: 12100, endMs: 12800 },
    { startMs: 16100, endMs: 16800 },
  ];
  const a = analysis({ sourceDurationMs: 26000, clicks });
  for (const style of STYLE_NAMES) {
    const plan = planEdit(a, { style, drop });
    for (const d of drop) assert.ok(!overlapsSlice(plan, d), `${style}: drop ${d.startMs} kept`);
    assert.ok(!plan.summary.includes("Could not drop"), plan.summary);
  }
});

test("tightened pauses keep the on-screen result of an action", () => {
  const a = analysis({
    sourceDurationMs: 12000,
    clicks: [click(3500)],
    screen: { changes: [{ atMs: 6500, score: 0.5, kind: "page" }], active: [{ startMs: 5000, endMs: 7000 }] },
    idle: [
      { startMs: 0, endMs: 1000 },
      { startMs: 3650, endMs: 5000 },
      { startMs: 7000, endMs: 8000 },
      { startMs: 10000, endMs: 12000 },
    ],
    speech: [
      { startMs: 1000, endMs: 4000, text: "Click here and the page loads.", words: 6 },
      { startMs: 8000, endMs: 10000, text: "There it is.", words: 3 },
    ],
  });
  for (const style of STYLE_NAMES) {
    const plan = planEdit(a, { style, tightenPausesMs: 300 });
    for (const t of [3500, 5000, 6000, 6500, 7000, 7500])
      assert.ok(inSlice(plan, t), `${style}: ${t} cut: ${JSON.stringify(plan.slices)}`);
  }
});

test("pause tightening only cuts still stretches between phrases", () => {
  const speech = Array.from({ length: 6 }, (_, i) => ({
    startMs: 1000 + i * 5000,
    endMs: 3000 + i * 5000,
    text: `Phrase ${i}`,
    words: 4,
  }));
  // The cursor moves through the third pause; that part stays.
  const a = analysis({
    sourceDurationMs: 32000,
    speech,
    movement: [{ startMs: 14000, endMs: 15000, distance01: 0.2 }],
    idle: idleAround([...speech, { startMs: 14000, endMs: 15000 }], 32000),
  });
  const plan = planEdit(a, { style: "balanced", tightenPausesMs: 300 });
  assert.ok(inSlice(plan, 14500), JSON.stringify(plan.slices));
  assert.ok(!inSlice(plan, 5000), JSON.stringify(plan.slices));
});

test("the final hold ends before Screen Studio's stop click and the cursor's trip to it", () => {
  const a = analysis({
    sourceDurationMs: 60000,
    clicks: [click(50000), click(57000), click(59600, 0.95, 0.02)],
    movement: [{ startMs: 58800, endMs: 59600, distance01: 0.6 }],
    idle: [
      { startMs: 0, endMs: 49800 },
      { startMs: 50300, endMs: 56800 },
      { startMs: 57300, endMs: 58800 },
    ],
  });
  for (const style of STYLE_NAMES) {
    const plan = planEdit(a, { style });
    const last = plan.slices.at(-1);
    assert.ok(last.endMs <= 58800, `${style}: ends at ${last.endMs}`);
    assert.ok(last.endMs >= 57100, `${style}: the last click's result is kept`);
    assert.ok(!codes(plan.pacing).includes("stop-click"), JSON.stringify(plan.pacing.issues));
  }
  // Without cursor data the cut still lands before the click.
  const plan = planEdit({ ...a, movement: [] });
  assert.ok(plan.slices.at(-1).endMs <= 59600 - 300, JSON.stringify(plan.slices));
});

test("the pacing check flags a video that ends on the stop click", () => {
  const r = checkPacing(
    { slices: [{ sourceStartMs: 0, sourceEndMs: 60000, timeScale: 1 }], zooms: [] },
    { clicks: [click(50000), click(59600)], typing: [], sourceDurationMs: 60000 },
  );
  assert.ok(codes(r).includes("stop-click"), JSON.stringify(r.issues));
});

test("a click inside a typing burst plays at a followable speed", () => {
  const a = analysis({
    sourceDurationMs: 30000,
    clicks: [click(5000, 0.4, 0.4), click(12000, 0.4, 0.5)],
    typing: [{ startMs: 6000, endMs: 20000, chars: 120, x: 0.4, y: 0.4 }],
    idle: [
      { startMs: 0, endMs: 4800 },
      { startMs: 20200, endMs: 30000 },
    ],
  });
  for (const style of STYLE_NAMES) {
    const plan = planEdit(a, { style });
    assert.ok(inSlice(plan, 12000).speed <= STYLES[style].maxActionSpeed, JSON.stringify(plan.slices));
    assert.ok(!codes(plan.pacing).includes("fast-action"), JSON.stringify(plan.pacing.issues));
    assert.ok(
      plan.slices.some((s) => s.speed > 1 && s.reason.startsWith("typing")),
      "typing still sped up",
    );
  }
});

function demo() {
  // Three beats with dead air between them and a slow page load in the middle.
  return analysis({
    sourceDurationMs: 60000,
    clicks: [click(5000, 0.2, 0.3), click(7000, 0.25, 0.32), click(24000, 0.7, 0.6), click(45000, 0.5, 0.8)],
    typing: [{ startMs: 25000, endMs: 30000, chars: 60, x: 0.7, y: 0.6 }],
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
  });
}

for (const style of STYLE_NAMES)
  test(`${style} plan of a demo is good by its own check`, () => {
    const plan = planEdit(demo(), { style });
    assert.equal(plan.pacing.verdict, "good", JSON.stringify(plan.pacing.issues));
    assert.ok(!codes(plan.pacing).includes("zoom-on-fast-clip"), JSON.stringify(plan.pacing.issues));
  });

test("a zoom over typing keeps the typing readable", () => {
  const a = analysis({
    sourceDurationMs: 20000,
    clicks: [click(3000, 0.3, 0.3), click(10000, 0.32, 0.32)],
    typing: [{ startMs: 4000, endMs: 9000, chars: 50, x: 0.3, y: 0.3 }],
    idle: [
      { startMs: 0, endMs: 2800 },
      { startMs: 10300, endMs: 20000 },
    ],
  });
  for (const style of STYLE_NAMES) {
    const plan = planEdit(a, { style });
    assert.ok(plan.zooms.length > 0, `${style}: no zoom`);
    assert.ok(!codes(plan.pacing).includes("zoom-on-fast-clip"), JSON.stringify(plan.pacing.issues));
  }
});

test("talking videos pass their own pacing check", () => {
  const speech = Array.from({ length: 12 }, (_, i) => ({
    startMs: 500 + i * 2500,
    endMs: 2000 + i * 2500,
    text: `Phrase number ${i}`,
    words: 3,
  }));
  const a = analysis({ sourceDurationMs: 31000, speech, idle: idleAround(speech, 31000) });
  for (const style of STYLE_NAMES) {
    const plan = planEdit(a, { style, tightenPausesMs: 250 });
    assert.ok(plan.pacing.cuts > 0, "pauses tightened");
    assert.notEqual(plan.pacing.verdict, "too fast", JSON.stringify(plan.pacing.issues));
    assert.ok(!plan.pacing.issues.some((i) => i.severity === "error"), JSON.stringify(plan.pacing.issues));
  }
  const long = Array.from({ length: 4 }, (_, i) => ({
    startMs: 500 + i * 10000,
    endMs: 9000 + i * 10000,
    text: `A long phrase ${i}`,
    words: 20,
  }));
  const fillers = long.flatMap((p) =>
    [2000, 5000].map((d) => ({ startMs: p.startMs + d, endMs: p.startMs + d + 300, text: " uh" })),
  );
  const b = analysis({ sourceDurationMs: 40000, speech: long, fillers, idle: idleAround(long, 40000) });
  const plan = planEdit(b, { tightenPausesMs: 300, removeFillers: true });
  assert.ok(!codes(plan.pacing).includes("mid-phrase-cut"), JSON.stringify(plan.pacing.issues));
  assert.notEqual(plan.pacing.verdict, "too fast", JSON.stringify(plan.pacing.issues));
});

test("jump cuts between phrases are judged apart from scene cuts", () => {
  const speech = Array.from({ length: 8 }, (_, i) => ({
    startMs: i * 2000,
    endMs: i * 2000 + 1400,
    text: `p${i}`,
    words: 2,
  }));
  const slices = speech.map((p) => ({
    sourceStartMs: p.startMs - 250,
    sourceEndMs: p.endMs + 250,
    timeScale: 1,
  }));
  slices[0].sourceStartMs = 0;
  const r = checkPacing({ slices, zooms: [] }, { clicks: [], typing: [], sourceDurationMs: 16000, speech });
  assert.equal(r.cuts, 7);
  assert.ok(!codes(r).includes("choppy"), JSON.stringify(r.issues));
  const scene = checkPacing({ slices, zooms: [] }, { clicks: [], typing: [], sourceDurationMs: 16000 });
  assert.equal(scene.verdict, "too fast", JSON.stringify(scene.issues));
});

test("abrupt-ending sees actions cut off at the end and ignores videos without actions", () => {
  const one = [{ sourceStartMs: 0, sourceEndMs: 10000, timeScale: 1 }];
  const at = (clicks, typing = [], slices = one) =>
    codes(checkPacing({ slices, zooms: [] }, { clicks, typing, sourceDurationMs: 20000 }));
  // A click that runs past the last frame.
  assert.ok(at([{ ...click(9950), endMs: 10030 }]).includes("abrupt-ending"));
  // Typing that runs past the last frame.
  assert.ok(at([], [{ startMs: 9000, endMs: 12000, chars: 30 }]).includes("abrupt-ending"));
  // A later click that was cut away does not hide an earlier one near the end.
  assert.ok(at([click(9600), click(15000)]).includes("abrupt-ending"));
  // A single keystroke has no length.
  assert.ok(at([], [{ startMs: 9800, endMs: 9800, chars: 1 }]).includes("abrupt-ending"));
  // No actions, no warning.
  assert.ok(!at([], [], [{ sourceStartMs: 0, sourceEndMs: 800, timeScale: 1 }]).includes("abrupt-ending"));
  // A long hold after the last action is fine.
  assert.ok(!at([click(5000)]).includes("abrupt-ending"));
});

test("sped-up stretches never leave clips under a second", () => {
  const noMid = demo();
  noMid.clicks = noMid.clicks.filter((c) => c.atMs !== 24000);
  const cases = [
    [noMid, {}],
    [demo(), { drop: [{ startMs: 46900, endMs: 48700 }] }],
    [demo(), { drop: [{ startMs: 47000, endMs: 48500 }] }],
  ];
  for (const style of STYLE_NAMES)
    for (const [a, options] of cases) {
      const plan = planEdit(a, { ...options, style });
      for (const s of plan.slices)
        assert.ok((s.endMs - s.startMs) / s.speed >= 1000, `${style}: ${JSON.stringify(plan.slices)}`);
      assert.ok(!codes(plan.pacing).includes("short-clip"), JSON.stringify(plan.pacing.issues));
      for (const d of options.drop ?? []) assert.ok(!overlapsSlice(plan, d), `${style}: drop kept`);
    }
});

test("isolated clicks between dead air never make a too-fast plan", () => {
  const clicks = [3000, 7000, 11000, 15000, 19000].map((t, i) => click(t, 0.2 + i * 0.15, 0.5));
  const a = analysis({
    sourceDurationMs: 23000,
    clicks,
    idle: idleAround(
      clicks.map((c) => ({ startMs: c.atMs, endMs: c.endMs })),
      23000,
    ),
  });
  const speech = clicks.map((c) => ({ startMs: c.atMs - 600, endMs: c.atMs + 400, text: "here", words: 1 }));
  for (const style of STYLE_NAMES) {
    for (const options of [{}, { tightenPausesMs: 300 }]) {
      const plan = planEdit(a, { style, ...options });
      assert.notEqual(plan.pacing.verdict, "too fast", `${style}: ${JSON.stringify(plan.pacing.issues)}`);
    }
    const talk = planEdit({ ...a, speech }, { style, tightenPausesMs: 300 });
    assert.notEqual(talk.pacing.verdict, "too fast", `${style}: ${JSON.stringify(talk.pacing.issues)}`);
  }
});

/** Deterministic pseudo-random numbers so a failing recording can be replayed. */
function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

function randomRecording(seed) {
  const r = rng(seed);
  const sourceDurationMs = 20000 + Math.floor(r() * 60000);
  const clicks = [];
  const typing = [];
  const active = [];
  const changes = [];
  for (let t = 1000 + r() * 3000; t < sourceDurationMs - 3000; t += 800 + r() * 9000) {
    const kind = r();
    const x = Math.round(r() * 1000) / 1000;
    const y = Math.round(r() * 1000) / 1000;
    if (kind < 0.6) clicks.push(click(Math.round(t), x, y));
    else if (kind < 0.8) {
      const len = 1000 + r() * 6000;
      typing.push({ startMs: Math.round(t), endMs: Math.round(t + len), chars: Math.round(len / 120), x, y });
      t += len;
    } else {
      clicks.push(click(Math.round(t), x, y));
      const len = 1500 + r() * 5000;
      active.push({ startMs: Math.round(t + 200), endMs: Math.round(t + 200 + len) });
      changes.push({ atMs: Math.round(t + 300), score: 0.5, kind: "page" });
      t += len;
    }
  }
  clicks.push(click(sourceDurationMs - 400, 0.95, 0.02));
  const busy = [
    ...clicks.map((c) => ({ startMs: c.atMs - 150, endMs: c.endMs + 150 })),
    ...typing.map((t) => ({ startMs: t.startMs - 150, endMs: t.endMs + 150 })),
    ...active,
  ];
  return analysis({
    sourceDurationMs,
    clicks,
    typing,
    screen: { changes, active },
    idle: idleAround(busy, sourceDurationMs),
  });
}

test("random recordings: no plan breaks the rules it was built to follow", () => {
  const own = ["zoom-on-fast-clip", "short-zoom", "short-clip", "fast-action", "stop-click"];
  for (let seed = 1; seed <= 150; seed++) {
    const a = randomRecording(seed);
    for (const style of STYLE_NAMES) {
      const plan = planEdit(a, { style });
      const where = `seed ${seed} ${style}: ${JSON.stringify(plan.pacing.issues)}`;
      assert.notEqual(plan.pacing.verdict, "too fast", where);
      for (const c of own) assert.ok(!codes(plan.pacing).includes(c), `${c} in ${where}`);
    }
  }
});

test("every look sets the same settings, so a look never inherits the last one", () => {
  const backgroundOnly = new Set([
    "styles.background.systemName",
    "styles.background.color",
    "styles.background.gradient",
  ]);
  const keys = new Set(
    Object.values(LOOKS)
      .flatMap((l) => Object.keys(l))
      .filter((k) => !backgroundOnly.has(k)),
  );
  for (const [name, look] of Object.entries(LOOKS)) {
    for (const k of keys) assert.ok(Object.hasOwn(look, k), `${name} misses ${k}`);
    const type = look["styles.background.type"];
    if (type === "gradient") {
      const g = look["styles.background.gradient"];
      assert.ok(g && g.stops.length >= 2, `${name} has gradient stops`);
      for (const s of g.stops) assert.match(s.color, /^#[0-9a-f]{6}$/i);
    }
    if (type === "system") assert.ok(look["styles.background.systemName"], name);
    if (type === "color") assert.ok(look["styles.background.color"], name);
  }
});
