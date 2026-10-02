// Editing judgment: timeline math, the pacing check and the planner, on
// synthetic recordings shaped like real Screen Studio footage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toPlayback, toSource, playbackRange, springSettleMs, SPRINGS } from "../dist/studio/timeline.js";
import { checkPacing, checkStyle } from "../dist/studio/pacing.js";
import { planEdit } from "../dist/studio/plan.js";
import { ASPECTS, LOOKS } from "../dist/studio/styles.js";
import { validateConfigChange } from "../dist/studio/project.js";
import { configPartial } from "../dist/studio/editor/ops.js";
import { describeScene } from "../dist/studio/editor/describe.js";

const slices = [
  { sourceStartMs: 1000, sourceEndMs: 5000, timeScale: 1 },
  { sourceStartMs: 8000, sourceEndMs: 12000, timeScale: 0.5 },
];

test("source and playback time map through cuts and speed", () => {
  assert.equal(toPlayback(slices, 1000), 0);
  assert.equal(toPlayback(slices, 9000), 4500);
  assert.equal(toPlayback(slices, 6000), null);
  assert.equal(toSource(slices, 4500), 9000);
  const r = playbackRange(slices, 4000, 10000);
  assert.deepEqual([r.startMs, r.endMs, r.visibleMs, r.maxSpeed], [3000, 5000, 2000, 2]);
});

test("spring presets: default snaps, Smooth glides", () => {
  assert.ok(springSettleMs(SPRINGS.schemaDefault) < 300);
  const smooth = springSettleMs(SPRINGS.screenSmooth);
  assert.ok(smooth > 700 && smooth < 1200, String(smooth));
});

// An edit that felt too fast: 32s cut to 12.7s, ramps everywhere, six short zooms.
const heavy = {
  slices: [
    [1800, 3200, 1],
    [4700, 7400, 0.556],
    [10900, 13800, 0.833],
    [20800, 24400, 1],
    [24600, 26000, 0.667],
    [26200, 30800, 0.625],
  ].map(([a, b, t]) => ({ sourceStartMs: a, sourceEndMs: b, timeScale: t })),
  zooms: [
    [600, 2550, 1.85],
    [4850, 7200, 1.65],
    [11100, 13650, 1.65],
    [20900, 24250, 1.3],
    [26350, 27700, 1.7],
    [28000, 30600, 1.85],
  ].map(([a, b, z], i) => ({ id: `z${i}`, sourceStartMs: a, sourceEndMs: b, zoom: z, type: "manual" })),
  screenSpring: SPRINGS.schemaDefault,
};
const clicks = [1524, 4755, 8358, 9156, 10806, 14055, 18407].map((atMs, i) => ({
  atMs,
  endMs: atMs + 100,
  x: 0.2 + i * 0.08,
  y: 0.4,
  drag: false,
  button: "left",
}));

test("pacing check calls the heavy edit too fast, for the right reasons", () => {
  const r = checkPacing(heavy, { clicks, typing: [], sourceDurationMs: 32000 });
  assert.equal(r.verdict, "too fast");
  const codes = new Set(r.issues.map((i) => i.code));
  for (const c of [
    "too-many-zooms",
    "short-zoom",
    "zoom-ping-pong",
    "choppy",
    "fast-action",
    "snappy-spring",
  ])
    assert.ok(codes.has(c), `missing ${c}`);
});

function recording() {
  // Three beats with dead air between them and a slow page load in the middle.
  return {
    projectPath: "/x.screenstudio",
    sourceDurationMs: 60000,
    capture: { kind: "window", widthPt: 1440, heightPt: 900 },
    sessions: [{ startMs: 0, endMs: 60000, video: "" }],
    clicks: [
      { atMs: 5000, endMs: 5080, x: 0.2, y: 0.3, drag: false, button: "left" },
      { atMs: 7000, endMs: 7080, x: 0.25, y: 0.32, drag: false, button: "left" },
      { atMs: 24000, endMs: 24080, x: 0.7, y: 0.6, drag: false, button: "left" },
      { atMs: 45000, endMs: 45080, x: 0.5, y: 0.8, drag: false, button: "left" },
      { atMs: 59600, endMs: 59680, x: 0.95, y: 0.02, drag: false, button: "left" },
    ],
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
  };
}

