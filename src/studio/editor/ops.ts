// Editor ops: the schema agents send, and the Node-side checks and conversions
// that run before anything touches the editor.
import { z } from "zod";
import { validateConfigChange } from "../project.js";
import { ms, rect01, unit } from "../schemas.js";
import { round } from "../timeline.js";

const target = z.object({ x: unit, y: unit }).strict();
const loupe = z
  .object({
    radius01: z.number().min(0.05).max(1).optional(),
    bevelRatio: unit.optional(),
    chromaticAberration: unit.optional(),
    hasGlassOptics: z.boolean().optional(),
  })
  .strict();
const layoutOptions = z
  .object({
    cameraOverlay: z.object({ overlayCameraPosition01: target }).partial().strict().optional(),
    cutoutCamera: z.object({ cutoutCameraPositionX01: unit }).partial().strict().optional(),
    splitScreen: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
/** Tracks whose items have ids and source ranges. */
export const ITEM_TRACKS = ["layouts", "masks", "zooms"] as const;
export const CLEARABLE_TRACKS = [...ITEM_TRACKS, "voiceOvers"] as const;
/** Tracks an editor_view selection can point at. */
export const SELECTABLE_TRACKS = ["zooms", "masks", "layouts", "slices"] as const;
export const LAYOUT_TYPES = [
  "camera-overlay",
  "cutout-camera",
  "split-screen",
  "fullscreen-camera",
  "screen-only",
] as const;
export const MASK_TYPES = ["sensitive-data", "highlight"] as const;
export const editOp = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("setSlices"),
      slices: z
        .array(
          z
            .object({
              startMs: ms,
              endMs: ms,
              speed: z.number().finite().min(0.25).max(8),
              volume: unit.optional(), // above 1 breaks Screen Studio's audio mixing on export
              hideCursor: z.boolean().optional(),
              disableSmoothMouseMovement: z.boolean().optional(),
            })
            .strict(),
        )
        .min(1)
        .max(300),
    })
    .strict(),
  z
    .object({
      op: z.literal("addZoom"),
      startMs: ms,
      endMs: ms,
      zoom: z.number().finite().min(1).max(4),
      follow: z.boolean().default(false),
      target: target.optional(),
      presentation: z.enum(["screen", "loupe"]).default("screen"),
      loupe: loupe.optional(),
      instant: z.boolean().default(false),
    })
    .strict()
    .refine((o) => o.follow || o.target, {
      message:
        "A manual zoom needs a target (x, y 0-1 in the cropped frame). Use follow: true only to track the pointer.",
    }),
  z
    .object({
      op: z.literal("updateZoom"),
      zoomId: z.string().min(1),
      startMs: ms.optional(),
      endMs: ms.optional(),
      zoom: z.number().finite().min(1).max(4).optional(),
      follow: z.boolean().optional(),
      target: target.optional(),
      presentation: z.enum(["screen", "loupe"]).optional(),
      loupe: loupe.optional(),
    })
    .strict(),
  z.object({ op: z.literal("removeZoom"), zoomId: z.string().min(1) }).strict(),
  z.object({ op: z.literal("clearZooms") }).strict(),
  z
    .object({
      op: z.literal("addLayout"),
      startMs: ms,
      endMs: ms,
      type: z.enum(LAYOUT_TYPES),
      options: layoutOptions.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("addMask"),
      startMs: ms,
      endMs: ms,
      type: z.enum(MASK_TYPES),
      rects: z.array(rect01).min(1).max(10).optional(),
      blur: z.number().min(0).max(100).optional(),
      highlightOpacity: unit.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("updateItem"),
      track: z.enum(ITEM_TRACKS),
      id: z.string().min(1),
      startMs: ms.optional(),
      endMs: ms.optional(),
      fields: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z.object({ op: z.literal("removeItem"), track: z.enum(CLEARABLE_TRACKS), id: z.string().min(1) }).strict(),
  z.object({ op: z.literal("clearTrack"), track: z.enum(CLEARABLE_TRACKS) }).strict(),
  z.object({ op: z.literal("duplicateItem"), track: z.enum(ITEM_TRACKS), id: z.string().min(1) }).strict(),
  z.object({ op: z.literal("setTrackDisabled"), track: z.enum(ITEM_TRACKS), disabled: z.boolean() }).strict(),
  z.object({ op: z.literal("restoreAutoZooms") }).strict(),
  z.object({ op: z.literal("splitAt"), atMs: ms }).strict(),
  z.object({ op: z.literal("cutRange"), startMs: ms, endMs: ms }).strict(),
  z.object({ op: z.literal("removeSlice"), id: z.string().min(1) }).strict(),
  z
    .object({ op: z.literal("mergeSlices"), id: z.string().min(1), with: z.enum(["next", "previous"]) })
    .strict(),
  z
    .object({
      op: z.literal("updateSlice"),
      id: z.string().min(1),
      speed: z.number().finite().min(0.25).max(8).optional(),
      volume: unit.optional(),
      systemAudioVolume: unit.optional(),
      externalDeviceAudioVolume: unit.optional(),
      hideCursor: z.boolean().optional(),
      disableSmoothMouseMovement: z.boolean().optional(),
    })
    .strict(),
  z.object({ op: z.literal("resetCuts") }).strict(),
  z
    .object({
      op: z.literal("config"),
      changes: z
        .record(z.string(), z.unknown())
        .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 80),
    })
    .strict(),
]);
export type EditOp = z.infer<typeof editOp>;

