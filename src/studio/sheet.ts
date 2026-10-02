// Contact sheets: the moments that matter in one labelled grid, so a whole edit
// (or a set of rendered files) can be reviewed in one look before anyone watches it.
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Studio } from "./service.js";
import { previewSeconds, videoTiming } from "./service.js";
import type { Editor } from "./editor/editor.js";
import type { describeScene } from "./editor/describe.js";
import { frameAt, hasFilter, labelFont, tileImages } from "./media.js";
import { round } from "./timeline.js";

export interface Moment {
  playbackMs: number;
  kind:
    | "opening"
    | "cut"
    | "before-cut"
    | "speed"
    | "zoom"
    | "loupe"
    | "layout"
    | "mask"
    | "issue"
    | "ending"
    | "pick";
  label: string;
  itemId?: string;
}
export interface Tile extends Moment {
  n: number;
}

type Scene = ReturnType<typeof describeScene>;

/** Lower comes first when moments compete for a slot or sit within 400ms of each other. */
const PRIORITY: Record<Moment["kind"], number> = {
  pick: 0,
  opening: 0,
  ending: 0,
  cut: 1,
  "before-cut": 1.5,
  zoom: 2,
  loupe: 2,
  issue: 3,
  layout: 4,
  mask: 4,
  speed: 5,
};
const NEAR_MS = 400;

/** "0:04.2" */
export const clock = (ms: number) => {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};

/** The label printed on a tile: "3 · 0:04.2 cut". */
export const tileLabel = (t: Tile) => `${t.n} · ${clock(t.playbackMs)} ${t.label}`;

/**
 * The moments worth a frame, in playback order: the opening, each cut and the
 * frame just before it (so the join is visible), each zoom at its midpoint,
 * each layout and mask once it has settled, each pacing issue, and the ending.
 * Moments within 400ms of a more important one are dropped; at most `max`.
 */
export function keyMoments(
  scene: Scene,
  o: { issues?: { code: string; atPlaybackMs?: number }[]; max?: number } = {},
): Moment[] {
  const duration = Math.max(0, ...scene.slices.map((s) => s.playbackEndMs));
  const all: Moment[] = [{ playbackMs: 0, kind: "opening", label: "opening" }];
  scene.slices.forEach((s, i) => {
    const prev = scene.slices[i - 1];
    if (!prev) return;
    if (Math.abs(prev.sourceEndMs - s.sourceStartMs) > 50) {
      all.push({ playbackMs: s.playbackStartMs, kind: "cut", label: "cut", itemId: s.id });
      all.push({
        playbackMs: Math.max(0, s.playbackStartMs - 200),
        kind: "before-cut",
        label: "before cut",
        itemId: s.id,
      });
    } else if (Math.abs(prev.speed - s.speed) > 0.01)
      all.push({
        playbackMs: Math.min(s.playbackEndMs, s.playbackStartMs + 300),
        kind: "speed",
        label: `${s.speed}x`,
        itemId: s.id,
      });
  });
  for (const z of scene.zooms) {
    if (z.disabled || z.playbackStartMs === null) continue;
    const loupe = z.presentation === "loupe";
    all.push({
      playbackMs: z.playbackStartMs + z.onScreenMs / 2,
      kind: loupe ? "loupe" : "zoom",
      label: `${loupe ? "loupe" : "zoom"} ${z.zoom}x`,
      itemId: z.id,
    });
  }
  for (const [kind, items] of [
    ["layout", scene.layouts],
    ["mask", scene.masks],
  ] as const)
    for (const x of items as {
      id?: string;
      type: string;
      disabled?: boolean;
      playbackStartMs: number | null;
      playbackEndMs: number | null;
    }[])
      // A disabled layout or mask does not render, so it gets no tile.
      if (x.playbackStartMs !== null && !x.disabled)
        all.push({
          playbackMs: Math.min(x.playbackEndMs ?? x.playbackStartMs, x.playbackStartMs + 400),
          kind,
          label: `${kind} ${x.type}`,
          itemId: x.id,
        });
  for (const i of o.issues ?? [])
    if (i.atPlaybackMs !== undefined) all.push({ playbackMs: i.atPlaybackMs, kind: "issue", label: i.code });
  if (duration > 0) all.push({ playbackMs: Math.max(0, duration - 500), kind: "ending", label: "ending" });

  const kept: Moment[] = [];
  const pair = (a: Moment, b: Moment) =>
    a.itemId !== undefined &&
    a.itemId === b.itemId &&
    [a.kind, b.kind].includes("cut") &&
    [a.kind, b.kind].includes("before-cut");
  const ranked = all
    .filter((m) => m.playbackMs >= 0 && m.playbackMs <= duration)
    .sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.playbackMs - b.playbackMs);
  for (const m of ranked) {
    if (kept.length >= (o.max ?? 24)) break;
    if (kept.some((k) => Math.abs(k.playbackMs - m.playbackMs) < NEAR_MS && !pair(k, m))) continue;
    kept.push(m);
  }
  return kept
    .map((m) => ({ ...m, playbackMs: round(m.playbackMs) }))
    .sort((a, b) => a.playbackMs - b.playbackMs);
}

