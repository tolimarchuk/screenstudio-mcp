// Delivery: per-target settings, vertical zooms, the GIF size loop, caption and
// chapter files in playback time, and loop planning, all without the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOOP_CONFIG,
  TARGETS,
  TARGET_NAMES,
  actionZooms,
  applyPartial,
  baseNameFor,
  beatLabel,
  captionCues,
  chapterLines,
  chapters,
  clipSlices,
  fitGif,
  freePath,
  limitChecks,
  mediaSummary,
  payoffMs,
  planLoop,
  playbackWords,
  targetChanges,
  toSrt,
  toVtt,
  variantProject,
} from "../dist/studio/deliver.js";
import { configPartial, editOp, prepareOps } from "../dist/studio/editor/ops.js";
import { Studio } from "../dist/studio/service.js";
import { playbackRange } from "../dist/studio/timeline.js";

/** A project config with the groups a Screen Studio 4 project has, trimmed to what targets touch. */
const config = () => ({
  output: { aspectRatio: 16 / 9, paddingRatio01: 0.08, avoidEmptyZoomArea: false },
  captions: {
    enableTranscript: true,
    sizeRatio: 0.04,
    position01: { x: 0.5, y: 0.85 },
    font: "sans-serif",
    color: "#ffffff",
    backgroundColor: "#000000b3",
  },
  defaultLayout: {
    type: "camera-overlay",
    cutoutCamera: { cutoutCameraPositionX01: 0.5, cutoutCameraSizeRatio01: 1, cutoutCameraZoomedScale: 0.5 },
  },
  cursor: { size: 48 },
});

const project = (zooms = []) => ({
  version: 8,
  config: config(),
  scenes: [
    {
      id: "s",
      slices: [
        { id: "a", sourceStartMs: 0, sourceEndMs: 10000, timeScale: 1 },
        { id: "b", sourceStartMs: 14000, sourceEndMs: 30000, timeScale: 1 },
      ],
      zooms,
    },
  ],
});

test("every target's settings pass the same config rules an editor apply uses", () => {
  assert.deepEqual(TARGET_NAMES.sort(), Object.keys(TARGETS).sort());
  for (const name of TARGET_NAMES) {
    const target = TARGETS[name];
    const c = config();
    const { changes, skipped } = targetChanges(target, c);
    assert.deepEqual(skipped, [], name);
    applyPartial(c, configPartial(c, changes));
    const [w, h] = target.aspect.split(":").map(Number);
    assert.ok(Math.abs(c.output.aspectRatio - w / h) < 1e-9, name);
    if (target.captions) assert.equal(c.captions.sizeRatio, target.captions.sizeRatio, name);
    // Untouched fields in a group survive the merge.
    assert.equal(c.captions.font, "sans-serif", name);
    assert.equal(c.defaultLayout.cutoutCamera.cutoutCameraPositionX01, 0.5, name);
    assert.ok(target.why.length > 20, `${name} explains itself`);
  }
  assert.equal(TARGETS.shorts.captions.position01.y, 0.68);
});

test("a setting the project does not have is skipped and named, not invented", () => {
  const c = config();
  delete c.defaultLayout;
  const { changes, skipped } = targetChanges(TARGETS.shorts, c);
  assert.deepEqual(skipped, ["defaultLayout.cutoutCamera.cutoutCameraSizeRatio01"]);
  assert.equal(changes["output.aspectRatio"], 9 / 16);
});

