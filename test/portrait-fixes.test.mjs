// Portrait delivery: loupes keep their kind, switched-off zooms do not block
// fill zooms, the notes say what really happened, and frame sizes add up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  TARGETS,
  captureRatio,
  exportFrame,
  frameSize,
  limitChecks,
  portraitZooms,
  renderHeight,
  variantProject,
} from "../dist/studio/deliver.js";

const WIDE = 16 / 9;
const TALL = 9 / 16;
const whole = [{ sourceStartMs: 0, sourceEndMs: 30000, timeScale: 1 }];
const zoom = (sourceStartMs, sourceEndMs, level, extra = {}) => ({
  id: `z${sourceStartMs}`,
  sourceStartMs,
  sourceEndMs,
  zoom: level,
  type: "manual",
  manualTargetPoint: { x: 0.5, y: 0.5 },
  isDisabled: false,
  presentation: "screen",
  ...extra,
});
const click = (atMs, x, y = 0.5) => ({ atMs, x, y });
const project = (zooms) => ({
  version: 8,
  config: { output: { aspectRatio: WIDE, paddingRatio01: 0.08, avoidEmptyZoomArea: false } },
  scenes: [{ id: "s", slices: whole, zooms }],
});
const capture = { widthPt: 1920, heightPt: 1080 };

test("a follow loupe becomes a follow zoom that keeps its clicks in the frame", () => {
  const loupe = zoom(5000, 9000, 2, { type: "follow-click-groups", presentation: "loupe" });
  const out = portraitZooms([loupe], whole, {
    captureRatio: WIDE,
    frameRatio: TALL,
    points: [click(6000, 0.05), click(7000, 0.9)],
  });
  const z = out.zooms.find((x) => x.id === "z5000");
  assert.equal(z.presentation, "screen");
  assert.equal(z.type, "follow-click-groups");
  // Both clicks fit: at zoom z the frame shows 1/z of the width.
  assert.ok(1 / z.zoom >= 0.85, `zoom ${z.zoom} loses a click`);
  // A fixed-target loupe stays fixed, on its target.
  const fixed = portraitZooms(
    [zoom(5000, 9000, 1.6, { presentation: "loupe", manualTargetPoint: { x: 0.4, y: 0.3 } })],
    whole,
    {
      captureRatio: WIDE,
      frameRatio: TALL,
    },
  ).zooms.find((x) => x.id === "z5000");
  assert.equal(fixed.type, "manual");
  assert.deepEqual(fixed.manualTargetPoint, { x: 0.4, y: 0.3 });
});

test("a switched-off zoom does not leave its stretch as a thin band", () => {
  const fill = portraitZooms([zoom(5000, 20000, 2, { isDisabled: true })], whole, {
    captureRatio: WIDE,
    frameRatio: TALL,
  });
  for (let t = 0; t < 30000; t += 250)
    assert.ok(
      fill.zooms.some((z) => !z.isDisabled && z.sourceStartMs <= t && z.sourceEndMs > t),
      `${t}ms is at 1x`,
    );
  assert.equal(fill.disabledDropped, 1);
  const v = variantProject(project([zoom(5000, 20000, 2, { isDisabled: true })]), "shorts", TARGETS.shorts, {
    capture,
  });
  assert.match(v.notes.join(" "), /1 switched-off zoom left out of this copy/);
});

test("loupes stay loupes when the screen already fills the portrait frame", () => {
  const loupe = zoom(5000, 9000, 1.6, { presentation: "loupe" });
  const out = portraitZooms([loupe], whole, { captureRatio: 0.46, frameRatio: TALL });
  assert.equal(out.level, 1);
  assert.equal(out.loupesConverted, 0);
  assert.equal(out.zooms[0].presentation, "loupe");
});