/** Width and height from a PNG header. */
export const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Tiles images into one PNG with a label on each. Labels need ffmpeg's drawtext
 * and a system font; without either the sheet is still made, unlabelled, and the
 * notes say so.
 */
async function renderSheet(
  studio: Studio,
  images: string[],
  labels: string[],
  o: { columns: number; cellWidth: number; cellHeight: number },
) {
  const id = randomUUID();
  const out = await studio.statePath(`sheet-${id}.png`);
  const notes: string[] = [];
  const font = await labelFont();
  let labelled = !!font && (await hasFilter("drawtext"));
  if (!labelled)
    notes.push(
      font
        ? "This ffmpeg has no drawtext filter, so tiles are unlabelled; read the tiles list for their times."
        : "No system font for labels, so tiles are unlabelled; read the tiles list for their times.",
    );
  const files = labelled
    ? await Promise.all(
        labels.map(async (text, i) => {
          const f = await studio.statePath(`sheet-${id}-${i}.txt`);
          await writeFile(f, text, { mode: 0o600 });
          return f;
        }),
      )
    : [];
  try {
    try {
      await tileImages(images, out, { ...o, labelFiles: labelled ? files : undefined, font });
    } catch (e) {
      if (!labelled) throw e;
      labelled = false;
      notes.push(
        `Labels could not be drawn (${
          String((e as any)?.stderr ?? e)
            .trim()
            .split("\n")[0]
        }); tiles are unlabelled.`,
      );
      await tileImages(images, out, o);
    }
  } finally {
    await Promise.all(files.map((f) => rm(f, { force: true })));
  }
  return { path: out, data: await readFile(out), labelled, notes };
}

/** A contact sheet of the open editor's preview at the given moments, captured in one pass. */
export async function contactSheet(
  studio: Studio,
  editor: Editor,
  projectPath: string,
  moments: Moment[],
  o: { columns?: number; width?: number } = {},
) {
  if (!moments.length) throw new Error("No moments to capture.");
  if (moments.length > 24) throw new Error("A contact sheet holds at most 24 frames.");
  const frames = await editor.frames(
    projectPath,
    moments.map((m) => m.playbackMs),
  );
  const columns = Math.min(o.columns ?? 4, moments.length);
  const cellWidth = even(o.width ?? 480);
  const first = pngSize(frames[0].data);
  const cellHeight = even((cellWidth * first.height) / first.width);
  const tiles: Tile[] = moments.map((m, i) => ({ ...m, n: i + 1, playbackMs: frames[i].playheadMs }));
  try {
    const sheet = await renderSheet(
      studio,
      frames.map((f) => f.path),
      tiles.map(tileLabel),
      { columns, cellWidth, cellHeight },
    );
    return { ...sheet, tiles };
  } finally {
    // The full-resolution frames are only steps on the way to the sheet.
    await Promise.all(frames.map((f) => rm(f.path, { force: true }).catch(() => {})));
  }
}