test("a vertical variant gets action zooms on its copy and the original is untouched", () => {
  const existing = [{ id: "z1", sourceStartMs: 2000, sourceEndMs: 6000, zoom: 1.5, type: "manual" }];
  const p = project(existing);
  const planned = [
    {
      sourceStartMs: 3000,
      sourceEndMs: 7000,
      zoom: 2.2,
      follow: false,
      target: { x: 0.2, y: 0.3 },
      reason: "",
    },
    {
      sourceStartMs: 16000,
      sourceEndMs: 21000,
      zoom: 1.8,
      follow: true,
      target: { x: 0.6, y: 0.4 },
      reason: "",
    },
    {
      sourceStartMs: 29000,
      sourceEndMs: 29900,
      zoom: 2.2,
      follow: false,
      target: { x: 0.5, y: 0.5 },
      reason: "",
    },
  ];
  const v = variantProject(p, "shorts", TARGETS.shorts, { verticalZooms: planned });
  assert.equal(v.refused, undefined);
  const zooms = v.project.scenes[0].zooms;
  // The overlapping one and the one too close to the end are skipped.
  const fixed = zooms.filter((z) => z.type === "manual");
  assert.equal(fixed.length, 2);
  const added = fixed.find((z) => z.id !== "z1");
  assert.equal(added.type, "manual");
  assert.deepEqual(added.manualTargetPoint, { x: 0.6, y: 0.4 });
  assert.equal(added.sourceStartMs, 16000);
  assert.match(v.notes.join(" "), /Added 1 fixed zoom \(1.8x\)/);
  assert.equal(v.project.config.output.aspectRatio, 9 / 16);
  assert.equal(v.project.config.defaultLayout.cutoutCamera.cutoutCameraSizeRatio01, 0.55);
  assert.equal(p.scenes[0].zooms.length, 1);
  assert.equal(p.config.output.aspectRatio, 16 / 9);
});

test("a variant whose frame would crop every wide shot renders with the crop turned off on its copy", () => {
  const p = project();
  p.config.output.avoidEmptyZoomArea = true;
  const capture = { widthPt: 1440, heightPt: 900 };
  const shorts = variantProject(p, "shorts", TARGETS.shorts, { capture });
  assert.equal(shorts.refused, undefined);
  assert.equal(shorts.project.config.output.avoidEmptyZoomArea, false);
  assert.ok(shorts.notes.some((n) => /Turned off avoid-empty-zoom-area for this copy/.test(n)));
  assert.equal(p.config.output.avoidEmptyZoomArea, true, "the project itself keeps its setting");
  // Without an analysis the capture is unknown: every target still renders.
  const blind = variantProject(p, "x", TARGETS.x);
  assert.equal(blind.refused, undefined);
  assert.ok(blind.notes.some((n) => /capture size is unknown/.test(n)));
  p.config.output.avoidEmptyZoomArea = false;
  const plain = variantProject(p, "x", TARGETS.x, { capture });
  assert.equal(plain.refused, undefined);
  assert.ok(!plain.notes.some((n) => /avoid-empty-zoom-area/.test(n)));
});

test("action zooms stay off the opening and ending and need two seconds on screen", () => {
  const slices = project().scenes[0].slices;
  const z = (sourceStartMs, sourceEndMs) => ({
    sourceStartMs,
    sourceEndMs,
    zoom: 2.2,
    follow: false,
    target: { x: 0.5, y: 0.5 },
    reason: "",
  });
  const out = actionZooms([z(200, 4000), z(9000, 15000), z(20000, 24000)], slices, []);
  // 9000-15000 shows only 2s (1000 before the cut, 1000 after), so it stays; 200 starts too early.
  assert.deepEqual(
    out.map((x) => x.sourceStartMs),
    [9000, 20000],
  );
  assert.ok(out.every((x) => x.id && x.presentation === "screen"));
});

test("the GIF loop halves frame rate, then height, until the file fits", async () => {
  const sizes = [];
  const convert = async ({ fps, height }) => {
    sizes.push([fps, height]);
    return fps * height * 1000;
  };
  const fit = await fitGif(convert, 3_000_000);
  assert.deepEqual(sizes, [
    [20, 480],
    [10, 480],
    [10, 240],
  ]);
  assert.equal(fit.fits, true);
  assert.equal(fit.bytes, 2_400_000);
  assert.deepEqual([fit.fps, fit.height], [10, 240]);

  const never = await fitGif(async () => 1e12, 1000);
  assert.equal(never.fits, false);
  assert.ok(never.fps >= 8 && never.height >= 160);
  assert.ok(never.attempts.length <= 5);
});

