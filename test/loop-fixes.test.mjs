// Loops: windows get checked when beat edges fail, sentence beats loop at
// sentence breaks near the target, a matching fallback is seamless, and
// planning stays fast on long recordings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planLoop } from "../dist/studio/deliver.js";
import { phrases, sentences } from "../dist/studio/transcript.js";

const base = (end, extra = {}) => ({
  projectPath: "/loop.screenstudio",
  sourceDurationMs: end,
  capture: { kind: "window", widthPt: 1440, heightPt: 900 },
  sessions: [{ startMs: 0, endMs: end, video: "" }],
  clicks: [],
  typing: [],
  shortcuts: [],
  movement: [],
  screen: { changes: [], active: [] },
  idle: [],
  ...extra,
});
const click = (atMs) => ({ atMs, endMs: atMs + 80, x: 0.4, y: 0.5, drag: false, button: "left" });

test("when the beat-edge pairs do not match, windows inside beats get checked", async () => {
  const a = base(42000, {
    clicks: [click(1000), click(3500)],
    typing: [{ startMs: 8000, endMs: 38000, chars: 400, x: 0.5, y: 0.5 }],
    screen: {
      changes: [],
      active: [
        { startMs: 8000, endMs: 12000 },
        { startMs: 22000, endMs: 38000 },
      ],
    },
  });
  const asked = [];
  const loop = await planLoop(a, { targetMs: 8000 }, async (first, last) => {
    asked.push([first, last]);
    return first >= 12000 && last <= 22000 ? 0.97 : 0.3;
  });
  assert.equal(loop.seamless, true, loop.notes.join(" "));
  assert.ok(
    loop.sourceRange.startMs >= 12000 && loop.sourceRange.endMs <= 22000,
    JSON.stringify(loop.sourceRange),
  );
  assert.ok(asked.length > 1);
});

/** A talk of short sentences 150ms apart: one beat per sentence. */
function talk() {
  const lines = [
    "This is the release page for our mobile app.",
    "Every build that passed the checks overnight shows up here.",
    "You pick the build and the notes fill themselves in.",
    "Before you publish the page shows who gets the update.",
    "Nobody has to write a changelog by hand anymore.",
    "Hit publish and every customer has it within a minute.",
    "That is the whole release flow from start to finish.",
  ];
  const words = [];
  let t = 600;
  for (const line of lines) {
    for (const w of line.split(" ")) {
      words.push({ session: 0, index: words.length, text: ` ${w}`, startMs: t, endMs: t + 260 });
      t += 320;
    }
    t += 150;
  }
  return base(t + 2500, { speech: phrases(words, 600), sentences: sentences(words) });
}

test("a talk split per sentence loops at sentence breaks, near each target", async () => {
  const a = talk();
  const inside = (ms) => a.sentences.some((s) => ms > s.startMs + 20 && ms < s.endMs - 20);
  const lengths = [];
  for (const targetMs of [8000, 12000, 15000]) {
    const loop = await planLoop(a, { targetMs, maxMs: 15000 }, async () => 0.3);
    assert.ok(!inside(loop.sourceRange.startMs), `starts mid-sentence at ${loop.sourceRange.startMs}`);
    assert.ok(!inside(loop.sourceRange.endMs), `ends mid-sentence at ${loop.sourceRange.endMs}`);
    assert.ok(Math.abs(loop.playbackMs - targetMs) <= 3000, `${loop.playbackMs} for ${targetMs}`);
    lengths.push(loop.playbackMs);
  }
  assert.ok(lengths[2] > lengths[0], JSON.stringify(lengths));
});

test("a fallback whose frames match is seamless, and a short beat holds toward the target", async () => {
  const a = base(20000, {
    clicks: [click(3000)],
    screen: { changes: [{ atMs: 3200, score: 0.5, kind: "page" }], active: [] },
    idle: [
      { startMs: 0, endMs: 2900 },
      { startMs: 3600, endMs: 20000 },
    ],
  });
  const loop = await planLoop(a, { targetMs: 8000 }, async () => 0.95);
  assert.equal(loop.seamless, true, loop.notes.join(" "));
  assert.ok(!loop.notes.join(" ").includes("restart shows a jump"));
  assert.ok(Math.abs(loop.playbackMs - 8000) <= 500, String(loop.playbackMs));

  // Unreadable frames, nothing compared: the note says why no join was checked.
  const blind = await planLoop(a, { targetMs: 8000 }, async () => {
    throw new Error("no video");
  });
  assert.equal(blind.seamless, false);
  assert.equal(blind.ssim, null);
  assert.match(blind.notes.join(" "), /frames could not be read/);
});

test("planning a loop over an hour-long beat stays quick", async () => {
  const hour = 60 * 60 * 1000;
  const active = [];
  for (let t = 1000; t < hour; t += 2000) active.push({ startMs: t, endMs: t + 300 });
  const a = base(hour + 3000, {
    typing: [{ startMs: 500, endMs: hour, chars: 20000, x: 0.5, y: 0.5 }],
    screen: { changes: [], active },
  });
  const t0 = Date.now();
  await planLoop(a, { targetMs: 8000 }, async () => 0.3);
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0}ms`);
});
