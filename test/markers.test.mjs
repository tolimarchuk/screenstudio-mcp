// Recording markers: wall-clock stamps mapped onto source time, read back by
// analysis, used to pin narration lines and to size beats to their lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeRecording, placeMarkers, recordingMarkers } from "../dist/studio/recording.js";
import { lastHoldMs } from "../dist/studio/desktop.js";
import { beatFor, pinLinesToMarkers, scriptNotes } from "../dist/studio/narration.js";

const fixture = new URL("./fixtures/window-recording", import.meta.url).pathname;
const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.UTC(2026, 9, 2, 0, 14, 6);

/** A project with two window sessions: 5s, a 5s pause, then 4s. */
async function twoSessionProject(markers) {
  const dir = await mkdtemp(join(tmpdir(), "ssmcp-markers-"));
  const project = join(dir, "Demo.screenstudio");
  const session = (i, start, duration) => ({
    durationMs: duration,
    processTimeStartMs: 1000 + start - T0,
    unixStartMs: start,
    unixEndMs: start + duration,
    outputFilename: `channel-1-window-${i}.mp4`,
    initialWindowBounds: { x: 0, y: 0, width: 1440, height: 900 },
  });
  await cp(fixture, project, { recursive: true });
  await writeFile(
    join(project, "recording", "metadata.json"),
    JSON.stringify({
      recorders: [
        { id: "w", type: "window", sessions: [session(0, T0, 5000), session(1, T0 + 10000, 4000)] },
      ],
    }),
  );
  if (markers !== undefined)
    await writeFile(
      join(project, "recording-markers.json"),
      JSON.stringify({ json: markers, meta: { values: { "0.date": ["Date"] }, v: 1 } }),
    );
  return { dir, project };
}

