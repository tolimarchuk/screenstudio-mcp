// Seeded native fixture only. Moves the real pointer and records the demo app,
// then edits live in the Screen Studio editor and renders, all through MCP.
// Launch .artifacts/Demo.app first and pass its window ID. Output stays in .artifacts.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
if (process.env.SCREENSTUDIO_LIVE_TEST !== "1") throw new Error("Set SCREENSTUDIO_LIVE_TEST=1.");
const windowId = Number(process.argv[2]);
assert.ok(windowId > 0);
await mkdir(".artifacts", { recursive: true });
const client = new Client({ name: "live-recorder", version: "1" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["dist/mcp/main.js"],
    env: { ...process.env },
    stderr: "inherit",
  }),
);
async function call(name, args = {}) {
  const r = await client.callTool({ name: "screenstudio_" + name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  const images = r.content.filter((c) => c.type === "image");
  const text = r.content.filter((c) => c.type === "text").at(-1)?.text;
  return images.length ? { images, text } : JSON.parse(text ?? "null");
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function beat(steps) {
  const observed = await call("desktop_inspect", { windowId });
  assert.equal(observed.title, "Screen Studio MCP Demo");
  return call("desktop_perform", { observationToken: observed.observationToken, steps, pace: 1.1 });
}
let recording = false;
const report = {};
try {
  const observed = await call("desktop_inspect", { windowId });
  await call("desktop_action", { observationToken: observed.observationToken, action: { type: "focus" } });
  await call("record_start", { windowId, name: "MCP calm walkthrough" });
  recording = true;
  await wait(1500); // opening shot
  report.beat1 = await beat([
    { action: { type: "click", x: 380, y: 490 }, holdMs: 500 },
    { action: { type: "key", key: "a", modifiers: ["command"] }, holdMs: 300 },
    { action: { type: "type", text: "Onboarding tour" } },
    { action: { type: "click", x: 960, y: 490 }, holdMs: 1800 },
  ]);
  await wait(5000); // an agent thinking between beats: the plan should cut this
  report.beat2 = await beat([{ action: { type: "click", x: 225, y: 641 }, holdMs: 2500 }]);
  const captured = await call("record_control", { action: "finish" });
  recording = false;
  const project = captured.projectPath;

  const analysis = await call("analyze", { projectPath: project });
  assert.ok(analysis.totals.clicks >= 3, "clicks recorded");
  assert.equal(analysis.totals.typingBursts, 1, "one typing burst");
  assert.ok(
    analysis.idle.some((i) => i.endMs - i.startMs > 3500),
    "thinking gap is idle",
  );
  const plan = await call("plan_edit", { projectPath: project, style: "calm" });
  assert.notEqual(plan.pacing.verdict, "too fast");
  assert.ok(plan.pacing.playbackMs < analysis.sourceDurationMs - 2500, "dead air cut");

  await call("editor_open", { projectPath: project });
  const applied = await call("editor_apply", { projectPath: project, ops: plan.ops });
  assert.equal(applied.pacing.issues.filter((i) => i.severity === "error").length, 0);
  const frames = await call("editor_frame", {
    projectPath: project,
    playbackMs: [800, ...applied.timeline.zooms.map((z) => z.playbackStartMs + z.onScreenMs / 2)],
  });
  for (const [i, img] of frames.images.entries())
    await writeFile(`.artifacts/calm-frame-${i}.png`, Buffer.from(img.data, "base64"));
  await call("editor_save", { projectPath: project });

  const outputPath = resolve(`.artifacts/calm-${Date.now()}.mp4`);
  const job = await call("export_start", { projectPath: project, outputPath, height: 1080, fps: 60 });
  let status;
  for (let i = 0; i < 240; i++) {
    status = await call("export_status", { jobId: job.jobId });
    if (["completed", "failed", "cancelled"].includes(status.status)) break;
    await wait(1000);
  }
  assert.equal(status.status, "completed");
  const seconds = Number(status.media.format.duration);
  assert.ok(Math.abs(seconds * 1000 - applied.pacing.playbackMs) < 300, "render matches the edit");
  Object.assign(report, {
    project,
    analysis: analysis.totals,
    plan: plan.summary,
    pacing: applied.pacing,
    timeline: applied.timeline,
    export: status,
  });
  await writeFile(".artifacts/calm-report.json", JSON.stringify(report, null, 2));
  console.log(
    `Recorded, planned (${plan.summary}), edited live and rendered ${seconds.toFixed(1)}s: ${outputPath}`,
  );
} finally {
  if (recording)
    await call("record_control", { action: "finish" }).catch((e) =>
      console.error("Recording cleanup failed:", e.message),
    );
  await client.close();
}