/** Turns dotted config keys into per-group partials, merging nested objects. */
export function configPartial(config: any, changes: Record<string, unknown>) {
  const partial: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(changes)) {
    // A whole group would skip the per-field rules, and update() merges it anyway.
    if (!key.includes("."))
      throw new Error(`Use dotted config keys like ${key}.<field>, not a whole group (${key}).`);
    const validated = validateConfigChange(config, key, value);
    const [group, field, ...rest] = key.split(".");
    partial[group] ??= {};
    if (!rest.length) {
      partial[group][field] = validated;
      continue;
    }
    const base = structuredClone(partial[group][field] ?? config[group][field]);
    let node = base;
    for (const part of rest.slice(0, -1)) node = node[part];
    node[rest.at(-1)!] = validated;
    partial[group][field] = base;
  }
  return partial;
}

const FORBIDDEN_FIELDS = ["id", "__proto__", "constructor", "prototype"];

type Range = { id?: string; sourceStartMs: number; sourceEndMs: number };
type ItemTrack = (typeof ITEM_TRACKS)[number];
/** The scene's item tracks as known before the batch; a track left out is not checked. */
export type SceneTracks = Partial<Record<ItemTrack, Range[]>>;

const points = (rects: z.infer<typeof rect01>[], size: { width: number; height: number }) =>
  rects.map((r) => ({
    x: Math.round(r.x * size.width),
    y: Math.round(r.y * size.height),
    width: Math.round(r.width * size.width),
    height: Math.round(r.height * size.height),
  }));

/** Mask updates take 0-1 rects like addMask; raw bounds must be capture points. */
function maskFields(fields: Record<string, unknown>, size: { width: number; height: number }) {
  const f = { ...fields };
  if (f.rects !== undefined) {
    f.bounds = points(z.array(rect01).min(1).max(10).parse(f.rects), size);
    delete f.rects;
  } else if (
    Array.isArray(f.bounds) &&
    f.bounds.length &&
    f.bounds.every((b: any) =>
      [b?.x, b?.y, b?.width, b?.height].every((v) => typeof v === "number" && v <= 1),
    )
  )
    throw new Error("Mask bounds are in capture points; pass fields.rects with 0-1 values instead.");
  return f;
}

/**
 * Validates ops against the open scene and turns them into what the page script
 * runs: config changes become per-group partials and mask rects become points.
 * Item tracks are replayed through the batch, so updates and removals of ids
 * that do not exist, inverted or out-of-recording ranges, and updates that
 * would overlap a neighbour all fail here, before anything is applied.
 */
