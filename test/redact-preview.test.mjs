// Auto-redact, as found on a real talking-head recording: post IDs in links
// are not keys, real hex keys and hashes still are, and the preview is a sheet
// of the frames that show findings, big enough to see every box.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contactSheet,
  findSensitive,
  hexKey,
  previewFrames,
  previewMarks,
  sheetFilter,
} from "../dist/studio/redact.js";

const run = promisify(execFile);
const kinds = (text, ...rest) => findSensitive(text, ...rest).map((m) => `${m.kind}:${m.value}`);

test("post IDs and other digit runs in links are not keys", () => {
  for (const text of [
    "https://x.com/someone/status/1973456789012345678",
    "x.com/someone/status/1973456789012345678?s=46&t=Ab3dE5fG7hJ9kL1mN3pQ5r",
    // OCR runs two IDs together, or an ID into a hex-looking word beside it.
    "x.com/i/status/19734567890123456781973456789012345678",
    "status/1973456789012345678deadbeef0123456789abc",
    "order 19734567890123456789012345678901234567890",
    // A path segment of digits that happens to pass the card checksum.
    "x.com/someone/status/4242424242424242",
  ])
    assert.deepEqual(kinds(text), [], text);
  assert.ok(!hexKey("19734567890123456789012345678901234567890"), "digits alone");
  assert.ok(
    !hexKey("1973456789012345678a19734567890123b", "x.com/i/status/"),
    "an ID starting a link's path",
  );
  assert.ok(!hexKey("3f9a2b7c1d4e5f60718293a4b5c6d7e"), "under 32 hex digits");
});

