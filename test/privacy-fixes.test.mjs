// Privacy: random hex keys are always found, and the preview sheet rings only
// what is on screen, fills every blur (hand-made ones too), keeps labels off
// the frame, fits portrait frames, and never costs the scan's result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { findSensitive, hexKey, previewMarks, sheetFilter, withPreview } from "../dist/studio/redact.js";

const box = (x, y) => ({ x, y, width: 0.2, height: 0.02 });
const det = (firstSeenMs, lastSeenMs, extra = {}) => ({
  kind: "email",
  preview: "a@…",
  startMs: firstSeenMs - 1000,
  endMs: lastSeenMs + 1000,
  firstSeenMs,
  lastSeenMs,
  box: box(0.1, 0.1),
  ...extra,
});

test("a preview frame rings only the findings seen in it, and still fills every blur", () => {
  const d = [det(1000, 1000), det(2000, 2000, { preview: "b@…", box: box(0.1, 0.5) })];
  const at1 = previewMarks(1000, d, []);
  assert.deepEqual(
    at1.marks.map((m) => m.label),
    ["1 email a@…"],
  );
  assert.equal(at1.fills.length, 2, "both blurs are on at 1s");
  const at2 = previewMarks(2000, d, []);
  assert.deepEqual(
    at2.marks.map((m) => m.label),
    ["2 email b@…"],
  );
});

/** A seeded generator, so the sample of random keys is the same on every run. */
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("random hex keys of every common length are found", () => {
  const next = seeded(20261002);
  const hex = (n) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(next() * 16)]).join("");
  for (const length of [32, 64, 128]) {
    const missed = [];
    for (let i = 0; i < 10000; i++) {
      const key = hex(length);
      if (!hexKey(key)) missed.push(key);
    }
    assert.deepEqual(missed, [], `${length}-digit keys`);
  }
  // Truly random ones too, and keys with a long digit run at an edge.
  for (let i = 0; i < 2000; i++) assert.ok(hexKey(randomBytes(32).toString("hex")));
  for (const key of [
    "4ef91d7fa34d17168981436182359123",
    "3a9178245601b8392047561c38290147",
    "9f12345678901234567a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5",
  ]) {
    assert.ok(hexKey(key), key);
    assert.deepEqual(
      findSensitive(`DD_API_KEY ${key}`).map((m) => m.kind),
      ["hex-secret"],
      key,
    );
  }
  // IDs run into digits, or starting a link's path segment, are still not keys.
  assert.ok(!hexKey("1973456789012345678deadbeef0123456789abc", "x.com/i/status/"));
  assert.deepEqual(findSensitive("status/1973456789012345678deadbeef0123456789abc"), []);
});

test("blur masks already on the track are filled in the preview", () => {
  const d = [det(5000, 5000)];
  const existing = [
    { id: "m1", startMs: 0, endMs: 10000, type: "sensitive-data", rects: [box(0.6, 0.6)] },
    { id: "m2", startMs: 0, endMs: 10000, type: "highlight", rects: [box(0.3, 0.3)] },
    { id: "m3", startMs: 0, endMs: 10000, disabled: true, rects: [box(0.3, 0.7)] },
    { id: "m4", startMs: 0, endMs: 10000 },
  ];
  const ops = [
    { op: "updateItem", track: "masks", id: "m1", fields: { rects: [box(0.6, 0.6), box(0.1, 0.1)] } },
  ];
  const marks = previewMarks(5000, d, ops, existing);
  assert.deepEqual(
    marks.fills.map((r) => [r.x, r.y]),
    [
      [0.6, 0.6],
      [0.1, 0.1],
      [0.1, 0.1],
    ],
  );
  assert.equal(marks.unknown, 1, "the mask with no known area is counted");
  // Outside the mask's time nothing of it is filled.
  assert.equal(previewMarks(5000, d, [], [{ ...existing[0], startMs: 6000 }]).fills.length, 1);
});

test("portrait and square frames get cells as tall as they need", () => {
  const frame = { atMs: 0, fills: [], marks: [] };
  const portrait = sheetFilter([frame, frame, frame], { frameRatio: 1170 / 2532 });
  assert.match(portrait.graph, /scale=960:2078/);
  assert.equal(portrait.cols, 3);
  const square = sheetFilter([frame], { frameRatio: 1 });
  assert.match(square.graph, /scale=960:960/);
  assert.equal(sheetFilter([frame, frame]).cols, 2);
});

test("labels and the time sit under the frame, never over it", () => {
  const marks = [{ box: box(0.1, 0.4), label: "1 email a@…" }];
  const sheet = sheetFilter([{ atMs: 1000, fills: [], marks, labelFiles: ["/tmp/l/0-0.txt"] }], {
    font: "/System/Library/Fonts/Helvetica.ttc",
  });
  const ch = 540;
  const ys = (re) => [...sheet.graph.matchAll(re)].map((m) => Number(m[1]));
  // The full label and the time are drawn below the frame's 540px.
  for (const y of ys(/textfile='[^']+':expansion=none:[^,]*:y=(\d+)/g)) assert.ok(y >= ch, `label at ${y}`);
  for (const y of ys(/text='1\.0s'[^,]*:y=(\d+)/g)) assert.ok(y >= ch, `time at ${y}`);
  // On the frame only the number, outlined, with no box behind it.
  assert.match(sheet.graph, /text='1':fontsize=\d+:fontcolor=0xffd60a:borderw/);
  assert.ok(!sheet.graph.includes("box=1"));
  assert.ok(sheet.cellHeight > ch);
  // Many findings: the strip lists eight lines at most, then says how many more.
  const many = Array.from({ length: 12 }, (_, i) => ({
    box: box(0.1, 0.05 * i),
    label: `${i + 1} email x@…`,
  }));
  const crowded = sheetFilter(
    [{ atMs: 0, fills: [], marks: many, labelFiles: many.map((_, i) => `/tmp/l/${i}.txt`) }],
    {
      font: "/System/Library/Fonts/Helvetica.ttc",
    },
  );
  assert.match(crowded.graph, /text='\+5 more'/);
});

test("a preview that cannot be drawn keeps the scan's result and says why", async () => {
  const result = { detections: [1], ops: [2], notes: ["Found 1."], applied: { checkpointId: "c1" } };
  const out = await withPreview(result, async () => {
    throw new Error("ffmpeg exited with code 1\nmore detail");
  });
  assert.deepEqual(out.ops, [2]);
  assert.deepEqual(out.applied, { checkpointId: "c1" });
  assert.deepEqual(out.notes, ["Found 1.", "Preview could not be drawn: ffmpeg exited with code 1"]);
  assert.deepEqual(result.notes, ["Found 1."], "the result passed in is not changed");
  assert.equal(await withPreview(result, async () => "sheet"), "sheet");
});