for (const style of ["calm", "balanced", "snappy"])
  test(`${style} plan passes its own pacing check`, () => {
    const a = recording();
    const plan = planEdit(a, { style });
    assert.notEqual(plan.pacing.verdict, "too fast", JSON.stringify(plan.pacing.issues));
    assert.equal(
      plan.pacing.issues.filter((i) => i.severity === "error").length,
      0,
      JSON.stringify(plan.pacing.issues),
    );
    // Dead air is cut, clicks stay at a followable speed, the stop click is ignored.
    assert.ok(plan.pacing.playbackMs < 40000, String(plan.pacing.playbackMs));
    for (const s of plan.slices)
      for (const c of a.clicks.slice(0, 4))
        if (c.atMs >= s.startMs && c.atMs <= s.endMs) assert.ok(s.speed <= 1.5);
    assert.ok(!plan.beats.some((b) => b.actions.some((x) => x.includes("0.95"))));
    // Typing or waiting is sped up, never the clicks around it, and only as often as
    // the speed can change without ramping: the speed-up that saves least plays at 1x.
    assert.ok(
      plan.slices.some((s) => s.speed > 1),
      JSON.stringify(plan.slices),
    );
    assert.ok(
      !plan.pacing.issues.some((i) => i.code === "speed-ramping"),
      JSON.stringify(plan.pacing.issues),
    );
    // Few zooms, none crossing the page change, none in the opening shot.
    assert.ok(plan.zooms.length <= 2, JSON.stringify(plan.zooms));
    for (const z of plan.zooms) assert.ok(z.sourceEndMs < 45300 || z.sourceStartMs > 45300);
  });

test("drops and keeps override the planner", () => {
  const plan = planEdit(recording(), { drop: [{ startMs: 23000, endMs: 31500 }] });
  assert.ok(!plan.slices.some((s) => s.startMs < 26000 && s.endMs > 26000));
});

test("config partial merges nested values and rejects unknown keys", () => {
  const config = {
    styles: { background: { type: "system", color: "#000000", blur: 0 } },
    cursor: { size: 48 },
  };
  const p = configPartial(config, { "styles.background.color": "#172039", "cursor.size": 56 });
  assert.deepEqual(p.styles.background, { type: "system", color: "#172039", blur: 0 });
  assert.equal(config.styles.background.color, "#000000");
  assert.throws(() => configPartial(config, { "__proto__.polluted": true }));
  assert.throws(() => configPartial(config, { "cursor.size": -1 }));
  assert.equal({}.polluted, undefined);
});

test("timeline description reports on-screen zoom time", () => {
  const d = describeScene({
    slices,
    zooms: [
      {
        id: "a",
        sourceStartMs: 4000,
        sourceEndMs: 10000,
        zoom: 1.5,
        type: "manual",
        manualTargetPoint: { x: 0.5, y: 0.5 },
      },
    ],
  });
  assert.equal(d.zooms[0].onScreenMs, 2000);
  assert.equal(d.slices[1].speed, 2);
});

test("visual-settings checks catch frame cropping, cursor flicker and loupe overuse", () => {
  const config = {
    output: { aspectRatio: 16 / 9, avoidEmptyZoomArea: true, paddingRatio01: 0.07 },
    cursor: { size: 56, hideNotMovingAfterMs: 600 },
    audio: { clickSoundEffect: "apple-magic-mouse", clickSoundEffectVolume: 0.8 },
    animations: { motionBlurAmount: 1.5 },
  };
  const loupe = (i) => ({
    sourceStartMs: i * 10000,
    sourceEndMs: i * 10000 + 4000,
    zoom: 1.8,
    presentation: "loupe",
  });
  const codes = checkStyle(config, [0, 1, 2, 3].map(loupe), { widthPt: 1440, heightPt: 900 }).map(
    (i) => i.code,
  );
  for (const c of ["fill-crop", "cursor-flicker", "loud-clicks", "heavy-blur", "loupe-overuse"])
    assert.ok(codes.includes(c), c);
  assert.deepEqual(
    checkStyle({ output: { aspectRatio: 1.6, avoidEmptyZoomArea: true } }, [], {
      widthPt: 1440,
      heightPt: 900,
    }),
    [],
  );
});