/** Opening, midpoint and ending of a video, as playback times. */
export function filePoints(durationMs: number) {
  return [
    { label: "opening", ms: 0 },
    { label: "midpoint", ms: durationMs / 2 },
    { label: "ending", ms: Math.max(0, durationMs - 500) },
  ];
}

/**
 * One row per rendered file, at its opening, midpoint and ending. Files with
 * different aspects share square cells, letterboxed, so the rows line up.
 */
export async function contactSheetFromFile(
  studio: Studio,
  videos: { path: string; label: string }[],
  o: { width?: number } = {},
) {
  if (!videos.length) throw new Error("No rendered files to show.");
  const images: string[] = [];
  const labels: string[] = [];
  const sizes: { width: number; height: number }[] = [];
  const tiles: { n: number; file: string; playbackMs: number; label: string }[] = [];
  for (const v of videos) {
    const timing = await videoTiming(v.path);
    for (const p of filePoints(timing.endSec * 1000)) {
      const out = await studio.statePath(`sheet-frame-${randomUUID()}.png`);
      await frameAt(v.path, previewSeconds(Math.min(p.ms, timing.endSec * 1000), timing), out);
      const data = await readFile(out).catch(() => {
        throw new Error(`No frame at ${clock(p.ms)} in ${v.label}.`);
      });
      images.push(out);
      sizes.push(pngSize(data));
      const n = tiles.length + 1;
      tiles.push({ n, file: v.path, playbackMs: round(p.ms), label: `${v.label} ${p.label}` });
      labels.push(`${n} · ${v.label} · ${clock(p.ms)} ${p.label}`);
    }
  }
  const cellWidth = even(o.width ?? 320);
  const ratios = new Set(sizes.map((s) => (s.width / s.height).toFixed(2)));
  const cellHeight = ratios.size === 1 ? even((cellWidth * sizes[0].height) / sizes[0].width) : cellWidth;
  try {
    const sheet = await renderSheet(studio, images, labels, { columns: 3, cellWidth, cellHeight });
    return { ...sheet, tiles };
  } finally {
    await Promise.all(images.map((i) => rm(i, { force: true })));
  }
}

/** A contact sheet of finished export jobs, one row per job. */
export async function contactSheetFromJobs(studio: Studio, jobIds: string[], o: { width?: number } = {}) {
  const videos = [];
  for (const id of jobIds) {
    const job = await studio.exportStatus(id);
    if (job.status !== "completed")
      throw new Error(`Export ${id} is ${job.status}; wait for it to complete before making a sheet.`);
    videos.push({ path: job.outputPath as string, label: basename(job.outputPath) });
  }
  return contactSheetFromFile(studio, videos, o);
}

/** Two frames side by side, labelled: the first and last frame of a loop, to judge the join. */
export async function sideBySide(studio: Studio, frames: { path: string; label: string }[], width = 480) {
  const first = pngSize(await readFile(frames[0].path));
  const cellWidth = even(width);
  return renderSheet(
    studio,
    frames.map((f) => f.path),
    frames.map((f) => f.label),
    { columns: frames.length, cellWidth, cellHeight: even((cellWidth * first.height) / first.width) },
  );
}

/** A frame of a video at a playback time, clamped onto its last frame. */
export async function videoFrame(studio: Studio, video: string, timeMs: number) {
  const timing = await videoTiming(video);
  const out = await studio.statePath(`frame-${randomUUID()}.png`);
  await frameAt(video, previewSeconds(Math.min(Math.max(0, timeMs), timing.endSec * 1000), timing), out);
  await readFile(out).catch(() => {
    throw new Error(`No frame at ${clock(timeMs)} in the video.`);
  });
  return out;
}