test("caption words follow the cut: a cut word is gone, a 2x word halves", () => {
  const slices = [
    { sourceStartMs: 0, sourceEndMs: 2000, timeScale: 1 },
    { sourceStartMs: 4000, sourceEndMs: 8000, timeScale: 0.5 },
  ];
  const words = playbackWords(
    [
      { text: " Hello", startMs: 500, endMs: 900 },
      { text: " gone", startMs: 2500, endMs: 3000 },
      { text: " fast", startMs: 5000, endMs: 5600 },
    ],
    slices,
  );
  assert.deepEqual(
    words.map((w) => [w.text, w.startMs, w.endMs]),
    [
      [" Hello", 500, 900],
      [" fast", 2500, 2800],
    ],
  );
});

test("cues break on pauses and sentence ends, and the files are valid SRT and VTT", () => {
  const w = (text, startMs, endMs) => ({ text, startMs, endMs });
  const cues = captionCues([
    w(" Open", 0, 300),
    w(" the", 320, 450),
    w(" settings.", 470, 900),
    w(" Then", 950, 1200),
    w(" pick", 1250, 1500),
    w(" a", 2600, 2700),
    w(" plan.", 2720, 3000),
  ]);
  assert.deepEqual(
    cues.map((c) => c.text),
    ["Open the settings.", "Then pick", "a plan."],
  );
  assert.equal(toSrt(cues.slice(0, 1)), "1\n00:00:00,000 --> 00:00:00,900\nOpen the settings.\n");
  const vtt = toVtt(cues);
  assert.ok(vtt.startsWith("WEBVTT\n\n00:00:00.000 --> 00:00:00.900\nOpen the settings.\n"));
  assert.match(vtt, /00:00:02\.600 --> 00:00:03\.300\na plan\./);
});

test("chapters start at 0:00, run at least 10s, and prefer beats with a role", () => {
  const slices = [{ sourceStartMs: 0, sourceEndMs: 60000, timeScale: 1 }];
  const beats = [
    { sourceStartMs: 2000, sourceEndMs: 4000, actions: ['says "Here is the dashboard"'] },
    { sourceStartMs: 8000, sourceEndMs: 9000, actions: ["click at (0.10, 0.20)"] },
    { sourceStartMs: 20000, sourceEndMs: 25000, actions: ["typing 12 chars", "click at (0.5, 0.5)"] },
    { sourceStartMs: 44000, sourceEndMs: 46000, actions: ["click at (0.2, 0.2)"] },
    { sourceStartMs: 55000, sourceEndMs: 56000, actions: ["click at (0.3, 0.3)"] },
  ];
  const list = chapters(beats, slices);
  assert.deepEqual(list, [
    { playbackMs: 0, label: "Here is the dashboard" },
    { playbackMs: 20000, label: "Clicks and typing" },
    { playbackMs: 44000, label: "Clicks" },
  ]);
  assert.equal(chapterLines(list), "0:00 Here is the dashboard\n0:20 Clicks and typing\n0:44 Clicks\n");
  const roled = chapters(
    beats.map((b, i) => ({ ...b, role: i === 2 ? "demo" : i === 3 ? "payoff" : "context" })),
    slices,
  );
  assert.deepEqual(
    roled.map((c) => c.playbackMs),
    [0, 20000, 44000],
  );
  assert.equal(roled[0].label, "Start");
  assert.equal(beatLabel({ sourceStartMs: 0, sourceEndMs: 1, label: "Pick a plan" }), "Pick a plan");
});

test("the poster lands on the payoff's settled result", () => {
  const slices = [{ sourceStartMs: 0, sourceEndMs: 20000, timeScale: 1 }];
  const beats = [
    { sourceStartMs: 1000, sourceEndMs: 3000 },
    { sourceStartMs: 8000, sourceEndMs: 10000, role: "payoff" },
    { sourceStartMs: 14000, sourceEndMs: 16000 },
  ];
  assert.equal(payoffMs(beats, slices), 10600);
  assert.equal(
    payoffMs(
      beats.map(({ role, ...b }) => b),
      slices,
    ),
    16600,
  );
  assert.equal(payoffMs([], slices), 18500);
});

