// Contact sheets: which moments get a tile, the tile layout graph, and (when
// ffmpeg is installed) a real labelled sheet and similarity score from images.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeScene } from "../dist/studio/editor/describe.js";
import { clock, filePoints, keyMoments, pngSize, tileLabel } from "../dist/studio/sheet.js";
import {
  filterPath,
  findTool,
  hasFilter,
  labelFont,
  parseSsim,
  ssim,
  tileFilter,
  tileImages,
} from "../dist/studio/media.js";

const scene = describeScene({
  slices: [
    { id: "s1", sourceStartMs: 0, sourceEndMs: 6000, timeScale: 1 },
    { id: "s2", sourceStartMs: 9000, sourceEndMs: 15000, timeScale: 1 },
    { id: "s3", sourceStartMs: 15000, sourceEndMs: 19000, timeScale: 0.5 },
    { id: "s4", sourceStartMs: 25000, sourceEndMs: 33000, timeScale: 1 },
  ],
  zooms: [
    { id: "z1", sourceStartMs: 2500, sourceEndMs: 5500, zoom: 1.6, type: "manual" },
    { id: "z2", sourceStartMs: 26000, sourceEndMs: 30000, zoom: 1.8, type: "manual", presentation: "loupe" },
    { id: "z3", sourceStartMs: 10000, sourceEndMs: 12000, zoom: 1.4, type: "manual", isDisabled: true },
  ],
  layouts: [{ id: "l1", type: "cutout-camera", sourceStartMs: 9000, sourceEndMs: 14000 }],
  masks: [],
});

test("key moments: opening, each cut with the frame before it, zoom midpoints, the ending", () => {
  const moments = keyMoments(scene, { issues: [{ code: "short-zoom", atPlaybackMs: 6100 }] });
  const times = moments.map((m) => m.playbackMs);
  assert.deepEqual(
    times,
    [...times].sort((a, b) => a - b),
  );
  assert.deepEqual(
    moments.map((m) => [m.playbackMs, m.kind, m.label]),
    [
      [0, "opening", "opening"],
      [4000, "zoom", "zoom 1.6x"],
      [5800, "before-cut", "before cut"],
      [6000, "cut", "cut"],
      [6400, "layout", "layout cutout-camera"],
      [12300, "speed", "2x"],
      [13800, "before-cut", "before cut"],
      [14000, "cut", "cut"],
      [17000, "loupe", "loupe 1.8x"],
      [21500, "ending", "ending"],
    ],
  );
  // The issue at 6100ms sits within 400ms of the cut and gives way to it; the disabled zoom gets no tile.
  for (const [i, m] of moments.entries())
    for (const n of moments.slice(i + 1))
      if (Math.abs(m.playbackMs - n.playbackMs) < 400)
        assert.equal(m.itemId, n.itemId, `${m.label} and ${n.label} are too close`);
  assert.ok(!moments.some((m) => m.itemId === "z3"));
  assert.equal(keyMoments(scene, { max: 3 }).length, 3);
  assert.deepEqual(
    keyMoments(scene, { max: 2 }).map((m) => m.kind),
    ["opening", "ending"],
  );
});

test("tile labels read number, clock and what", () => {
  assert.equal(clock(4200), "0:04.2");
  assert.equal(clock(61000), "1:01.0");
  assert.equal(
    tileLabel({ n: 7, playbackMs: 19000, kind: "loupe", label: "loupe 1.8x" }),
    "7 · 0:19.0 loupe 1.8x",
  );
  assert.deepEqual(
    filePoints(10000).map((p) => p.ms),
    [0, 5000, 9500],
  );
});

test("the tile graph letterboxes each cell and lays rows out left to right", () => {
  const { graph, out } = tileFilter(5, {
    columns: 4,
    cellWidth: 320,
    cellHeight: 180,
    labelFiles: ["/t/0.txt", null, "/t/2.txt", "/t/3.txt", "/t/4.txt"],
    font: "/System/Library/Fonts/Helvetica.ttc",
  });
  assert.equal(out, "[sheet]");
  assert.match(graph, /xstack=inputs=5:layout=0_0\|320_0\|640_0\|960_0\|0_180:fill=0x111111\[sheet\]$/);
  assert.equal((graph.match(/drawtext/g) ?? []).length, 4);
  assert.match(graph, /textfile='\/t\/0.txt':expansion=none/);
  assert.match(graph, /force_original_aspect_ratio=decrease,pad=320:180/);
  assert.deepEqual(tileFilter(1, { columns: 4, cellWidth: 100, cellHeight: 100 }).out, "[c0]");
  assert.throws(() => tileFilter(0, { columns: 4, cellWidth: 100, cellHeight: 100 }));
  assert.equal(filterPath("/a:b/c.png"), "/a\\:b/c.png");
  assert.throws(() => filterPath("/it's.png"));
});

test("ssim stats files are averaged over their lines", () => {
  assert.equal(
    parseSsim("n:1 Y:0.99 U:0.98 V:0.97 All:0.98 (17.0)\nn:2 Y:1 U:1 V:1 All:0.96 (14.0)\n"),
    0.97,
  );
  assert.equal(parseSsim(""), null);
});

let ffmpeg = null;
try {
  ffmpeg = await findTool("ffmpeg");
  execFileSync(ffmpeg, ["-version"], { stdio: "ignore" });
} catch {
  ffmpeg = null;
}

test(
  "a real sheet tiles frames into the expected size, and identical frames score 1",
  { skip: !ffmpeg },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ssmcp-sheet-"));
    const frames = [];
    for (const [i, color] of ["red", "blue", "green"].entries()) {
      const f = join(dir, `${i}.png`);
      execFileSync(ffmpeg, [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=${color}:s=640x360`,
        "-frames:v",
        "1",
        f,
      ]);
      frames.push(f);
    }
    const label = join(dir, "label.txt");
    await writeFile(label, "1 · 0:00.0 opening: 100%");
    const out = join(dir, "sheet.png");
    await tileImages(frames, out, {
      columns: 2,
      cellWidth: 320,
      cellHeight: 180,
      labelFiles: [label, null, null],
      font: (await hasFilter("drawtext")) ? await labelFont() : null,
    });
    assert.deepEqual(pngSize(await readFile(out)), { width: 640, height: 360 });
    assert.ok((await ssim(frames[0], frames[0], join(dir, "same.log"))) > 0.99);
    assert.ok((await ssim(frames[0], frames[1], join(dir, "diff.log"))) < 0.9);
  },
);

test("a disabled layout gets no tile", () => {
  const withDisabled = describeScene({
    slices: [{ id: "s1", sourceStartMs: 0, sourceEndMs: 20000, timeScale: 1 }],
    zooms: [],
    layouts: [
      { id: "on", type: "cutout-camera", sourceStartMs: 3000, sourceEndMs: 8000 },
      { id: "off", type: "split-screen", sourceStartMs: 12000, sourceEndMs: 16000, isDisabled: true },
    ],
    masks: [],
  });
  const ids = keyMoments(withDisabled).map((m) => m.itemId);
  assert.ok(ids.includes("on"));
  assert.ok(!ids.includes("off"), JSON.stringify(ids));
});
