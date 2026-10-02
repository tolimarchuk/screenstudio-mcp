// Delivery for portrait frames and talking-head loops: the screen kept zoomed
// so it fills a 9:16 or 4:5 frame's width, never so deep a click leaves it, and
// loops cut inside one long beat at sentence breaks, near the target length.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TARGETS,
  actionSafeZoom,
  loopEdges,
  planLoop,
  portraitZoom,
  portraitZooms,
  sentenceBreaks,
  variantProject,
} from "../dist/studio/deliver.js";
import { playbackRange } from "../dist/studio/timeline.js";

const WIDE = 16 / 9;
const TALL = 9 / 16;
const slices = [
  { id: "a", sourceStartMs: 0, sourceEndMs: 10000, timeScale: 1 },
  { id: "b", sourceStartMs: 14000, sourceEndMs: 30000, timeScale: 1 },
];
const zoom = (sourceStartMs, sourceEndMs, level, type = "manual") => ({
  id: `z${sourceStartMs}`,
  sourceStartMs,
  sourceEndMs,
  zoom: level,
  type,
  manualTargetPoint: { x: 0.5, y: 0.5 },
  isDisabled: false,
  presentation: "screen",
});

/** Every visible moment of the slices is under some zoom, and no two zooms overlap. */
function assertCovered(zooms) {
  const sorted = [...zooms].sort((a, b) => a.sourceStartMs - b.sourceStartMs);
  for (let i = 1; i < sorted.length; i++)
    assert.ok(sorted[i].sourceStartMs >= sorted[i - 1].sourceEndMs, `zoom ${i} overlaps the one before`);
  for (const s of slices)
    for (let t = s.sourceStartMs; t < s.sourceEndMs; t += 100)
      assert.ok(
        sorted.some((z) => z.sourceStartMs <= t && z.sourceEndMs > t),
        `${t}ms is not under a zoom`,
      );
}

test("the portrait zoom level comes from the screen's and the frame's aspects", () => {
  assert.equal(portraitZoom(WIDE, TALL), 1.8);
  assert.equal(portraitZoom(WIDE, 4 / 5), 1.5);
  assert.equal(portraitZoom(16 / 10, TALL), 1.7);
  // Not portrait, or a screen no wider than the frame: nothing to fill.
  assert.equal(portraitZoom(WIDE, 1), 1);
  assert.equal(portraitZoom(WIDE, WIDE), 1);
  assert.equal(portraitZoom(TALL, TALL), 1);
});

test("a portrait copy covers every gap between zooms, wider at the opening and ending", () => {
  const existing = [zoom(2000, 6000, 2.2), zoom(18000, 22000, 1.25, "follow-click-groups")];
  const before = structuredClone(existing);
  const fill = portraitZooms(existing, slices, { captureRatio: WIDE, frameRatio: TALL });
  assert.deepEqual(existing, before, "the zooms passed in are not changed");
  assertCovered(fill.zooms);
  assert.equal(fill.level, 1.8);
  assert.equal(fill.wide, 1.55);
  // The deeper zoom is kept; the shallow follow zoom is raised.
  assert.equal(fill.zooms.find((z) => z.id === "z2000").zoom, 2.2);
  assert.equal(fill.zooms.find((z) => z.id === "z18000").zoom, 1.8);
  assert.equal(fill.raised, 1);
  assert.equal(fill.deeper, 1);
  const added = fill.zooms.filter((z) => !z.id.startsWith("z"));
  assert.equal(added.length, fill.added);
  assert.ok(added.every((z) => z.type === "follow-click-groups" && z.presentation === "screen"));
  // The first and last second of playback sit a little wider.
  const first = fill.zooms[0];
  assert.equal(first.sourceStartMs, 0);
  assert.equal(first.zoom, 1.55);
  assert.equal(playbackRange(slices, first.sourceStartMs, first.sourceEndMs).endMs, 1000);
  const last = fill.zooms.at(-1);
  assert.equal(last.sourceEndMs, 30000);
  assert.equal(last.zoom, 1.55);
  assert.equal(last.sourceStartMs, 29000);
  // Between them, the fill level.
  assert.ok(added.filter((z) => z !== first && z !== last).every((z) => z.zoom === 1.8));
});

test("a sliver between two zooms is closed by the zoom before it", () => {
  const fill = portraitZooms([zoom(2000, 6000, 2.2), zoom(6300, 9000, 2.2)], slices, {
    captureRatio: WIDE,
    frameRatio: TALL,
  });
  assertCovered(fill.zooms);
  assert.equal(fill.zooms.find((z) => z.id === "z2000").sourceEndMs, 6300);
  assert.ok(!fill.zooms.some((z) => z.sourceStartMs === 6000));
});