test("limit checks flag a file too long or too heavy for its target", () => {
  const m = mediaSummary(
    {
      format: { duration: "151.5", size: "9000" },
      streams: [{ codec_name: "aac" }, { width: 1920, height: 1080, avg_frame_rate: "60/1" }],
    },
    600_000_000,
  );
  assert.deepEqual(m, { durationMs: 151500, width: 1920, height: 1080, fps: 60, bytes: 600_000_000 });
  const checks = limitChecks("x", TARGETS.x, m);
  assert.deepEqual(
    checks.map((c) => [c.check, c.ok]),
    [
      ["duration", false],
      ["size", false],
    ],
  );
  assert.match(checks[0].message, /2:31.5 is over x's 2:20.0 limit/);
  const vertical = limitChecks("shorts", TARGETS.shorts, {
    ...m,
    width: 608,
    height: 1080,
    durationMs: 30000,
  });
  assert.deepEqual(
    vertical.filter((c) => !c.ok).map((c) => c.check),
    ["resolution"],
  );
});

test("output names never collide with files already there", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ssmcp-deliver-"));
  assert.equal(await freePath(dir, "demo-x", "mp4"), join(dir, "demo-x.mp4"));
  await writeFile(join(dir, "demo-x.mp4"), "");
  await writeFile(join(dir, "demo-x-2.mp4"), "");
  assert.equal(await freePath(dir, "demo-x", "mp4"), join(dir, "demo-x-3.mp4"));
  assert.equal(baseNameFor("/p/Launch Demo.screenstudio"), "Launch Demo");
  assert.throws(() => baseNameFor("/p/x.screenstudio", "a/b"), /baseName/);
  assert.throws(() => baseNameFor("/p/x.screenstudio", "it's"), /baseName/);
});

test("waiting for an export polls until it stops running", async () => {
  const studio = new Studio();
  const seen = ["starting", "rendering", "rendering", "completed"];
  studio.exportStatus = async () => ({ status: seen.shift(), outputPath: "/out.mp4" });
  const done = await studio.waitForExport("00000000-0000-0000-0000-000000000000", { pollMs: 1 });
  assert.equal(done.status, "completed");
  studio.exportStatus = async () => ({ status: "rendering" });
  await assert.rejects(
    studio.waitForExport("00000000-0000-0000-0000-000000000000", { pollMs: 1, timeoutMs: 5 }),
    /still rendering/,
  );
});

// ---------------------------------------------------------------- loops

const click = (atMs, x, y) => ({ atMs, endMs: atMs + 80, x, y, drag: false, button: "left" });
function loopAnalysis() {
  const clicks = [
    click(3000, 0.2, 0.3),
    click(9000, 0.7, 0.3),
    click(15000, 0.3, 0.7),
    click(21000, 0.7, 0.7),
    click(27000, 0.5, 0.5),
  ];
  const idle = [];
  let at = 0;
  for (const c of clicks) {
    if (c.atMs - at >= 800) idle.push({ startMs: at, endMs: c.atMs - 200 });
    at = c.endMs + 200;
  }
  idle.push({ startMs: at, endMs: 34000 });
  return {
    projectPath: "/x.screenstudio",
    sourceDurationMs: 34000,
    capture: { kind: "window", widthPt: 1440, heightPt: 900 },
    sessions: [{ startMs: 0, endMs: 34000, video: "" }],
    clicks,
    typing: [],
    shortcuts: [],
    movement: [],
    screen: { changes: [], active: [] },
    idle,
  };
}