test("looks are valid config and never crop the frame", () => {
  for (const look of Object.values(LOOKS)) {
    assert.equal(look["output.avoidEmptyZoomArea"], false);
    const config = {
      output: {},
      cursor: {},
      audio: {},
      animations: {},
      styles: { background: {}, shadow: {} },
    };
    assert.ok(Object.keys(LOOKS).length >= 4, "a variety of looks");
    for (const [k, v] of Object.entries(look)) {
      const [g, f, sub] = k.split(".");
      if (sub) config[g][f][sub] = v;
      else config[g][f] = v;
    }
    config.output.aspectRatio = ASPECTS["16:9"];
    assert.deepEqual(checkStyle(config, [], { widthPt: 1440, heightPt: 900 }), []);
  }
});

test("a narrated demo timeline passes pacing and visual-settings checks", () => {
  const slices = [
    { sourceStartMs: 895, sourceEndMs: 23862, timeScale: 1 },
    { sourceStartMs: 26189, sourceEndMs: 78734, timeScale: 1 },
  ];
  const zooms = [
    { sourceStartMs: 15200, sourceEndMs: 21400, zoom: 1.8, presentation: "loupe", type: "manual" },
    { sourceStartMs: 38300, sourceEndMs: 43400, zoom: 1.4, presentation: "screen", type: "manual" },
    { sourceStartMs: 49700, sourceEndMs: 53700, zoom: 1.8, presentation: "loupe", type: "manual" },
    { sourceStartMs: 57600, sourceEndMs: 64900, zoom: 1.4, presentation: "screen", type: "manual" },
  ];
  const config = {
    output: { aspectRatio: 16 / 9, avoidEmptyZoomArea: false, paddingRatio01: 0.07 },
    cursor: { size: 56, hideNotMovingAfterMs: 2500 },
    audio: { clickSoundEffect: "apple-magic-mouse", clickSoundEffectVolume: 0.35 },
    animations: { motionBlurAmount: 0.6 },
  };
  const r = checkPacing({ slices, zooms, screenSpring: SPRINGS.screenSmooth, config }, undefined, "balanced");
  assert.equal(r.verdict, "good", JSON.stringify(r.issues));
  assert.equal(r.issues.length, 0, JSON.stringify(r.issues));
});

test("any existing setting can be set, with its type kept and prototypes blocked", () => {
  const config = {
    crop: { rect01: { x: 0, y: 0, width: 1, height: 1 } },
    styles: { background: { systemName: "macOS/a.jpg", image: null }, shadow: { distance: 25 } },
    camera: { lut: null, crop01: { x: 0, y: 0, width: 1, height: 1 } },
    defaultLayout: { cutoutCamera: { cutoutCameraSizeRatio01: 1 } },
  };
  assert.equal(validateConfigChange(config, "styles.shadow.distance", 40), 40);
  assert.equal(validateConfigChange(config, "camera.lut", "Film.cube"), "Film.cube");
  assert.throws(() => validateConfigChange(config, "styles.shadow.distance", "far"));
  assert.throws(() => validateConfigChange(config, "styles.nothing", 1));
  assert.throws(() => validateConfigChange(config, "__proto__.x", 1));
  assert.throws(() => validateConfigChange(config, "crop.rect01", { x: 2, y: 0, width: 1, height: 1 }));
  const p = configPartial(config, {
    "defaultLayout.cutoutCamera.cutoutCameraSizeRatio01": 0.6,
    "crop.rect01": { x: 0, y: 0.025, width: 1, height: 0.975 },
  });
  assert.equal(p.defaultLayout.cutoutCamera.cutoutCameraSizeRatio01, 0.6);
  assert.equal(p.crop.rect01.y, 0.025);
});