test("markers map to source ms across sessions; a marker in a pause snaps to the next session", async () => {
  const { dir, project } = await twoSessionProject([
    { id: "late", date: iso(T0 + 11500) },
    { id: "first", date: iso(T0 + 2000) },
    { id: "paused", date: iso(T0 + 7000) },
    { id: "after", date: iso(T0 + 60000) },
    { id: "broken", date: "not a date" },
  ]);
  try {
    assert.deepEqual(await recordingMarkers(project), [
      { id: "first", sourceMs: 2000 },
      { id: "paused", sourceMs: 5000 },
      { id: "late", sourceMs: 6500 },
      { id: "after", sourceMs: 9000 },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a project without a markers file, or a recording without wall-clock times, has no markers", async () => {
  const { dir, project } = await twoSessionProject(undefined);
  try {
    assert.deepEqual(await recordingMarkers(project), []);
    assert.deepEqual(await recordingMarkers(fixture), []);
    assert.deepEqual(placeMarkers([{ id: "a", date: iso(T0) }], [{ startMs: 0, endMs: 1000 }]), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("analysis returns markers and reads a changed markers file instead of a stale cache", async () => {
  const { dir, project } = await twoSessionProject([{ id: "a", date: iso(T0 + 1000) }]);
  const before = process.env.SCREENSTUDIO_FFMPEG;
  try {
    await writeFile(join(dir, "ffmpeg"), "#!/bin/sh\nexit 0\n");
    await chmod(join(dir, "ffmpeg"), 0o755);
    process.env.SCREENSTUDIO_FFMPEG = join(dir, "ffmpeg");
    const cacheDir = join(dir, "state");
    const a = await analyzeRecording(project, { cacheDir });
    assert.deepEqual(a.markers, [{ id: "a", sourceMs: 1000 }]);
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(
      join(project, "recording-markers.json"),
      JSON.stringify({
        json: [
          { id: "a", date: iso(T0 + 1000) },
          { id: "b", date: iso(T0 + 12000) },
        ],
      }),
    );
    const b = await analyzeRecording(project, { cacheDir });
    assert.deepEqual(
      b.markers.map((m) => m.sourceMs),
      [1000, 7000],
    );
    assert.deepEqual((await analyzeRecording(fixture)).markers, []);
  } finally {
    if (before === undefined) delete process.env.SCREENSTUDIO_FFMPEG;
    else process.env.SCREENSTUDIO_FFMPEG = before;
    await rm(dir, { recursive: true, force: true });
  }
});

test("the last hold stretches so a beat lasts as long as its line, never shorter than planned", () => {
  assert.equal(lastHoldMs(1200, 2500, 6000), 3500);
  assert.equal(lastHoldMs(1200, 5500, 6000), 1200);
  assert.equal(lastHoldMs(1200, 9000, 6000), 1200);
});

test("lines without a time are pinned 300ms after the marker with their index", () => {
  const markers = [
    { id: "a", sourceMs: 1000 },
    { id: "b", sourceMs: 6000 },
    { id: "c", sourceMs: 9000 },
  ];
  const { lines, notes } = pinLinesToMarkers(
    [{ text: "One." }, { text: "Two.", sourceMs: 6500 }, { text: "Three." }],
    markers,
  );
  assert.deepEqual(
    lines.map((l) => l.sourceMs),
    [1300, 6500, 9300],
  );
  assert.equal(notes.length, 2);
  assert.match(notes[1], /Line 3 starts 300ms after marker 3/);
  assert.throws(
    () => pinLinesToMarkers([{ text: "a" }, { text: "b" }], markers.slice(0, 1)),
    /Line 2 has no time and the recording has 1 marker\./,
  );
});

test("a voiced script reports each beat's length and calls out lines spoken too fast", () => {
  assert.deepEqual(beatFor("Three plans, billed monthly.", 2000), { beatMs: 2400, wordsPerSecond: 2 });
  const fast = beatFor("one two three four five six seven eight nine ten", 2000);
  const r = scriptNotes([
    { index: 1, ...beatFor("Three plans, billed monthly.", 2000) },
    { index: 2, ...fast },
  ]);
  assert.equal(r.totalMs, 4800);
  assert.ok(r.notes.some((n) => /Line 2 runs at 5 words a second/.test(n)));
  assert.ok(!r.notes.some((n) => /Line 1 runs/.test(n)));
  assert.ok(r.notes.some((n) => /about 4.8s/.test(n)));
});

test("the fixture is untouched by marker tests", async () => {
  const meta = JSON.parse(await readFile(join(fixture, "recording", "metadata.json"), "utf8"));
  assert.equal(meta.recorders[1].sessions[0].unixStartMs, undefined);
});

test("an orphan or skipped marker does not shift the lines after it", async () => {
  const { liveMarkers } = await import("../dist/studio/narration.js");
  const markers = [
    { id: "b1", sourceMs: 1000 },
    { id: "b2-failed", sourceMs: 5000 },
    { id: "b2", sourceMs: 6000 },
    { id: "b3-wrong", sourceMs: 12000 },
    { id: "b3", sourceMs: 16000 },
  ];
  // b2's first try failed before any input; b3's first take was redone after input.
  const actionTimes = [1500, 6500, 12500, 16500];
  const live = liveMarkers(markers, { actionTimes, skip: ["b3-wrong"] });
  assert.deepEqual(
    live.markers.map((m) => m.id),
    ["b1", "b2", "b3"],
  );
  assert.ok(live.notes.some((n) => /Skipped marker b2-failed: nothing was clicked or typed/.test(n)));
  assert.ok(live.notes.some((n) => /Skipped marker b3-wrong, as asked/.test(n)));
  const { lines } = pinLinesToMarkers([{ text: "one" }, { text: "two" }, { text: "three" }], live.markers);
  assert.deepEqual(
    lines.map((l) => l.sourceMs),
    [1300, 6300, 16300],
  );
  // Without input times nothing is guessed.
  assert.equal(liveMarkers(markers).markers.length, 5);
  assert.match(liveMarkers(markers, { skip: ["nope"] }).notes[0], /No marker nope/);
});