test("fill zooms never go so deep that clicks close together leave the frame", () => {
  const click = (atMs, x, y = 0.5) => ({ atMs, x, y });
  // At 1.8x a 9:16 frame shows 1/1.8 of the screen's width.
  assert.equal(actionSafeZoom([click(1000, 0.3), click(2000, 0.7)], WIDE, TALL, 1.8), 1.8);
  assert.equal(actionSafeZoom([click(1000, 0.25), click(2000, 0.75)], WIDE, TALL, 1.8), 1.6);
  // Clicks far apart in time are separate groups: the follow zoom pans between them.
  assert.equal(actionSafeZoom([click(1000, 0.1), click(9000, 0.9)], WIDE, TALL, 1.8), 1.8);
  // The whole height shows until the zoom passes capture/frame, so height rarely binds.
  assert.equal(actionSafeZoom([click(1000, 0.5, 0.05), click(1500, 0.5, 0.95)], WIDE, TALL, 1.8), 1.8);

  const fill = portraitZooms([], slices, {
    captureRatio: WIDE,
    frameRatio: TALL,
    points: [click(4000, 0.1), click(5000, 0.9), click(20000, 0.25), click(21000, 0.75)],
  });
  // Around the first group (80% of the width apart) the screen stays wide; around the second it zooms only to 1.6x.
  const at = (t) => fill.zooms.find((z) => z.sourceStartMs <= t && z.sourceEndMs > t);
  assert.equal(at(4500), undefined);
  assert.equal(at(20500).zoom, 1.6);
  // Away from those clicks the screen is at the fill level again.
  assert.equal(at(8000).zoom, 1.8);
  assert.equal(at(25000).zoom, 1.8);
  assertCovered(fill.zooms.concat([{ sourceStartMs: 3000, sourceEndMs: 6000 }]));
  // One stretch zooms less; the one around the far-apart clicks stays wide and is counted apart.
  assert.ok(fill.capped >= 1, JSON.stringify(fill));
  assert.ok(fill.leftWide >= 1 && fill.leftWideMs > 0, JSON.stringify(fill));
});

test("portrait targets get the fill zooms and say so; wide targets do not", () => {
  const project = {
    version: 8,
    config: {
      output: { aspectRatio: WIDE, paddingRatio01: 0.08, avoidEmptyZoomArea: false },
      captions: { sizeRatio: 0.04, position01: { x: 0.5, y: 0.85 } },
      defaultLayout: { cutoutCamera: { cutoutCameraSizeRatio01: 1 } },
    },
    scenes: [{ id: "s", slices, zooms: [] }],
  };
  const capture = { widthPt: 1920, heightPt: 1080 };
  const shorts = variantProject(project, "shorts", TARGETS.shorts, { capture });
  assertCovered(shorts.project.scenes[0].zooms);
  assert.match(
    shorts.notes.join(" "),
    /Kept the screen at 1.8x between zooms .* fills the 9:16 frame's width/,
  );
  const portrait = variantProject(project, "portrait", TARGETS.portrait, { capture });
  assert.ok(portrait.project.scenes[0].zooms.some((z) => z.zoom === 1.5));
  const x = variantProject(project, "x", TARGETS.x, { capture });
  assert.equal(x.project.scenes[0].zooms.length, 0);
  assert.ok(!x.notes.some((n) => /Kept the screen/.test(n)));
  const square = variantProject(project, "linkedin", TARGETS.linkedin, { capture });
  assert.equal(square.project.scenes[0].zooms.length, 0);
  assert.equal(project.scenes[0].zooms.length, 0, "the project itself is untouched");
});

// ---------------------------------------------------------------- loops

/** A talking-head recording: clicks every 2s for 32s (one long beat), two long spoken phrases. */
function talkingHead() {
  const clicks = Array.from({ length: 16 }, (_, i) => ({
    atMs: 2000 + i * 2000,
    endMs: 2080 + i * 2000,
    x: 0.4 + (i % 3) * 0.05,
    y: 0.5,
    drag: false,
    button: "left",
  }));
  const speech = [
    {
      startMs: 1000,
      endMs: 17000,
      text: "This is the new board. Every task sits in a lane. Drag one across and it moves. The owner gets a ping right away.",
      words: 23,
    },
    {
      startMs: 17600,
      endMs: 34000,
      text: "Filters stay put when you reload. Search finds anything by name. That is the whole update for this week.",
      words: 20,
    },
  ];
  return {
    projectPath: "/talk.screenstudio",
    sourceDurationMs: 36000,
    capture: { kind: "window", widthPt: 1440, heightPt: 900 },
    sessions: [{ startMs: 0, endMs: 36000, video: "" }],
    clicks,
    typing: [],
    shortcuts: [],
    movement: [],
    screen: { changes: [], active: [] },
    idle: [],
    speech,
  };
}

