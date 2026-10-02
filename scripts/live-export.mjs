// Exercise alternate encoding, cancellation and reconnect against seeded footage.
import { Studio } from "../dist/studio/service.js";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
if (process.env.SCREENSTUDIO_LIVE_TEST !== "1") throw new Error("Set SCREENSTUDIO_LIVE_TEST=1.");
const source = process.argv[2];
if (!source) throw new Error("Pass a seeded sample project.");
const studio = new Studio();
const job = await studio.exportStart(source, resolve(`.artifacts/alternate-${Date.now()}.gif`), {
  height: 240,
  fps: 24,
  format: "gif",
  quality: "studio",
});
const reconnected = new Studio();
let status;
for (let i = 0; i < 120; i++) {
  status = await reconnected.exportStatus(job.jobId);
  if (["completed", "failed", "cancelled"].includes(status.status)) break;
  await new Promise((r) => setTimeout(r, 1000));
}
assert.equal(status.status, "completed", JSON.stringify(status));
assert.equal(status.media.streams[0].codec_name, "gif");
const cancel = await studio.exportStart(source, resolve(`.artifacts/cancel-${Date.now()}.mp4`), {
  height: 2160,
  fps: 60,
  format: "mp4",
  quality: "studio",
});
let cancelled;
for (let i = 0; i < 20; i++) {
  const s = await studio.exportStatus(cancel.jobId);
  if (s.exportId) {
    cancelled = await studio.exportCancel(cancel.jobId);
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}
for (let i = 0; i < 30 && cancelled?.status !== "cancelled"; i++) {
  cancelled = await studio.exportStatus(cancel.jobId);
  await new Promise((r) => setTimeout(r, 100));
}
assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));
await writeFile(".artifacts/alternate-report.json", JSON.stringify({ gif: status, cancelled }, null, 2));
console.log("GIF, server reconnection and cancellation passed.");
