// Recording analysis and transcript edits, on a window-recording fixture laid
// out like a real Screen Studio project (global screen points, window bounds).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeRecording, framePoint, isPrintable, keyName } from "../dist/studio/recording.js";
import { applyEdits, fillers, phrases, withRemoved } from "../dist/studio/transcript.js";

const j = JSON.stringify;
const fixture = new URL("./fixtures/window-recording", import.meta.url).pathname;

async function withFfmpeg(script, fn) {
  const dir = await mkdtemp(join(tmpdir(), "ssmcp-analysis-"));
  const before = process.env.SCREENSTUDIO_FFMPEG;
  try {
    if (script) {
      await writeFile(join(dir, "ffmpeg"), script);
      await chmod(join(dir, "ffmpeg"), 0o755);
    }
    process.env.SCREENSTUDIO_FFMPEG = join(dir, "ffmpeg");
    return await fn(join(dir, "state"));
  } finally {
    if (before === undefined) delete process.env.SCREENSTUDIO_FFMPEG;
    else process.env.SCREENSTUDIO_FFMPEG = before;
    await rm(dir, { recursive: true, force: true });
  }
}
// An ffmpeg that reads a still video: no scene changes.
const stillVideo = "#!/bin/sh\nexit 0\n";

test("screen points map into the frame; points outside it are not clamped onto the edge", () => {
  const b = { x: 560, y: 250, width: 1440, height: 900 };
  assert.deepEqual(framePoint(1280, 700, b), { x: 0.5, y: 0.5 });
  assert.equal(framePoint(1300, 1420, b), null);
  assert.equal(framePoint(2300, 600, b), null);
  assert.deepEqual(framePoint(2005, 700, b), { x: 1, y: 0.5 });
  assert.deepEqual(framePoint(10, 10, { width: 100, height: 100 }), { x: 0.1, y: 0.1 });
});

test("special keys get readable names and never count as typed text", () => {
  assert.equal(keyName(""), "Left");
  assert.equal(keyName("\u007f"), "Delete");
  assert.equal(keyName("\u001b"), "Esc");
  assert.equal(keyName(""), "F1");
  assert.equal(keyName(""), "F12");
  assert.equal(keyName(" "), "Space");
  assert.equal(keyName("k"), "K");
  for (const c of ["", "\u007f", "\u001b", "\r", "\t", "", ""]) assert.ok(!isPrintable(c), j(c));
  for (const c of ["a", " ", "é", "😀", "Ж"]) assert.ok(isPrintable(c), c);
});

test("clicks outside the window are dropped, drags count where they are visible", () =>
  withFfmpeg(stillVideo, async () => {
    const a = await analyzeRecording(fixture);
    assert.deepEqual(
      a.clicks.map((c) => [c.atMs, c.x, c.y, c.drag]),
      [
        [1000, 0.376, 0.598, false],
        // 3000: a click on the Dock is not in the video.
        [4000, 1, 0.5, false],
        [5000, 0.097, 0.278, true], // dragged in from another app: where it lands
        [6000, 0.167, 0.167, true], // dragged out: where it started
        [16500, 0.069, 0.111, false], // the window moved to the corner at 16s
      ],
    );
    assert.ok(a.clicks.every((c) => c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1));
  }));

test("held keys, Delete and navigation do not inflate typing bursts", () =>
  withFfmpeg(stillVideo, async () => {
    const a = await analyzeRecording(fixture);
    assert.deepEqual(a.typing, [{ startMs: 7000, endMs: 7600, chars: 3, x: 0.167, y: 0.167 }]);
    assert.deepEqual(
      a.shortcuts.map((s) => `${s.atMs} ${s.keys}`),
      ["8000 ⌘Left", "13000 Esc", "13500 Up", "14000 Delete", "15000 Return", "15500 F5"],
    );
    const text = await analyzeRecording(fixture, { includeText: true });
    // "hi", Backspace, "o", then "o" held down: the repeats type but are not new keystrokes.
    assert.equal(text.typing[0].text, "hoooo");
    assert.equal(text.typing[0].chars, 3);
  }));

