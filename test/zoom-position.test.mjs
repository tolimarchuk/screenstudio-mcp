// Zooms hold one manual position; moving to another spot is a new zoom back to back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPacing } from "../dist/studio/pacing.js";
import { planEdit } from "../dist/studio/plan.js";
import { editOp } from "../dist/studio/editor/ops.js";
import { SPRINGS } from "../dist/studio/timeline.js";

function analysis(clicks, sourceDurationMs = 30000) {
  return {
    projectPath: "/x.screenstudio",
    sourceDurationMs,
    capture: { kind: "window", widthPt: 1440, heightPt: 900 },
    sessions: [{ startMs: 0, endMs: sourceDurationMs, video: "" }],
    clicks,
    typing: [],
    shortcuts: [],
    movement: [],
    screen: { changes: [], active: [] },
    idle: [],
  };
}
const click = (atMs, x, y, drag = false) => ({ atMs, endMs: atMs + 80, x, y, drag, button: "left" });

const typing = (startMs, endMs, x, y) => ({
  startMs,
  endMs,
  chars: Math.round((endMs - startMs) / 90),
  x,
  y,
});
const idleAround = (busy, total) => {
  const idle = [];
  let at = 0;
  for (const b of busy) {
    if (b[0] - at >= 800) idle.push({ startMs: at, endMs: b[0] });
    at = Math.max(at, b[1]);
  }
  if (total - at >= 800) idle.push({ startMs: at, endMs: total });
  return idle;
};

test("clicks and typing get manual zooms with a fixed target, never a follow zoom", () => {
  const a = analysis([click(3000, 0.3, 0.3), click(10000, 0.32, 0.32)], 20000);
  a.typing = [typing(4000, 9000, 0.31, 0.31)];
  a.idle = idleAround([[2900, 10300]], 20000);
  const plan = planEdit(a);
  assert.ok(plan.zooms.length > 0);
  for (const z of plan.zooms) {
    assert.equal(z.follow, false);
    assert.ok(Math.abs(z.target.x - 0.31) < 0.05 && Math.abs(z.target.y - 0.31) < 0.05);
  }
});

test("a drag is the one case that follows the pointer", () => {
  const a = analysis(
    [click(3000, 0.3, 0.3, true), click(6000, 0.36, 0.33, true), click(9000, 0.33, 0.36, true)],
    20000,
  );
  a.typing = [typing(3500, 8500, 0.33, 0.33)];
  a.idle = idleAround([[2900, 9300]], 20000);
  const plan = planEdit(a);
  assert.ok(plan.zooms.some((z) => z.follow));
});

test("clicks too far apart for one frame become two manual zooms back to back", () => {
  for (const style of ["calm", "balanced", "snappy"]) {
    const a = analysis([click(4000, 0.12, 0.15), click(9600, 0.88, 0.85), click(24000, 0.5, 0.5)], 40000);
    a.typing = [
      typing(4300, 9000, 0.13, 0.16),
      typing(9900, 15000, 0.87, 0.84),
      typing(24300, 29000, 0.5, 0.5),
    ];
    a.idle = idleAround(
      [
        [3900, 15200],
        [23900, 29200],
      ],
      40000,
    );
    const plan = planEdit(a, { style, maxZooms: 6 });
    const zooms = plan.zooms;
    assert.ok(zooms.length >= 2, `${style}: ${JSON.stringify(zooms)}`);
    for (const z of zooms) assert.equal(z.follow, false, style);
    // The top-left and bottom-right moments are separate zooms that hand off with no wide shot between.
    assert.ok(zooms[0].target.x < 0.3 && zooms[1].target.x > 0.5, `${style}: ${JSON.stringify(zooms)}`);
    assert.equal(zooms[1].sourceStartMs, zooms[0].sourceEndMs, style);
    assert.ok(
      !plan.pacing.issues.some((i) => i.code === "zoom-ping-pong"),
      `${style}: ${JSON.stringify(plan.pacing.issues)}`,
    );
  }
});

test("back-to-back zooms are a hand-off; a sliver of wide shot between them is ping-pong", () => {
  const zoom = (id, a, b) => ({ id, sourceStartMs: a, sourceEndMs: b, zoom: 1.6, type: "manual" });
  const input = (zooms) => ({
    slices: [{ sourceStartMs: 0, sourceEndMs: 20000, timeScale: 1 }],
    zooms,
    screenSpring: SPRINGS.schemaDefault,
  });
  const pingPong = (zooms) => checkPacing(input(zooms)).issues.some((i) => i.code === "zoom-ping-pong");
  assert.equal(pingPong([zoom("a", 3000, 7000), zoom("b", 7000, 11000)]), false);
  assert.equal(pingPong([zoom("a", 3000, 7000), zoom("b", 7800, 11800)]), true);
});

test("a manual zoom must say where it points", () => {
  assert.equal(editOp.safeParse({ op: "addZoom", startMs: 0, endMs: 3000, zoom: 1.5 }).success, false);
  assert.equal(
    editOp.safeParse({ op: "addZoom", startMs: 0, endMs: 3000, zoom: 1.5, target: { x: 0.4, y: 0.4 } })
      .success,
    true,
  );
  assert.equal(
    editOp.safeParse({ op: "addZoom", startMs: 0, endMs: 3000, zoom: 1.5, follow: true }).success,
    true,
  );
});