test("real hex keys and hashes are still found", () => {
  for (const hex of [
    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", // SHA-256
    "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12", // SHA-1, a full commit hash
    "D41D8CD98F00B204E9800998ECF8427E", // MD5 in capitals
    "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318", // a wallet private key
  ]) {
    assert.deepEqual(kinds(`key ${hex}`), [`hex-secret:${hex}`], hex);
    assert.ok(hexKey(hex), hex);
  }
  // In a link path, too, while a token in its query is still a link carrying a token.
  assert.deepEqual(kinds("github.com/acme/app/commit/2fd4e1c67a2d28fced849ee1bb76e7391b93eb12"), [
    "hex-secret:2fd4e1c67a2d28fced849ee1bb76e7391b93eb12",
  ]);
  assert.deepEqual(kinds("https://x.com/i/status/1973456789012345678?token=abc123def456"), [
    "url-token:https://x.com/i/status/1973456789012345678?token=abc123def456",
  ]);
  // A secret setting is still named as one, with the hex value hidden.
  assert.deepEqual(kinds("SECRET_KEY=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"), [
    "credential:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  ]);
});

const box = (x, y) => ({ x, y, width: 0.2, height: 0.02 });
const det = (firstSeenMs, lastSeenMs, extra = {}) => ({
  kind: "email",
  label: "email address",
  preview: "ja…om",
  startMs: firstSeenMs - 500,
  endMs: lastSeenMs + 500,
  firstSeenMs,
  lastSeenMs,
  frames: 2,
  box: box(0.1, 0.1),
  confidence: 1,
  reason: "",
  ...extra,
});
const seen = {
  kind: "email",
  label: "email address",
  key: "k",
  preview: "ja…om",
  box: box(0.1, 0.1),
  confidence: 1,
};
const samples = (n, withFindings) =>
  Array.from({ length: n }, (_, i) => ({ atMs: i * 1000, findings: withFindings(i) ? [seen] : [] }));

test("the preview shows frames with findings, every finding at least once, at most six", () => {
  // Findings at 2-4s and 7-8s; nothing elsewhere.
  const s = samples(12, (i) => (i >= 2 && i <= 4) || i === 7 || i === 8);
  const d = [det(2000, 4000), det(7000, 8000)];
  const picked = previewFrames(s, d, 6);
  assert.ok(
    picked.every((i) => s[i].findings.length),
    "only frames that show something",
  );
  for (const x of d) assert.ok(picked.some((i) => s[i].atMs >= x.firstSeenMs && s[i].atMs <= x.lastSeenMs));
  assert.deepEqual(
    picked,
    [...picked].sort((a, b) => a - b),
    "in time order",
  );
  // Both ends of each finding: the first frame covering it, then the last it was seen in.
  assert.deepEqual(picked, [2, 4, 7, 8]);

  // Twenty findings in twenty frames fit six frames, never more.
  const many = samples(20, () => true);
  const twenty = Array.from({ length: 20 }, (_, i) => det(i * 1000, i * 1000));
  assert.equal(previewFrames(many, twenty, 6).length, 6);
  assert.deepEqual(
    previewFrames(
      samples(5, () => false),
      [],
      6,
    ),
    [],
  );
});

test("preview boxes fill every blur and label findings by number, kind and masked value only", () => {
  const value = "jane.doe@example.com";
  const d = [det(1000, 2000), det(1000, 1000, { kind: "hex-secret", preview: "9f…08", box: box(0.5, 0.5) })];
  const ops = [
    { op: "addMask", type: "sensitive-data", startMs: 500, endMs: 2500, rects: [box(0.09, 0.09)] },
  ];
  const at1 = previewMarks(1000, d, ops);
  assert.equal(at1.fills.length, 3, "the mask rect and both findings");
  assert.deepEqual(
    at1.marks.map((m) => m.label),
    ["1 email ja…om", "2 hex-secret 9f…08"],
  );
  assert.ok(at1.marks.every((m) => !m.label.includes(value)));
  // By 2.4s neither finding is on screen, so nothing is ringed, but the first one's blur is still filled.
  const at24 = previewMarks(2400, d, ops);
  assert.deepEqual(at24.marks, []);
  assert.equal(at24.fills.length, 2, "the mask rect and the first finding's blur");
});

test("the sheet is two cells across, each at least 960px, with thick rings and labels from files", () => {
  const frame = (atMs) => ({
    atMs,
    fills: [box(0.1, 0.1)],
    marks: [{ box: box(0.1, 0.1), label: "1 email ja…om" }],
    labelFiles: [`/tmp/labels/${atMs}.txt`],
  });
  const sheet = sheetFilter([frame(0), frame(1000), frame(2000)], {
    cellWidth: 640,
    font: "/System/Library/Fonts/Helvetica.ttc",
  });
  assert.equal(sheet.cellWidth, 960, "never narrower than 960");
  assert.equal(sheet.cols, 2);
  assert.equal(sheet.rows, 2);
  assert.match(sheet.graph, /scale=960:540/);
  assert.match(sheet.graph, /color=0xff3b30:t=fill/);
  assert.match(sheet.graph, /color=0xffd60a:t=4/);
  assert.match(sheet.graph, /color=black:t=8/);
  assert.match(sheet.graph, /textfile='\/tmp\/labels\/1000.txt':expansion=none/);
  assert.ok(!sheet.graph.includes("ja…om"), "labels are read from files, never inlined");
  // Each cell is the frame plus a strip under it for the time and the labels.
  assert.ok(sheet.cellHeight > 540);
  assert.ok(sheet.graph.includes(`xstack=inputs=3:layout=0_0|968_0|0_${sheet.cellHeight + 8}`), sheet.graph);
  // A tiny box is never drawn as 0px, which drawbox would read as the whole frame.
  assert.match(
    sheet.graph,
    /drawbox=x='0.1\*iw':y='0.1\*ih':w='max\(2,0.2\*iw\)':h='max\(2,0.02\*ih\)':color=0xff3b30/,
  );
  // Without a font the boxes are drawn and the labels left out.
  const plain = sheetFilter([frame(0)], { font: null });
  assert.ok(!plain.graph.includes("drawtext"));
  assert.match(plain.graph, /color=0xffd60a/);
  assert.throws(() => sheetFilter([]), /No frames/);
});

test("contactSheet renders a sheet of big cells with ffmpeg", async (t) => {
  const ffmpeg = await run("ffmpeg", ["-hide_banner", "-filters"]).catch(() => null);
  if (!ffmpeg || !/\bdrawbox\b/.test(ffmpeg.stdout) || !/\bxstack\b/.test(ffmpeg.stdout))
    return t.skip("ffmpeg with drawbox and xstack is not installed");
  const dir = await mkdtemp(join(tmpdir(), "redact-preview-"));
  try {
    const files = [];
    for (const [i, color] of ["white", "0x202020", "white"].entries()) {
      const file = join(dir, `f${i}.png`);
      await run("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=${color}:s=2560x1440`,
        "-frames:v",
        "1",
        file,
      ]);
      files.push(file);
    }
    const out = join(dir, "sheet.png");
    const sheet = await contactSheet(
      files.map((file, i) => ({
        file,
        atMs: i * 1000,
        fills: [box(0.1, 0.02)],
        marks: [{ box: box(0.1, 0.02), label: "1 email ja…om" }],
      })),
      out,
      { workDir: dir },
    );
    assert.equal(sheet.frames, 3);
    const { stdout } = await run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      out,
    ]);
    assert.equal(stdout.trim(), `1928,${2 * sheet.cellHeight + 8}`);
    assert.equal(sheet.cellHeight, sheet.labelled ? sheet.cellHeight : 540);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