export function prepareOps(
  ops: unknown[],
  scene: {
    sourceMs: number;
    config: any;
    captureSize: { width: number; height: number };
    tracks?: SceneTracks;
  },
) {
  const { sourceMs: source, captureSize: size } = scene;
  const config = structuredClone(scene.config);
  const inRecording = (startMs: number, endMs: number) => endMs > startMs && endMs <= source + 1;
  // null once a track's contents can no longer be known ahead (duplicates, auto zooms).
  const tracks: Record<ItemTrack, Range[] | null> = {
    zooms: scene.tracks?.zooms?.map((x) => ({ ...x })) ?? null,
    layouts: scene.tracks?.layouts?.map((x) => ({ ...x })) ?? null,
    masks: scene.tracks?.masks?.map((x) => ({ ...x })) ?? null,
  };
  const find = (track: ItemTrack, id: string) => {
    const items = tracks[track];
    if (!items) return undefined;
    const item = items.find((x) => x.id === id);
    if (!item) throw new Error(`${track} item ${id} does not exist.`);
    return item;
  };
  const move = (track: ItemTrack, id: string, startMs?: number, endMs?: number) => {
    const item = find(track, id);
    if (!item) return;
    const start = startMs ?? item.sourceStartMs;
    const end = endMs ?? item.sourceEndMs;
    if (!inRecording(start, end))
      throw new Error(
        `${track} item ${id} would span ${round(start)}-${round(end)}ms; it must end after it starts and stay inside the ${round(source)}ms recording.`,
      );
    const clash = tracks[track]!.find((x) => x !== item && x.sourceStartMs < end && x.sourceEndMs > start);
    if (clash)
      throw new Error(
        `${track} item ${id} at ${round(start)}-${round(end)}ms would overlap ${clash.id ?? "an item added earlier in this batch"} (${round(clash.sourceStartMs)}-${round(clash.sourceEndMs)}ms). Shorten or remove that one first.`,
      );
    item.sourceStartMs = start;
    item.sourceEndMs = end;
  };
  const add = (track: ItemTrack, sourceStartMs: number, sourceEndMs: number) =>
    tracks[track]?.push({ sourceStartMs, sourceEndMs });
  const remove = (track: ItemTrack, id: string) => {
    const item = find(track, id);
    if (item) tracks[track] = tracks[track]!.filter((x) => x !== item);
  };

  return ops.map((raw) => {
    const op = editOp.parse(raw);
    if (op.op === "setSlices") {
      let previous = 0;
      for (const s of op.slices) {
        if (!inRecording(s.startMs, s.endMs))
          throw new Error(
            `Slice ${s.startMs}-${s.endMs} must be positive and inside the ${round(source)}ms recording.`,
          );
        if (s.startMs < previous) throw new Error("Slices must be in order and not overlap.");
        previous = s.endMs;
      }
    }
    if (op.op === "addZoom" && !inRecording(op.startMs, op.endMs))
      throw new Error(`Zoom ${op.startMs}-${op.endMs} must be positive and inside the recording.`);
    if (op.op === "config") {
      const partial = configPartial(config, op.changes);
      for (const [group, fields] of Object.entries(partial)) Object.assign(config[group], fields);
      return { op: "config", partial };
    }
    if (op.op === "cutRange" && !inRecording(op.startMs, op.endMs))
      throw new Error(`cutRange ${op.startMs}-${op.endMs} must be positive and inside the recording.`);
    if ((op.op === "addLayout" || op.op === "addMask") && !inRecording(op.startMs, op.endMs))
      throw new Error(`${op.op} ${op.startMs}-${op.endMs} must be positive and inside the recording.`);
    if (op.op === "addZoom") add("zooms", op.startMs, op.endMs);
    if (op.op === "addLayout") add("layouts", op.startMs, op.endMs);
    if (op.op === "addMask") add("masks", op.startMs, op.endMs);
    if (op.op === "updateZoom") move("zooms", op.zoomId, op.startMs, op.endMs);
    if (op.op === "removeZoom") remove("zooms", op.zoomId);
    if (op.op === "clearZooms") tracks.zooms = [];
    if (op.op === "removeItem" && op.track !== "voiceOvers") remove(op.track, op.id);
    if (op.op === "clearTrack" && op.track !== "voiceOvers") tracks[op.track] = [];
    if (op.op === "duplicateItem") {
      find(op.track, op.id);
      tracks[op.track] = null;
    }
    if (op.op === "restoreAutoZooms") tracks.zooms = null;
    if (op.op === "addMask" && op.rects) return { ...op, bounds: points(op.rects, size) };
    if (op.op === "updateItem") {
      if (op.fields && Object.keys(op.fields).some((k) => FORBIDDEN_FIELDS.includes(k)))
        throw new Error("updateItem fields cannot change id or prototypes.");
      move(op.track, op.id, op.startMs, op.endMs);
      if (op.track === "masks" && op.fields) return { ...op, fields: maskFields(op.fields, size) };
    }
    return op;
  });
}