test("a loop starts and ends on matching frames, silent, with zooms ending before the restart", async () => {
  const a = loopAnalysis();
  const asked = [];
  const match = async (first, last) => {
    asked.push([first, last]);
    return first >= 8000 && first <= 9000 && last >= 21000 && last <= 23000 ? 0.95 : 0.4;
  };
  const loop = await planLoop(a, { targetMs: 8000 }, match);
  assert.equal(loop.seamless, true, loop.notes.join(" "));
  assert.equal(loop.ssim, 0.95);
  assert.ok(loop.sourceRange.startMs >= 8000 && loop.sourceRange.startMs <= 9000);
  assert.ok(loop.sourceRange.endMs >= 21000 && loop.sourceRange.endMs <= 23000);
  assert.ok(asked.length > 1 && asked.length <= 12);
  // The ops are valid editor ops for this recording.
  prepareOps(loop.ops, {
    sourceMs: 34000,
    config: {
      cursor: { loopPositionBeforeEndMs: null },
      audio: { muteSystemAudio: false, muteMicrophone: false, muteBackgroundAudio: false },
      output: { avoidEmptyZoomArea: false },
    },
    captureSize: { width: 1440, height: 900 },
  });
  for (const op of loop.ops) editOp.parse(op);
  const slices = loop.ops[0].slices.map((s) => ({
    sourceStartMs: s.startMs,
    sourceEndMs: s.endMs,
    timeScale: 1 / s.speed,
  }));
  assert.equal(slices[0].sourceStartMs, loop.sourceRange.startMs);
  for (const z of loop.ops.filter((o) => o.op === "addZoom")) {
    const r = playbackRange(slices, z.startMs, z.endMs);
    assert.ok(
      r.endMs <= loop.playbackMs - 799,
      `zoom ends ${loop.playbackMs - r.endMs}ms before the loop end`,
    );
    assert.ok(r.startMs >= 499);
  }
  assert.deepEqual(loop.ops.at(-1), { op: "config", changes: LOOP_CONFIG });
  assert.match(loop.notes[0], /SSIM 0.95/);
});

test("with no matching frames the loop is one beat with a hold, and says the join shows", async () => {
  const loop = await planLoop(loopAnalysis(), { targetMs: 6000 }, async () => 0.4);
  assert.equal(loop.seamless, false);
  assert.equal(loop.ssim, 0.4);
  assert.ok(loop.playbackMs >= 4000 - 1 && loop.playbackMs <= 15000);
  assert.match(loop.notes[0], /restart shows a jump/);
});

test("clipped slices keep the planned speeds inside the range only", () => {
  const s = clipSlices(
    [
      { startMs: 0, endMs: 1000, speed: 1, reason: "" },
      { startMs: 1000, endMs: 5000, speed: 2, reason: "" },
      { startMs: 6000, endMs: 9000, speed: 1, reason: "" },
    ],
    500,
    7000,
  );
  assert.deepEqual(s, [
    { startMs: 500, endMs: 1000, speed: 1 },
    { startMs: 1000, endMs: 5000, speed: 2 },
    { startMs: 6000, endMs: 7000, speed: 1 },
  ]);
});

test("the variants reference lists every target with its real frame and render", async () => {
  const doc = await readFile("skills/screenstudio/references/variants.md", "utf8");
  const rows = new Map(
    [...doc.matchAll(/^\| `(\w+)` \| ([\d:]+) \| (\d+)p(\d+)? (MP4|GIF) \|/gm)].map((m) => [m[1], m]),
  );
  assert.deepEqual([...rows.keys()].sort(), [...TARGET_NAMES].sort());
  for (const [name, m] of rows) {
    const t = TARGETS[name];
    assert.equal(m[2], t.aspect, name);
    assert.equal(Number(m[3]), t.height, name);
    if (m[4]) assert.equal(Number(m[4]), t.fps, name);
    assert.equal(m[5].toLowerCase(), t.format, name);
  }
});

test("the delivery tools are served and refuse a request without a project", async () => {
  const client = new Client({ name: "deliver", version: "1" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: ["dist/mcp/main.js"], stderr: "pipe" }),
  );
  try {
    const { tools } = await client.listTools();
    const byName = (n) => tools.find((t) => t.name === n);
    const variants = byName("screenstudio_export_variants");
    assert.deepEqual(variants.inputSchema.properties.targets.items.enum.sort(), [...TARGET_NAMES].sort());
    assert.equal(variants.inputSchema.properties.kit.default, true);
    assert.equal(byName("screenstudio_loop").inputSchema.properties.targetMs.default, 8000);
    assert.equal(byName("screenstudio_contact_sheet").annotations.readOnlyHint, true);
    const sheet = await client.callTool({ name: "screenstudio_contact_sheet", arguments: {} });
    assert.equal(sheet.isError, true);
    assert.match(sheet.content[0].text, /projectPath .* or jobIds/);
    const bad = await client.callTool({
      name: "screenstudio_export_variants",
      arguments: { projectPath: "relative.screenstudio", targets: ["x"], outputDir: "/tmp" },
    });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /absolute \.screenstudio/);
  } finally {
    await client.close();
  }
});