test("notes count converted loupes apart and say which stretches stayed wide", () => {
  const loupe = zoom(10000, 15000, 1.6, { presentation: "loupe" });
  const fill = portraitZooms([loupe], whole, { captureRatio: WIDE, frameRatio: TALL });
  assert.equal(fill.loupesConverted, 1);
  assert.equal(fill.deeper, 0);
  const v = variantProject(project([loupe]), "shorts", TARGETS.shorts, { capture });
  const note = v.notes.join(" ");
  assert.match(note, /1 loupe became camera zoom/);
  assert.ok(!/deeper zoom/.test(note), note);

  // Clicks every 2s at opposite edges: nothing can be zoomed, and the note says so.
  const points = [];
  for (let t = 500; t < 29000; t += 2000) points.push(click(t, points.length % 2 ? 0.98 : 0.02));
  const spread = variantProject(project([]), "shorts", TARGETS.shorts, { capture, points });
  const said = spread.notes.join(" ");
  assert.match(said, /stay(s)? wide at 1x/);
  assert.ok(!/first and last second/.test(said), said);
  const wide = portraitZooms([], whole, { captureRatio: WIDE, frameRatio: TALL, points });
  assert.ok(wide.leftWideMs >= 25000, JSON.stringify(wide));
  assert.equal(wide.openingWide, false);
});

test("the resolution check catches frames too large, and odd short sides round to even", () => {
  const media = (width, height) => ({ durationMs: 10000, width, height, fps: 60, bytes: 1e6 });
  const res = (target, w, h) => limitChecks("t", target, media(w, h)).find((c) => c.check === "resolution");
  const big = res(TARGETS.shorts, 1920, 3414);
  assert.equal(big.ok, false);
  assert.match(big.message, /larger than the target/);
  assert.equal(res(TARGETS.shorts, 1080, 1920), undefined);
  assert.deepEqual(frameSize("9:16", 1081), { width: 1082, height: 1924 });
  assert.deepEqual(frameSize("4:5", 725), { width: 726, height: 908 });
  assert.equal(renderHeight("16:9", 1081), 1082);
  // The encoder's even rounding is not a wrong height.
  assert.equal(res({ ...TARGETS.portrait, height: 725 }, 724, 906), undefined);
});

test("fill zooms meet fractional zoom edges exactly, never overlapping them", () => {
  const fill = portraitZooms([zoom(1000.4, 5000.4, 2.2)], whole, { captureRatio: WIDE, frameRatio: TALL });
  const sorted = [...fill.zooms].sort((a, b) => a.sourceStartMs - b.sourceStartMs);
  for (let i = 1; i < sorted.length; i++)
    assert.ok(sorted[i].sourceStartMs >= sorted[i - 1].sourceEndMs, JSON.stringify(sorted));
  assert.ok(sorted.some((z) => z.sourceStartMs === 5000.4));
});

test("an auto frame reads the recording's size and crop when nothing is cached", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/window-recording", import.meta.url));
  // A 1440x900 window: auto is landscape, 1080 passes through.
  const landscape = await exportFrame(fixture, { output: { aspectRatio: "auto" } }, 1080);
  assert.equal(landscape.height, 1080);
  assert.deepEqual(landscape.frame, { width: 1728, height: 1080 });
  // Cropped to a portrait strip: the frame is portrait, so Screen Studio is asked for its long side.
  const cropped = await exportFrame(
    fixture,
    { output: { aspectRatio: "auto" }, crop: { rect01: { x: 0.4, y: 0, width: 0.25, height: 1 } } },
    1080,
  );
  assert.ok(cropped.height > 1080, JSON.stringify(cropped));
  assert.equal(cropped.frame.width, 1080);
  assert.match(cropped.note, /short side/);
  // A cached capture wins, and its crop applies too.
  assert.equal(captureRatio({ widthPt: 1000, heightPt: 2000 }, { width: 1, height: 0.5 }), 1);
  assert.equal(renderHeight("auto", 1080, captureRatio({ widthPt: 1170, heightPt: 2532 })), 2338);
  // Unreadable size: passed through, and the result says so.
  const unknown = await exportFrame("/nowhere/x.screenstudio", { output: { aspectRatio: "auto" } }, 1080);
  assert.equal(unknown.height, 1080);
  assert.match(unknown.note, /could not be read/);
  // Fixed aspects need no recording at all.
  const fixed = await exportFrame("/nowhere/x.screenstudio", { output: { aspectRatio: TALL } }, 1080);
  assert.equal(fixed.height, 1920);
});