test("cursor travel outside the window is not activity", () =>
  withFfmpeg(stillVideo, async () => {
    const a = await analyzeRecording(fixture);
    assert.deepEqual(a.movement, [{ startMs: 1000, endMs: 1300, distance01: 0.208 }]);
    // 9-12s the cursor wanders over another screen: that stretch is dead air.
    assert.ok(
      a.idle.some((i) => i.startMs === 8200 && i.endMs === 12850),
      JSON.stringify(a.idle),
    );
    assert.equal(a.screen.unavailable, undefined);
  }));

test("a missing ffmpeg keeps the input analysis and never offers the unread video as dead air", () =>
  withFfmpeg(null, async (cacheDir) => {
    const a = await analyzeRecording(fixture, { cacheDir });
    assert.equal(a.screen.unavailable, "session 0: ffmpeg not found");
    assert.equal(a.clicks.length, 5);
    assert.equal(a.typing.length, 1);
    assert.deepEqual(a.idle, []);
    // A degraded analysis is not cached, so installing ffmpeg fixes the next run.
    await assert.rejects(readdir(cacheDir));
  }));

test("typed text never reaches the disk cache", () =>
  withFfmpeg(stillVideo, async (cacheDir) => {
    await analyzeRecording(fixture, { includeText: true, cacheDir });
    await assert.rejects(readdir(cacheDir));
    await analyzeRecording(fixture, { cacheDir });
    const files = await readdir(cacheDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^analysis-[0-9a-f]{24}\.json$/);
  }));

const session = [
  { index: 0, text: " So", startMs: 0, endMs: 300 },
  { index: 1, text: " um,", startMs: 300, endMs: 1000 },
  { index: 2, text: " this", startMs: 1000, endMs: 1300 },
  { index: 3, text: " is", startMs: 1300, endMs: 1500 },
  { index: 4, text: " Screen Stuido.", startMs: 1500, endMs: 2200 },
];

test("caption edits fix words and report what they removed", () => {
  const r = applyEdits(session, [
    { index: 1, remove: true },
    { index: 4, text: " Screen Studio." },
  ]);
  assert.deepEqual(
    r.transcript.map((w) => w.text),
    [" So", " this", " is", " Screen Studio."],
  );
  assert.deepEqual(r.removed, [session[1]]);
  assert.deepEqual(applyEdits(session, [{ index: 9, remove: true }]), { error: "Word 9 does not exist." });
  // Runs inside the editor page too, so it must not depend on anything around it.
  const inPage = new Function(`const applyEdits = ${applyEdits}; return applyEdits;`)();
  assert.deepEqual(inPage(session, [{ index: 1, remove: true }]).removed, [session[1]]);
});

test("words removed from the captions stay protected as speech", () => {
  const offsets = [5000];
  const captions = applyEdits(session, [
    { index: 1, remove: true },
    { index: 2, remove: true },
    { index: 3, remove: true },
  ]).transcript.map((w) => ({ session: 0, ...w, startMs: w.startMs + 5000, endMs: w.endMs + 5000 }));
  // Without them the sentence splits at a 1.2s "pause" a cut could remove.
  assert.equal(phrases(captions, 600).length, 2);
  const removed = { 0: session.slice(1, 4) };
  const spoken = withRemoved(captions, removed, offsets);
  assert.equal(phrases(spoken, 600).length, 1);
  assert.deepEqual(
    fillers(spoken).map((w) => [w.startMs, w.endMs]),
    [[5300, 6000]],
  );
  // Undo in the app (or a new transcript) puts a word back: no duplicate.
  const restored = [...captions, { session: 0, ...session[1], startMs: 5300, endMs: 6000 }];
  assert.equal(withRemoved(restored, removed, offsets).filter((w) => w.index === 1).length, 1);
});