test("speech is never cut or sped up; pauses between phrases tighten", () => {
  const a = {
    projectPath: "/x.screenstudio",
    sourceDurationMs: 30000,
    capture: { kind: "display", widthPt: 2560, heightPt: 1440 },
    sessions: [{ startMs: 0, endMs: 30000, video: "" }],
    clicks: [],
    typing: [{ startMs: 15000, endMs: 19000, chars: 40, x: 0.5, y: 0.5 }],
    shortcuts: [],
    movement: [],
    screen: { changes: [], active: [] },
    idle: [
      { startMs: 6000, endMs: 12000 },
      { startMs: 22000, endMs: 30000 },
    ],
    speech: [
      { startMs: 1000, endMs: 6000, text: "Here is the first idea.", words: 5 },
      { startMs: 12000, endMs: 18000, text: "And here is the second one.", words: 6 },
    ],
  };
  const plan = planEdit(a, { tightenPausesMs: 300 });
  const kept = (t) => plan.slices.some((s) => t >= s.startMs && t <= s.endMs);
  for (const t of [1000, 3500, 6000, 12000, 15000, 18000]) assert.ok(kept(t), `speech at ${t} kept`);
  for (const s of plan.slices)
    if (s.startMs < 18000 && s.endMs > 12000) assert.equal(s.speed, 1, "typing under speech not sped up");
  assert.ok(!kept(9000), "the long pause is trimmed");
  const r = checkPacing(
    {
      slices: [
        { sourceStartMs: 0, sourceEndMs: 3000, timeScale: 1 },
        { sourceStartMs: 4000, sourceEndMs: 30000, timeScale: 0.5 },
      ],
      zooms: [],
    },
    { ...a, clicks: [], typing: [] },
  );
  const codes = r.issues.map((i) => i.code);
  assert.ok(codes.includes("fast-speech") && codes.includes("mid-phrase-cut"), codes.join());
});

test("a loupe next to a camera zoom is not ping-pong", () => {
  const slices = [{ sourceStartMs: 0, sourceEndMs: 30000, timeScale: 1 }];
  const zooms = [
    { id: "a", sourceStartMs: 3000, sourceEndMs: 8000, zoom: 1.8, presentation: "loupe", type: "manual" },
    { id: "b", sourceStartMs: 9000, sourceEndMs: 14000, zoom: 1.6, presentation: "screen", type: "manual" },
    { id: "c", sourceStartMs: 15000, sourceEndMs: 20000, zoom: 1.8, presentation: "loupe", type: "manual" },
  ];
  const r = checkPacing({ slices, zooms, screenSpring: SPRINGS.screenSmooth }, undefined, "balanced");
  assert.ok(!r.issues.some((i) => i.code === "zoom-ping-pong"), JSON.stringify(r.issues));
});

test("snappy allows a cut every few seconds; balanced calls the same cut rate choppy", () => {
  // Eight 5s clips from separate moments: 7 cuts in 40s.
  const slices = Array.from({ length: 8 }, (_, i) => ({
    sourceStartMs: i * 10000,
    sourceEndMs: i * 10000 + 5000,
    timeScale: 1,
  }));
  const input = { slices, zooms: [], screenSpring: SPRINGS.schemaDefault };
  const choppy = (style) => checkPacing(input, undefined, style).issues.find((i) => i.code === "choppy");
  assert.equal(choppy("balanced")?.severity, "warn");
  assert.equal(choppy("snappy"), undefined);
  const busier = {
    ...input,
    slices: Array.from({ length: 16 }, (_, i) => ({
      sourceStartMs: i * 10000,
      sourceEndMs: i * 10000 + 2200,
      timeScale: 1,
    })),
  };
  assert.equal(
    checkPacing(busier, undefined, "snappy").issues.find((i) => i.code === "choppy")?.severity,
    "error",
  );
});