test("sentence breaks come from punctuation inside long phrases, or from sentences when given", () => {
  const a = talkingHead();
  const breaks = sentenceBreaks(a);
  // Before the first phrase, between phrases, after the last, and after each inner sentence end.
  assert.ok(breaks.includes(850));
  assert.ok(breaks.includes(17300));
  assert.ok(breaks.includes(34150));
  assert.equal(breaks.length, 3 + 3 + 2);
  const given = sentenceBreaks({
    ...a,
    sentences: [
      { startMs: 1000, endMs: 4000, text: "One." },
      { startMs: 4400, endMs: 9000, text: "Two." },
    ],
  });
  assert.deepEqual(given, [850, 4200, 9150]);
  // A still screen mid-sentence is a poorer cut than a pause.
  const edges = loopEdges({ ...a, idle: [{ startMs: 5000, endMs: 6000 }] }, 0, 36000);
  assert.equal(edges.find((e) => e.kind === "still").q, 0.6);
});

test("one long beat loops as a window near the target, cut at sentence breaks, never over maxMs", async () => {
  const a = talkingHead();
  const loop = await planLoop(a, { targetMs: 8000 }, async () => 0.3);
  assert.equal(loop.seamless, false);
  assert.ok(Math.abs(loop.playbackMs - 8000) <= 2500, `${loop.playbackMs}ms against an 8s target`);
  assert.ok(loop.playbackMs <= 15000);
  assert.match(
    loop.notes.join(" "),
    /window of [\d.]+s inside one beat, from a sentence break to a sentence break/,
  );
  assert.match(loop.notes.join(" "), /restart shows a jump/);
  const breaks = sentenceBreaks(a).map(Math.round);
  assert.ok(breaks.includes(loop.sourceRange.startMs), JSON.stringify(loop.sourceRange));
  assert.ok(breaks.includes(loop.sourceRange.endMs), JSON.stringify(loop.sourceRange));

  const tight = await planLoop(a, { targetMs: 12000, maxMs: 9000 }, async () => 0.3);
  assert.ok(tight.playbackMs <= 9000, String(tight.playbackMs));
  assert.ok(tight.playbackMs >= 4000);
});

test("a window inside one beat whose frames match loops seamlessly", async () => {
  const a = talkingHead();
  const loop = await planLoop(a, { targetMs: 8000 }, async (first, last) =>
    first > 5000 && last - first > 6000 && last - first < 10000 ? 0.95 : 0.3,
  );
  assert.equal(loop.seamless, true, loop.notes.join(" "));
  assert.match(loop.notes[0], /window inside one beat/);
  assert.ok(loop.playbackMs <= 15000);
});

test("portrait copies turn loupes into camera zooms on the same target", async () => {
  const { portraitZooms } = await import("../dist/studio/deliver.js");
  const slices = [{ sourceStartMs: 0, sourceEndMs: 30000, timeScale: 1 }];
  const loupe = {
    id: "l",
    sourceStartMs: 10000,
    sourceEndMs: 15000,
    zoom: 1.6,
    type: "manual",
    presentation: "loupe",
    manualTargetPoint: { x: 0.4, y: 0.3 },
  };
  const out = portraitZooms([loupe], slices, { captureRatio: 16 / 9, frameRatio: 9 / 16 });
  const z = out.zooms.find((x) => x.id === "l");
  assert.equal(out.loupesConverted, 1);
  assert.equal(z.presentation, "screen");
  assert.ok(z.zoom >= out.level);
  assert.deepEqual(z.manualTargetPoint, { x: 0.4, y: 0.3 });
});

test("the talking head with sentences, as the context always gives them, still loops near each target", async () => {
  // Each phrase split into its sentences, words evenly spread, a short breath between.
  const base = talkingHead();
  const sentences = base.speech.flatMap((p) => {
    const parts = p.text.match(/[^.]+\./g).map((t) => t.trim());
    const words = parts.reduce((n, t) => n + t.split(" ").length, 0);
    let t = p.startMs;
    return parts.map((text) => {
      const len = ((p.endMs - p.startMs) * text.split(" ").length) / words;
      const s = {
        startMs: Math.round(t),
        endMs: Math.round(t + len - 150),
        text,
        words: text.split(" ").length,
      };
      t += len;
      return s;
    });
  });
  const a = { ...base, sentences };
  const inside = (ms) => sentences.some((s) => ms > s.startMs + 20 && ms < s.endMs - 20);
  const lengths = [];
  for (const targetMs of [8000, 12000]) {
    const loop = await planLoop(a, { targetMs }, async () => 0.3);
    assert.ok(Math.abs(loop.playbackMs - targetMs) <= 3000, `${loop.playbackMs}ms against ${targetMs}`);
    assert.ok(!inside(loop.sourceRange.startMs), JSON.stringify(loop.sourceRange));
    assert.ok(!inside(loop.sourceRange.endMs), JSON.stringify(loop.sourceRange));
    lengths.push(loop.playbackMs);
  }
  assert.ok(lengths[1] > lengths[0], JSON.stringify(lengths));
});
