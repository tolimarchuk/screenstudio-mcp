// Delivery: one edit rendered for every place it goes (variants), the kit that
// travels with it (posters, captions, chapters, a manifest), and seamless loops.
// Variants render clones of the project data, so the editor never changes, and
// nothing in the output folder is ever overwritten.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Studio } from "./service.js";
import type { Editor } from "./editor/editor.js";
import type { EditOp } from "./editor/ops.js";
import { configPartial } from "./editor/ops.js";
import { readRecordingMeta, sessionAt, type Analysis } from "./recording.js";
import { planEdit, type Plan, type PlannedZoom } from "./plan.js";
import { checkStyle, secs, STOP_CLICK_MS } from "./pacing.js";
import { ASPECTS, STYLES, type Style } from "./styles.js";
import { burnSubtitles, frameAt, hasFilter, probe, ssim, toGif, toWebm } from "./media.js";
import { assCanvas, buildAss, captionLines, type CaptionStyle } from "./narration-captions.js";
import { previewSeconds, videoTiming } from "./service.js";
import { overlaps, subtractSpans, type Span } from "./spans.js";
import {
  playbackDuration,
  playbackRange,
  round,
  toPlaybackNearest,
  toSource,
  type Slice,
  type Zoom,
} from "./timeline.js";
import { clock, contactSheetFromFile, sideBySide, videoFrame } from "./sheet.js";
import { shortHash } from "./util.js";

// ---------------------------------------------------------------- targets

export interface Target {
  aspect: "16:9" | "1:1" | "4:5" | "9:16";
  height: number;
  fps: 24 | 30 | 60;
  format: "mp4" | "gif";
  maxMs?: number;
  maxBytes?: number;
  captions?: { sizeRatio: number; position01?: { x: number; y: number } };
  paddingRatio01?: number;
  cutoutCameraSizeRatio01?: number;
  /** Add fixed-target zooms so the action stays readable when the screen is small in the frame. */
  zoomForAction?: boolean;
  why: string;
}

/** Where a video goes, and how it is rendered for that place. None is a default; pick per destination. */
export const TARGETS = {
  x: {
    aspect: "16:9",
    height: 1080,
    fps: 60,
    format: "mp4",
    maxMs: 140000,
    maxBytes: 512_000_000,
    why: "X plays 16:9 inline and caps most accounts at 2:20; 1080p60 keeps UI text and cursor motion crisp.",
  },
  landing: {
    aspect: "16:9",
    height: 1080,
    fps: 60,
    format: "mp4",
    why: "A landing page hero sits in a wide slot; 1080p60 holds up on retina screens at embed widths.",
  },
  linkedin: {
    aspect: "1:1",
    height: 1080,
    fps: 30,
    format: "mp4",
    maxMs: 600000,
    captions: { sizeRatio: 0.055 },
    paddingRatio01: 0.05,
    why: "LinkedIn's feed gives square video more room and most people watch muted, so captions are larger; 30fps keeps the file light.",
  },
  shorts: {
    aspect: "9:16",
    height: 1080,
    fps: 60,
    format: "mp4",
    maxMs: 60000,
    captions: { sizeRatio: 0.06, position01: { x: 0.5, y: 0.68 } },
    paddingRatio01: 0.02,
    cutoutCameraSizeRatio01: 0.55,
    zoomForAction: true,
    why: "Shorts, Reels and TikTok fill a phone screen: the recording gets fixed zooms so the action stays readable, captions sit above the app's own buttons, and under a minute plays everywhere.",
  },
  portrait: {
    aspect: "4:5",
    height: 1080,
    fps: 30,
    format: "mp4",
    maxMs: 90000,
    captions: { sizeRatio: 0.05 },
    paddingRatio01: 0.03,
    why: "Instagram and LinkedIn mobile feeds show 4:5 at full width without the full-screen crop of 9:16.",
  },
  docs: {
    aspect: "16:9",
    height: 1080,
    fps: 30,
    format: "mp4",
    why: "Docs and help centres embed wide; 30fps halves the file and nobody needs 60fps to read a setting.",
  },
  gif: {
    aspect: "16:9",
    height: 480,
    fps: 24,
    format: "gif",
    maxMs: 15000,
    maxBytes: 12_000_000,
    why: "READMEs and chat embed GIFs that autoplay; 480px tall and under 12 MB loads fast on GitHub.",
  },
} satisfies Record<string, Target>;
export type TargetName = keyof typeof TARGETS;
export const TARGET_NAMES = Object.keys(TARGETS) as [TargetName, ...TargetName[]];

/** A single export setting, as a recipe carries it: height, frame rate and format for one aspect. */
export interface ExportSpec {
  aspect: string;
  /** The short side of the frame, like every target's height. */
  height: number;
  fps: 24 | 30 | 60;
  format: "mp4" | "gif";
}

/**
 * The targets with a recipe's export spec laid over them. The frame rate goes to
 * every video target, because it follows the footage (camera footage is 30fps).
 * The resolution (the short side, as everywhere) goes to video targets in the
 * recipe's own aspect. GIFs keep their own size and frame rate: the size budget
 * decides those.
 */
export function targetsForSpec(names: TargetName[], spec: ExportSpec) {
  const short = spec.height;
  const targets: Partial<Record<TargetName, Target>> = {};
  const notes: string[] = [];
  for (const name of names) {
    const base: Target = TARGETS[name];
    if (base.format === "gif") continue;
    const t: Target = { ...base, fps: spec.fps };
    if (base.aspect === spec.aspect) t.height = short;
    const changed = [
      t.fps !== base.fps && `${t.fps}fps instead of ${base.fps}`,
      t.height !== base.height && `${t.height}p instead of ${base.height}p`,
    ].filter(Boolean);
    if (changed.length) notes.push(`${name}: ${changed.join(" and ")}, from the recipe's export settings.`);
    targets[name] = t;
  }
  if (spec.format === "gif" && !names.includes("gif"))
    notes.push("The recipe exports a GIF; add the gif target for one under its size budget.");
  return { targets, notes };
}

/** A frame's width/height ratio from "9:16", a number, or "auto" (then `auto`, the recording's own). */
export function aspectRatioOf(aspect: string | number | undefined, auto?: number) {
  if (typeof aspect === "number") return aspect > 0 ? aspect : undefined;
  if (typeof aspect === "string" && aspect.includes(":")) {
    const [w, h] = aspect.split(":").map(Number);
    return w > 0 && h > 0 ? w / h : undefined;
  }
  return auto && auto > 0 ? auto : undefined;
}

/**
 * The height to ask Screen Studio's export for, given the frame's short side and
 * its aspect ("9:16", a width/height ratio, or "auto" with the recording's own
 * ratio in `auto`). Screen Studio reads its export height as the frame's real
 * height (a 9:16 render at 1080 comes out 606x1080), while targets and recipes
 * carry the short side, so portrait frames ask for their full height, even:
 * 9:16 at 1080 asks for 1920, 4:5 for 1350, 1:1 and wide frames for 1080. Every
 * render goes through here.
 */
export function renderHeight(aspect: string | number | undefined, shortSide: number, auto?: number) {
  const ratio = aspectRatioOf(aspect, auto);
  const short = even(shortSide);
  return ratio && ratio < 1 ? even(short / ratio) : short;
}

/** H.264 frames have even sides: the nearest even number, never under 2. */
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** The frame a short side and aspect make, width x height, both even. */
export function frameSize(aspect: string | number | undefined, shortSide: number, auto?: number) {
  const ratio = aspectRatioOf(aspect, auto) ?? 1;
  const short = even(shortSide);
  const height = renderHeight(ratio, short);
  return { width: ratio < 1 ? short : even(short * ratio), height };
}

/**
 * The recording's own width/height ratio, as an "auto" frame takes it: the
 * capture's size cut by the project's crop (crop.rect01). Undefined when the
 * size is unknown.
 */
export function captureRatio(
  capture: { widthPt: number; heightPt: number } | undefined,
  crop?: { width?: number; height?: number } | null,
) {
  if (!capture || !(capture.widthPt > 0) || !(capture.heightPt > 0)) return undefined;
  const w = crop?.width && crop.width > 0 ? crop.width : 1;
  const h = crop?.height && crop.height > 0 ? crop.height : 1;
  return (capture.widthPt * w) / (capture.heightPt * h);
}

/**
 * What an export of this project asks Screen Studio for, given the frame's
 * short side: the height, the frame it makes, and a note when the two differ or
 * the size is unknown. An "auto" frame takes the recording's ratio from the
 * analysis's capture when there is one, else from the recording's metadata, and
 * applies the project's crop.
 */
export async function exportFrame(
  projectPath: string,
  config: any,
  shortSide: number,
  capture?: { widthPt: number; heightPt: number },
) {
  const aspect = config?.output?.aspectRatio;
  let auto: number | undefined;
  if (aspectRatioOf(aspect) === undefined) {
    let size = capture;
    if (!size) {
      const b = await readRecordingMeta(projectPath)
        .then((m) => m.sessions[0]?.bounds)
        .catch(() => undefined);
      if (b) size = { widthPt: b.width, heightPt: b.height };
    }
    auto = captureRatio(size, config?.crop?.rect01);
    if (auto === undefined)
      return {
        height: even(shortSide),
        frame: undefined,
        note: `The recording's size could not be read, so height ${shortSide} goes to Screen Studio as the frame's height. A portrait recording comes out with ${shortSide} as its long side; set a fixed aspect for an exact frame.`,
      };
  }
  const height = renderHeight(aspect, shortSide, auto);
  const frame = frameSize(aspect, shortSide, auto);
  return {
    height,
    frame,
    note:
      height === shortSide
        ? undefined
        : `Rendering ${frame.width}x${frame.height}: height ${shortSide} is the frame's short side, so ${height === even(shortSide) ? "Screen Studio is asked for the nearest even height" : `this portrait frame asks Screen Studio for ${height}`}.`,
  };
}

const has = (config: any, key: string) => {
  let node = config;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object" || !Object.hasOwn(node, part)) return false;
    node = node[part];
  }
  return true;
};

/**
 * The dotted settings a target changes. Settings this project's config does not
 * have (an older project without a cutout camera, say) are skipped and named.
 */
export function targetChanges(target: Target, config: any) {
  const want: Record<string, unknown> = { "output.aspectRatio": ASPECTS[target.aspect] };
  if (target.paddingRatio01 !== undefined) want["output.paddingRatio01"] = target.paddingRatio01;
  if (target.captions) want["captions.sizeRatio"] = target.captions.sizeRatio;
  if (target.captions?.position01) want["captions.position01"] = target.captions.position01;
  if (target.cutoutCameraSizeRatio01 !== undefined)
    want["defaultLayout.cutoutCamera.cutoutCameraSizeRatio01"] = target.cutoutCameraSizeRatio01;
  const changes: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const [k, v] of Object.entries(want)) has(config, k) ? (changes[k] = v) : skipped.push(k);
  return { changes, skipped };
}

/** Merges configPartial() output into a config, group by group. */
export function applyPartial(config: any, partial: Record<string, Record<string, unknown>>) {
  for (const [group, fields] of Object.entries(partial)) config[group] = { ...config[group], ...fields };
  return config;
}

const LOUPE_DEFAULTS = { radius01: 0.35, bevelRatio: 0.2, chromaticAberration: 0.5, hasGlassOptics: true };

/**
 * Fixed-target zoom items for planned zooms that do not overlap the scene's own
 * zooms and stay on screen long enough on its timeline (not the plan's), clear of
 * the opening and ending wide shots. Fields mirror what the editor's addZoom writes.
 */
export function actionZooms(planned: PlannedZoom[], slices: Slice[], existing: Zoom[]): Zoom[] {
  const duration = playbackDuration(slices);
  const taken: Span[] = existing.map((z) => ({ startMs: z.sourceStartMs, endMs: z.sourceEndMs }));
  const out: Zoom[] = [];
  for (const z of planned) {
    const span = { startMs: z.sourceStartMs, endMs: z.sourceEndMs };
    if (overlaps(span, taken)) continue;
    const r = playbackRange(slices, z.sourceStartMs, z.sourceEndMs);
    if (!r || r.visibleMs < 2000 || r.startMs < 1000 || r.endMs > duration - 800) continue;
    out.push({
      id: randomUUID(),
      sourceStartMs: z.sourceStartMs,
      sourceEndMs: z.sourceEndMs,
      zoom: z.zoom,
      type: "manual",
      manualTargetPoint: z.target,
      isDisabled: false,
      hasInstantAnimation: false,
      presentation: "screen",
      loupeOptions: LOUPE_DEFAULTS,
    } as Zoom);
    taken.push(span);
  }
  return out;
}

/** Zoom rules for a vertical frame, where the screen is small: deeper zooms, grouped more loosely. */
export const VERTICAL_RULES = { zoomLevels: [2.2, 1.8], zoomGroupGapMs: 8000 };

/** Somewhere the viewer must see, in source ms and screen fractions: a click, or where typing goes. */
export interface ActionPoint {
  atMs: number;
  x: number;
  y: number;
}

/** The clicks and typing positions of an analysis, as action points. */
export const actionPoints = (a: Pick<Analysis, "clicks" | "typing">): ActionPoint[] => [
  ...a.clicks.map((c) => ({ atMs: c.atMs, x: c.x, y: c.y })),
  ...a.typing.flatMap((t) =>
    t.x !== undefined && t.y !== undefined ? [{ atMs: t.startMs, x: t.x, y: t.y }] : [],
  ),
];

const step = (n: number) => Math.round(n * 20) / 20;

/**
 * How deep a portrait frame keeps the screen zoomed. At 1x a wide screen spans
 * the frame's width as a thin band; filling the frame's height would zoom by
 * capture/frame. Halfway between the two on a log scale (their geometric mean)
 * shows a stretch of screen about as tall as the frame is wide: 1.8x for a 16:9
 * screen in 9:16, 1.5x in 4:5. 1 when the frame is not portrait or the screen
 * is not wider than it.
 */
export function portraitZoom(captureRatio: number, frameRatio: number) {
  if (!(frameRatio < 1) || !(captureRatio > frameRatio)) return 1;
  return step(Math.sqrt(captureRatio / frameRatio));
}

/** Actions close in time (3s or less apart), which a follow zoom keeps in view together before panning on. */
export function actionGroups(points: ActionPoint[], gapMs = 3000) {
  const groups: ActionPoint[][] = [];
  for (const p of [...points].sort((a, b) => a.atMs - b.atMs)) {
    const last = groups.at(-1);
    if (last && p.atMs - last.at(-1)!.atMs <= gapMs) last.push(p);
    else groups.push([p]);
  }
  return groups;
}

/**
 * The deepest zoom, up to `max`, at which every group of actions close in time
 * fits in the frame with a margin, so no click leaves it. At zoom z a portrait
 * frame shows 1/z of the screen's width and capture/(frame*z) of its height (all
 * of it until that passes 1). Rounded down to 0.05, never under 1.
 */
export function actionSafeZoom(
  points: ActionPoint[],
  captureRatio: number,
  frameRatio: number,
  max: number,
  margin = 0.8,
) {
  let z = max;
  for (const group of actionGroups(points)) {
    if (group.length < 2) continue;
    const spread = (k: "x" | "y") =>
      Math.max(...group.map((p) => p[k])) - Math.min(...group.map((p) => p[k]));
    const sx = spread("x");
    const sy = spread("y");
    if (sx > 0) z = Math.min(z, margin / sx);
    if (sy > 0) z = Math.min(z, (margin * captureRatio) / (frameRatio * sy));
  }
  return Math.max(1, Math.floor(z * 20 + 1e-9) / 20);
}

/** A stretch between zooms shorter than this on screen joins the zoom before it instead of getting its own. */
const MIN_FILL_MS = 700;

/**
 * Zooms for a portrait copy that keep the screen filling the frame's width
 * instead of a thin band with empty backdrop above and below. Every stretch
 * between existing zooms gets a follow zoom at portraitZoom's level, the first
 * and last second of playback a little wider so the opening and ending show
 * where we are, and a shallower follow zoom is raised to that level. Deeper
 * zooms and fixed-target zooms stay as they are; disabled zooms (which render
 * at 1x) leave the copy, so the stretch under them is filled too. When the
 * screen is zoomed to fill, loupes become camera zooms of the same kind (a
 * follow loupe a follow zoom, kept within reach of its clicks). From
 * 1s before a group of nearby clicks to 1s after it, no level goes past where
 * the group would leave the frame (actionSafeZoom), and a stretch that cannot
 * be zoomed past 1.1x stays wide. Gaps under 0.7s on screen are closed by
 * stretching the zoom before them.
 */
export function portraitZooms(
  existing: Zoom[],
  slices: Slice[],
  o: { captureRatio: number; frameRatio: number; points?: ActionPoint[] },
) {
  const level = portraitZoom(o.captureRatio, o.frameRatio);
  const wide = step(1 + (level - 1) * 0.7);
  const out = {
    zooms: existing.map((z) => ({ ...z })).sort((a, b) => a.sourceStartMs - b.sourceStartMs),
    level,
    wide,
    added: 0,
    raised: 0,
    capped: 0,
    deeper: 0,
    loupesConverted: 0,
    /** Disabled zooms left out of the copy. */
    disabledDropped: 0,
    /** Stretches between zooms that stay at 1x, and how long they play. */
    leftWide: 0,
    leftWideMs: 0,
    /** Whether the opening and ending seconds got their wider zoom. */
    openingWide: false,
    endingWide: false,
  };
  if (level <= 1 || !slices.length) return out;
  // A loupe over a screen that fills a third of a phone reads poorly: in portrait, it becomes a
  // camera zoom of the same kind on the same target, at least as deep as the fill level.
  const converted = new Set<Zoom>();
  const zooms: Zoom[] = out.zooms
    .filter((z) => !z.isDisabled || (out.disabledDropped++, false))
    .map((z) => {
      if (z.presentation !== "loupe") return z;
      const c = {
        ...z,
        presentation: "screen",
        type: z.type ?? "manual",
        zoom: Math.max(z.zoom, level),
      } as Zoom;
      converted.add(c);
      return c;
    });
  out.zooms = zooms;
  out.loupesConverted = converted.size;
  const from = slices[0].sourceStartMs;
  const to = slices.at(-1)!.sourceEndMs;
  const duration = playbackDuration(slices);
  const visible = (a: number, b: number) => (b > a ? (playbackRange(slices, a, b)?.visibleMs ?? 0) : 0);
  const safe = (a: number, b: number, max: number) =>
    actionSafeZoom(
      (o.points ?? []).filter((p) => p.atMs >= a - 500 && p.atMs <= b + 500),
      o.captureRatio,
      o.frameRatio,
      max,
    );
  const camera = (z: Zoom) => !z.isDisabled && (z.presentation ?? "screen") === "screen";
  for (const z of zooms) {
    if (!camera(z)) continue;
    // A converted follow loupe pans between its clicks: keep them in the frame.
    if (converted.has(z)) {
      if (z.type !== "manual") z.zoom = safe(z.sourceStartMs, z.sourceEndMs, z.zoom);
      continue;
    }
    if (z.zoom >= level) out.deeper++;
    else if (z.type !== "manual") {
      const raised = safe(z.sourceStartMs, z.sourceEndMs, level);
      if (raised > z.zoom) {
        z.zoom = raised;
        out.raised++;
      }
    }
  }
  // Close the slivers between zooms: the zoom before stretches over them (the one after, at the start).
  for (let i = 0; i <= zooms.length; i++) {
    const prev = zooms[i - 1];
    const next = zooms[i];
    const a = prev ? prev.sourceEndMs : from;
    const b = next ? next.sourceStartMs : to;
    if (b <= a || visible(a, b) >= MIN_FILL_MS) continue;
    if (prev) prev.sourceEndMs = b;
    else if (next) next.sourceStartMs = a;
  }
  const openEnd = toSource(slices, Math.min(1000, duration / 2));
  const closeStart = toSource(slices, Math.max(duration - 1000, duration / 2));
  const taken = zooms.map((z) => ({ startMs: z.sourceStartMs, endMs: z.sourceEndMs }));
  const added: Zoom[] = [];
  // Where a group of nearby actions needs a shallower zoom, from 1s before it to 1s after.
  const limits = actionGroups(o.points ?? []).flatMap((g) => {
    const zoom = actionSafeZoom(g, o.captureRatio, o.frameRatio, level);
    return zoom < level ? [{ startMs: g[0].atMs - 1000, endMs: g.at(-1)!.atMs + 1000, zoom }] : [];
  });
  type Piece = Span & { zoom: number; max: number };
  for (const gap of subtractSpans([{ startMs: from, endMs: to }], taken)) {
    if (!visible(gap.startMs, gap.endMs)) continue;
    const cuts = [openEnd, closeStart, ...limits.flatMap((l) => [l.startMs, l.endMs])].filter(
      (t) => t > gap.startMs && t < gap.endMs,
    );
    const bounds = [...new Set([gap.startMs, ...cuts, gap.endMs])].sort((a, b) => a - b);
    let pieces: Piece[] = bounds.slice(1).map((endMs, i) => {
      const startMs = bounds[i];
      const max = endMs <= openEnd || startMs >= closeStart ? wide : level;
      const zoom = Math.min(
        max,
        ...limits.filter((l) => l.startMs < endMs && l.endMs > startMs).map((l) => l.zoom),
      );
      return { startMs, endMs, zoom, max };
    });
    // Neighbours at the same level are one zoom; a sliver joins its neighbour at the shallower level of the two.
    const join = (x: Piece, y: Piece): Piece => ({
      startMs: x.startMs,
      endMs: y.endMs,
      zoom: Math.min(x.zoom, y.zoom),
      max: Math.min(x.max, y.max),
    });
    pieces = pieces.reduce<Piece[]>((acc, p) => {
      const last = acc.at(-1);
      if (last && last.zoom === p.zoom && last.max === p.max) acc[acc.length - 1] = join(last, p);
      else acc.push(p);
      return acc;
    }, []);
    for (let i = 0; i < pieces.length && pieces.length > 1; i++) {
      if (visible(pieces[i].startMs, pieces[i].endMs) >= MIN_FILL_MS) continue;
      if (i > 0) pieces.splice(i - 1, 2, join(pieces[i - 1], pieces[i]));
      else pieces.splice(0, 2, join(pieces[0], pieces[1]));
      i = Math.max(-1, i - 2);
    }
    for (const p of pieces) {
      if (p.zoom < 1.1) {
        out.leftWide++;
        out.leftWideMs += visible(p.startMs, p.endMs);
        continue;
      }
      if (p.zoom < p.max) out.capped++;
      if (p.max === wide && p.endMs <= openEnd) out.openingWide = true;
      if (p.max === wide && p.startMs >= closeStart) out.endingWide = true;
      // Edges on an existing zoom keep its exact time, so the two never overlap.
      const edge = (t: number) => (t === gap.startMs || t === gap.endMs ? t : round(t));
      added.push({
        id: randomUUID(),
        sourceStartMs: edge(p.startMs),
        sourceEndMs: edge(p.endMs),
        zoom: p.zoom,
        type: "follow-click-groups",
        manualTargetPoint: { x: 0.5, y: 0.5 },
        isDisabled: false,
        hasInstantAnimation: false,
        presentation: "screen",
        loupeOptions: LOUPE_DEFAULTS,
      } as Zoom);
    }
  }
  out.added = added.length;
  out.zooms = [...zooms, ...added].sort((a, b) => a.sourceStartMs - b.sourceStartMs);
  return out;
}

/**
 * One target's copy of the project: settings patched, action zooms added for
 * vertical frames, and refused when Screen Studio would crop every wide shot.
 */
export function variantProject(
  project: any,
  name: string,
  target: Target,
  o: {
    verticalZooms?: PlannedZoom[];
    capture?: { widthPt: number; heightPt: number };
    /** Clicks and typing, so a portrait copy's zooms never push them out of the frame. */
    points?: ActionPoint[];
  } = {},
) {
  const clone = structuredClone(project);
  const notes: string[] = [target.why];
  const { changes, skipped } = targetChanges(target, clone.config);
  applyPartial(clone.config, configPartial(clone.config, changes));
  if (skipped.length) notes.push(`This project has no ${skipped.join(", ")} setting, so it kept its own.`);
  const scene = clone.scenes[0];
  const frameRatio = ASPECTS[target.aspect] as number;
  // The screen's own shape, honoring the project's crop. A capture that already
  // fills the frame (a phone screen in 9:16) needs no zooms to look big.
  const shape = captureRatio(o.capture, clone.config?.crop?.rect01);
  const fillsFrame = shape !== undefined && portraitZoom(shape, frameRatio) <= 1;
  if (target.zoomForAction && fillsFrame)
    notes.push(`No extra zooms: the recording already fills the ${target.aspect} frame.`);
  else if (target.zoomForAction && o.verticalZooms) {
    const added = actionZooms(o.verticalZooms, scene.slices, scene.zooms ?? []);
    scene.zooms = [...(scene.zooms ?? []), ...added].sort(
      (a: Zoom, b: Zoom) => a.sourceStartMs - b.sourceStartMs,
    );
    notes.push(
      added.length
        ? `Added ${added.length} fixed zoom${added.length > 1 ? "s" : ""} (${added.map((z) => `${z.zoom}x`).join(", ")}) on the main actions, because the screen is small in a ${target.aspect} frame.`
        : `No extra zooms: the existing zooms already cover the actions, or none stays on screen long enough.`,
    );
  } else if (target.zoomForAction)
    notes.push("No extra zooms: the footage has not been analysed, so the actions are unknown.");
  // Fill zooms need the screen's shape: with an unknown size they would guess.
  if (frameRatio < 1 && shape === undefined)
    notes.push(
      `Added no zooms to fill the ${target.aspect} frame: the recording's size is unknown, so how much empty backdrop it leaves is too.`,
    );
  if (frameRatio < 1 && shape !== undefined && !fillsFrame) {
    const fill = portraitZooms(scene.zooms ?? [], scene.slices, {
      captureRatio: shape,
      frameRatio,
      points: o.points,
    });
    scene.zooms = fill.zooms;
    const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
    if (fill.level > 1) {
      const ends = [fill.openingWide && "first", fill.endingWide && "last"].filter(Boolean);
      const parts = [
        ends.length
          ? `the ${ends.join(" and ")} second${ends.length > 1 ? "s sit" : " sits"} at ${fill.wide}x to show where we are`
          : "",
        fill.deeper
          ? `${n(fill.deeper, "deeper zoom")} kept as ${fill.deeper === 1 ? "it is" : "they are"}`
          : "",
        fill.capped
          ? `${n(fill.capped, "stretch", "stretches")} zoom${fill.capped === 1 ? "s" : ""} less, so clicks close together stay in the frame`
          : "",
        fill.leftWide
          ? `${n(fill.leftWide, "stretch", "stretches")} (${secs(fill.leftWideMs)}) stay${fill.leftWide === 1 ? "s" : ""} wide at 1x, since clicks there sit too far apart to zoom without losing one`
          : "",
        fill.loupesConverted
          ? `${n(fill.loupesConverted, "loupe")} became camera zoom${fill.loupesConverted === 1 ? "" : "s"} on the same target, since a lens over a small screen reads poorly on a phone`
          : "",
        fill.disabledDropped
          ? `${n(fill.disabledDropped, "switched-off zoom")} left out of this copy, so the stretch under ${fill.disabledDropped === 1 ? "it" : "them"} is filled too`
          : "",
      ].filter(Boolean);
      notes.push(
        `${fill.added ? `Kept the screen at ${fill.level}x between zooms (${n(fill.added, "follow zoom")} added${fill.raised ? `, ${n(fill.raised, "shallower zoom")} raised` : ""})` : `Added no follow zooms between zooms${fill.raised ? ` (${n(fill.raised, "shallower zoom")} raised to ${fill.level}x)` : ""}`}, so the screen fills the ${target.aspect} frame's width instead of a thin band with empty backdrop above and below${parts.length ? `. ${parts.map((x, i) => (i ? x : x[0].toUpperCase() + x.slice(1))).join("; ")}` : ""}.`,
      );
    }
  }
  // Avoid-empty-zoom-area crops every wide shot when the frame's aspect differs
  // from the capture's (or when the capture is unknown). The copy turns it off and
  // says so; the editor keeps the person's own setting.
  const crop = checkStyle(clone.config, scene.zooms, o.capture).find((i) => i.code === "fill-crop");
  if (crop && clone.config?.output) {
    clone.config.output.avoidEmptyZoomArea = false;
    notes.push(
      o.capture
        ? `Turned off avoid-empty-zoom-area for this copy: in a ${target.aspect} frame it would crop every wide shot. The editor keeps its own setting.`
        : `Turned off avoid-empty-zoom-area for this copy, since the capture size is unknown and it could crop every wide shot in a ${target.aspect} frame. The editor keeps its own setting.`,
    );
  }
  const still = crop && checkStyle(clone.config, scene.zooms, o.capture).find((i) => i.code === "fill-crop");
  return {
    project: clone,
    notes,
    refused: still
      ? `${name}: ${still.message} Set it in the editor, then export this target again.`
      : undefined,
  };
}

// ---------------------------------------------------------------- media checks

export interface Media {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  bytes: number;
}

/** Duration, size and frame rate from ffprobe output. */
export function mediaSummary(p: any, bytes?: number): Media {
  const v = (p?.streams ?? []).find((s: any) => s.width && s.height) ?? {};
  const [n, d] = String(v.avg_frame_rate ?? "0/1")
    .split("/")
    .map(Number);
  return {
    durationMs: round(Number(p?.format?.duration ?? 0) * 1000),
    width: Number(v.width ?? 0),
    height: Number(v.height ?? 0),
    fps: d > 0 ? Math.round((n / d) * 100) / 100 : 0,
    bytes: bytes ?? Number(p?.format?.size ?? 0),
  };
}

/** Plain-English checks of a file against its target's limits; ok:false means it will not post as is. */
export function limitChecks(name: string, target: Target, m: Media) {
  const checks: { check: string; ok: boolean; message: string }[] = [];
  if (target.maxMs !== undefined)
    checks.push({
      check: "duration",
      ok: m.durationMs <= target.maxMs,
      message:
        m.durationMs <= target.maxMs
          ? `${clock(m.durationMs)} fits ${name}'s ${clock(target.maxMs)} limit.`
          : `${clock(m.durationMs)} is over ${name}'s ${clock(target.maxMs)} limit; trim the edit or use a longer-form target.`,
    });
  if (target.maxBytes !== undefined)
    checks.push({
      check: "size",
      ok: m.bytes <= target.maxBytes,
      message: `${(m.bytes / 1e6).toFixed(1)} MB against a ${(target.maxBytes / 1e6).toFixed(0)} MB budget.`,
    });
  const short = Math.min(m.width, m.height);
  // Target heights are the short side of the frame, whatever the aspect. A
  // couple of pixels either way is the encoder rounding to even sides.
  const want = frameSize(target.aspect, target.height);
  const off = (got: number, wanted: number) => Math.abs(got - wanted) > 4;
  if (target.format === "mp4" && short && (off(m.width, want.width) || off(m.height, want.height)))
    checks.push({
      check: "resolution",
      ok: false,
      message: `Rendered ${m.width}x${m.height}; ${name} wants ${want.width}x${want.height} (${target.height}px on the short side). ${short < even(target.height) ? "The export was asked for the wrong height for this aspect." : "The frame is larger than the target asks for, so the file is bigger than it needs to be."}`,
    });
  const [w, h] = target.aspect.split(":").map(Number);
  if (m.width && m.height && Math.abs(m.width / m.height - w / h) > 0.02)
    checks.push({
      check: "aspect",
      ok: false,
      message: `Rendered ${m.width}x${m.height}, not ${target.aspect}.`,
    });
  return checks;
}

/**
 * Finds GIF settings under a size budget: starts at 20fps and the target height,
 * then halves the frame rate and the height in turn, stepping to the floor
 * (8fps, 160px) when a halving would cross it, until a conversion fits. Returns
 * the smallest attempt when nothing fits, even at the floor.
 */
export async function fitGif(
  convert: (o: { fps: number; height: number }) => Promise<number>,
  maxBytes: number,
  start = { fps: 20, height: 480 },
  floor = { fps: 8, height: 160 },
) {
  const attempts: { fps: number; height: number; bytes: number }[] = [];
  let cur = { ...start };
  for (let turn = 0; ; turn++) {
    const bytes = await convert(cur);
    attempts.push({ ...cur, bytes });
    if (bytes <= maxBytes) return { ...cur, bytes, fits: true, attempts };
    const fps = Math.max(floor.fps, Math.floor(cur.fps / 2));
    const height = Math.max(floor.height, Math.round(cur.height / 4) * 2);
    const canFps = fps < cur.fps;
    const canHeight = height < cur.height;
    if (!canFps && !canHeight) return { ...cur, bytes, fits: false, attempts };
    cur = (turn % 2 === 0 ? canFps : !canHeight) ? { ...cur, fps } : { ...cur, height };
  }
}

// ---------------------------------------------------------------- captions and chapters

export interface TimedText {
  text: string;
  startMs: number;
  endMs: number;
}

/**
 * Words in playback time. A word that was cut away is dropped; one in a sped-up
 * clip shrinks with it; one cut partly keeps its visible part.
 */
export function playbackWords(words: TimedText[], slices: Slice[]): TimedText[] {
  const out: TimedText[] = [];
  for (const w of words) {
    const r = playbackRange(slices, w.startMs, w.endMs);
    if (r) out.push({ text: w.text, startMs: round(r.startMs), endMs: round(r.endMs) });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Groups words into caption cues: a new cue after a pause, a sentence end, 42 characters or 6 seconds. */
export function captionCues(words: TimedText[], o = { maxChars: 42, maxMs: 6000, gapMs: 700 }) {
  const cues: TimedText[] = [];
  let cur: TimedText | null = null;
  let closed = true;
  for (const w of words) {
    const text = w.text.trim();
    if (!text) continue;
    const joined = cur ? `${cur.text} ${text}` : text;
    if (
      cur &&
      !closed &&
      w.startMs - cur.endMs <= o.gapMs &&
      joined.length <= o.maxChars &&
      w.endMs - cur.startMs <= o.maxMs
    ) {
      cur.text = joined;
      cur.endMs = w.endMs;
    } else cues.push((cur = { text, startMs: w.startMs, endMs: w.endMs }));
    closed = /[.!?]["')\]]?$/.test(text);
  }
  // A cue stays up at least 700ms, never into the next one.
  cues.forEach((c, i) => {
    const next = cues[i + 1]?.startMs ?? Infinity;
    c.endMs = Math.min(Math.max(c.endMs, c.startMs + 700), next);
  });
  return cues;
}

const stamp = (ms: number, sep: "," | ".") => {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor(t / 60000) % 60;
  const s = Math.floor(t / 1000) % 60;
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(t % 1000, 3)}`;
};

export const toSrt = (cues: TimedText[]) =>
  cues.map((c, i) => `${i + 1}\n${stamp(c.startMs, ",")} --> ${stamp(c.endMs, ",")}\n${c.text}\n`).join("\n");

/** Cue text WebVTT can carry: & and < escaped, no arrow that would end the cue, one line. */
export const vttText = (text: string) =>
  text
    .replace(/-->/g, "→")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\r\n]+/g, " ");

export const toVtt = (cues: TimedText[]) =>
  `WEBVTT\n\n${cues.map((c) => `${stamp(c.startMs, ".")} --> ${stamp(c.endMs, ".")}\n${vttText(c.text)}\n`).join("\n")}`;

export interface Beat {
  sourceStartMs: number;
  sourceEndMs: number;
  actions?: string[];
  role?: string;
  label?: string;
}

/** A short chapter title from a beat: its own label, its first spoken words, or what happens in it. */
export function beatLabel(b: Beat) {
  if (b.label) return b.label;
  const said = b.actions?.map((a) => /^says "(.*)"$/.exec(a)?.[1]).find(Boolean);
  if (said) return said.length > 40 ? `${said.slice(0, 39).trimEnd()}…` : said;
  const kinds = new Set((b.actions ?? []).map((a) => a.split(" ")[0]));
  const typing = kinds.has("typing");
  const clicks = kinds.has("click") || kinds.has("drag");
  return typing && clicks ? "Clicks and typing" : typing ? "Typing" : clicks ? "Clicks" : "Shortcuts";
}

/**
 * Chapters in playback time ("0:00 Start"), one per beat, from the beats with a
 * demo or payoff role when any beat has a role. The first starts at 0:00 and
 * each runs at least `minMs` (YouTube's rule), so close beats share a chapter.
 */
export function chapters(beats: Beat[], slices: Slice[], minMs = 10000) {
  const duration = playbackDuration(slices);
  const roled = beats.some((b) => b.role);
  const picked = roled ? beats.filter((b) => b.role === "demo" || b.role === "payoff") : beats;
  const out: { playbackMs: number; label: string }[] = [];
  for (const b of picked) {
    const at = round(toPlaybackNearest(slices, b.sourceStartMs));
    const label = beatLabel(b);
    if (!out.length) {
      out.push({ playbackMs: 0, label: at < minMs ? label : "Start" });
      if (at < minMs) continue;
    }
    if (at - out.at(-1)!.playbackMs >= minMs && duration - at >= minMs) out.push({ playbackMs: at, label });
  }
  return out;
}

export const chapterLines = (list: { playbackMs: number; label: string }[]) =>
  list
    .map((c) => {
      const s = Math.floor(c.playbackMs / 1000);
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} ${c.label.replace(/[\r\n]+/g, " ").trim()}`;
    })
    .join("\n") + "\n";

/**
 * Chapters someone wrote, made valid for YouTube: in order, the first at 0:00,
 * each at least 10s after the one before. Says what it changed.
 */
export function tidyChapters(list: { playbackMs: number; label: string }[], minMs = 10000) {
  const notes: string[] = [];
  const sorted = [...list].sort((x, y) => x.playbackMs - y.playbackMs);
  if (sorted.some((c, i) => c !== list[i])) notes.push("Chapters were put in time order.");
  const out: { playbackMs: number; label: string }[] = [];
  for (const c of sorted) {
    const label = c.label.replace(/[\r\n]+/g, " ").trim();
    if (!out.length && c.playbackMs > 0) {
      notes.push(`The first chapter, "${label}", moved to 0:00; YouTube needs one there.`);
      out.push({ playbackMs: 0, label });
      continue;
    }
    if (out.length && c.playbackMs - out.at(-1)!.playbackMs < minMs) {
      notes.push(`Left out "${label}": it starts under ${minMs / 1000}s after the chapter before it.`);
      continue;
    }
    out.push({ playbackMs: c.playbackMs, label });
  }
  return { chapters: out, notes };
}

/** Playback time of the payoff: the result of the beat marked payoff (else the last beat) settling. */
export function payoffMs(beats: Beat[], slices: Slice[]) {
  const duration = playbackDuration(slices);
  const beat = beats.find((b) => b.role === "payoff") ?? beats.at(-1);
  if (!beat) return round(Math.max(0, duration - 1500));
  return round(Math.max(0, Math.min(duration - 300, toPlaybackNearest(slices, beat.sourceEndMs) + 600)));
}

// ---------------------------------------------------------------- files

/** `${stem}.${ext}` in dir, or the first `${stem}-N.${ext}` that does not exist yet. */
export async function freePath(dir: string, stem: string, ext: string) {
  for (let n = 1; n < 1000; n++) {
    const p = join(dir, `${stem}${n > 1 ? `-${n}` : ""}.${ext}`);
    try {
      await access(p);
    } catch (e: any) {
      if (e.code === "ENOENT") return p;
      throw e;
    }
  }
  throw new Error(`Too many files named ${stem} in ${dir}.`);
}

async function writeNew(dir: string, stem: string, ext: string, data: string | Buffer) {
  const p = await freePath(dir, stem, ext);
  await writeFile(p, data, { flag: "wx" });
  return p;
}

async function copyNew(src: string, dir: string, stem: string, ext: string) {
  const p = await freePath(dir, stem, ext);
  await copyFile(src, p, constants.COPYFILE_EXCL);
  return p;
}

async function outputFolder(dir: string) {
  if (!isAbsolute(dir)) throw new Error("outputDir must be an absolute path.");
  const d = resolve(dir);
  if (!(await stat(d).catch(() => null))?.isDirectory())
    throw new Error(`Output folder ${d} does not exist.`);
  await access(d, constants.W_OK).catch(() => {
    throw new Error(`Output folder ${d} is not writable.`);
  });
  return d;
}

/**
 * A file-name stem: the given base name, checked strictly, or one made from the
 * project's name (with `suffix`), where characters a base name may not hold
 * become hyphens and the length is trimmed.
 */
export function baseNameFor(projectPath: string, given?: string, suffix = "") {
  if (given === undefined) {
    const stem = `${basename(projectPath, ".screenstudio")}`
      .replace(/[/\\:'"\n\r]+/g, "-")
      .replace(/^[.\s-]+/, "")
      .trim()
      .slice(0, 80 - suffix.length)
      .trim();
    return `${stem || "video"}${suffix}`;
  }
  const name = given.trim();
  if (!name || name.length > 80 || /[/\\:'"\n\r]/.test(name) || name.startsWith("."))
    throw new Error("baseName must be 1-80 characters without slashes, colons, quotes or a leading dot.");
  return name;
}

/**
 * Narration caption words (playback time) saved with the project's narration,
 * and how they are shown: "screen-studio" when the app renders them as its own
 * captions (they are then in the transcript already), "burn-in" when they must
 * be burned into each video.
 */
export async function narrationCues(
  stateDir: string,
  projectPath: string,
): Promise<{ cues: TimedText[]; mode: string | null }> {
  try {
    const saved = JSON.parse(
      await readFile(join(stateDir, `narration-${shortHash(projectPath)}.json`), "utf8"),
    );
    const cues = (Array.isArray(saved.cues) ? saved.cues : []).filter(
      (c: any) => typeof c?.text === "string" && c.endMs > c.startMs,
    );
    return { cues, mode: typeof saved.captionsMode === "string" ? saved.captionsMode : null };
  } catch {
    return { cues: [], mode: null };
  }
}

// ---------------------------------------------------------------- variants

export interface VariantsRequest {
  targets: TargetName[];
  outputDir: string;
  baseName?: string;
  kit?: boolean;
  /** Chapter titles to use instead of the ones derived from the beats. */
  chapters?: { playbackMs: number; label: string }[];
  /** Target settings to use instead of the built-in ones (a recipe's export spec, from targetsForSpec). */
  specs?: Partial<Record<TargetName, Target>>;
}
export interface VariantsInput {
  /** The recording analysis, for action zooms, chapters and the poster moment. */
  analysis?: Analysis;
  /** Spoken words in source time, for the caption files. */
  words?: TimedText[];
  style?: Style;
  renderTimeoutMs?: number;
  /** Cancels the render in progress and skips the targets after it. */
  signal?: AbortSignal;
  /** Hears each step: done so far, the total, and what is happening now. */
  progress?: (done: number, total: number, message: string) => void;
}

type Variant = {
  target: TargetName;
  status: string;
  file?: string;
  jobId?: string;
  aspect: string;
  media?: Media;
  checks?: ReturnType<typeof limitChecks>;
  gif?: { fps: number; height: number; fits: boolean; attempts: number };
  /** A copy with the narration's captions burned in, when the narration needs burn-in. */
  captioned?: string;
  notes: string[];
  error?: string;
};

/** Batches running now, by project and output folder: a second one for the same pair is refused. */
const running = new Set<string>();

/**
 * Renders the open project once per target, one after another, each from its own
 * copy of the live project data, then writes the delivery kit next to them.
 * `progress` hears about each step, so a caller can keep its client waiting.
 */
export async function exportVariants(
  studio: Studio,
  editor: Editor,
  projectPath: string,
  req: VariantsRequest,
  input: VariantsInput = {},
) {
  const path = await studio.path(projectPath);
  const dir = await outputFolder(req.outputDir);
  const key = `${path}\n${dir}`;
  if (running.has(key))
    throw new Error(
      "Variants of this project are already rendering into that folder. Wait for that call to finish, or choose another outputDir.",
    );
  running.add(key);
  try {
    return await renderVariants(studio, editor, path, dir, req, input);
  } finally {
    running.delete(key);
  }
}

async function renderVariants(
  studio: Studio,
  editor: Editor,
  path: string,
  dir: string,
  req: VariantsRequest,
  input: VariantsInput,
) {
  const base = baseNameFor(path, req.baseName);
  const live = await editor.liveProject(path);
  const project = live ?? (await studio.readProject(path)).project;
  const source = live ? "live" : "disk";
  const slices: Slice[] = project.scenes[0].slices;
  const notes: string[] = [];
  const warnings: string[] = [];
  const progress = input.progress ?? (() => {});
  if (!live)
    warnings.push(
      "No open editor has this project, so the saved project is rendered; unsaved edits are not included.",
    );

  const a = input.analysis;
  // The screen's size: the analysis's capture, else the recording's own bounds (as exportFrame reads them).
  const capture =
    a?.capture ??
    (await readRecordingMeta(path)
      .then((m) => m.sessions[0]?.bounds)
      .then((b) => (b ? { widthPt: b.width, heightPt: b.height } : undefined))
      .catch(() => undefined));
  const plan: Plan | null = a ? planEdit(a, { style: input.style }) : null;
  const targets = [...new Set(req.targets)];
  const vertical =
    a && targets.some((t) => (req.specs?.[t] ?? (TARGETS[t] as Target)).zoomForAction)
      ? planEdit(a, { style: input.style, rules: VERTICAL_RULES }).zooms
      : undefined;
  const narration = await narrationCues(studio.stateDir, path);
  const burn = narration.mode === "burn-in" && narration.cues.length > 0;
  const steps = targets.length + 1;

  const variants: Variant[] = [];
  for (const [index, name] of targets.entries()) {
    if (input.signal?.aborted) {
      warnings.push(`Cancelled before ${targets.slice(index).join(", ")}.`);
      break;
    }
    const target: Target = req.specs?.[name] ?? TARGETS[name];
    const v: Variant = { target: name, status: "starting", aspect: target.aspect, notes: [] };
    variants.push(v);
    progress(index, steps, `Rendering ${name} (${target.aspect}, ${index + 1} of ${targets.length})`);
    let render: string | null = null;
    let jobId: string | null = null;
    try {
      const built = variantProject(project, name, target, {
        verticalZooms: vertical,
        capture,
        points: a && actionPoints(a),
      });
      v.notes = built.notes;
      if (built.refused) {
        v.status = "refused";
        v.error = built.refused;
        continue;
      }
      const ext = target.format;
      const final = await freePath(dir, `${base}-${name}`, ext);
      render = ext === "gif" ? await studio.statePath(`variant-${randomUUID()}.mp4`) : final;
      const job = await studio.startRender(
        path,
        render,
        {
          height: renderHeight(target.aspect, target.height),
          fps: target.fps,
          format: "mp4",
          quality: "studio",
        },
        built.project,
        source,
      );
      jobId = job.jobId;
      let done;
      try {
        done = await studio.waitForExport(job.jobId, {
          timeoutMs: input.renderTimeoutMs,
          signal: input.signal,
        });
      } catch (e) {
        // Never leave a render running under the next one.
        await studio.exportCancel(job.jobId).catch(() => {});
        if (input.signal?.aborted) throw new Error("Cancelled; the render in progress was stopped.");
        throw new Error(
          ext === "gif"
            ? `The render for the GIF did not finish in time and was cancelled; run this target again (a longer renderTimeoutMs, or a shorter edit).`
            : `The render did not finish in time and was cancelled (${e instanceof Error ? e.message.split(". ")[0] : String(e)}); run this target again with a longer renderTimeoutMs.`,
        );
      }
      v.status = done.status;
      if (done.status !== "completed") {
        v.error = done.error ?? `Render ended as ${done.status}.`;
        continue;
      }
      if (ext === "gif") {
        const tmp = await studio.statePath(`variant-${randomUUID()}.gif`);
        try {
          const fit = await fitGif(
            async (o) => {
              await toGif(render!, tmp, o);
              return (await stat(tmp)).size;
            },
            target.maxBytes!,
            { fps: 20, height: target.height },
          );
          // The chosen settings are always the last attempt, so the file on disk is the one to keep.
          v.file = await copyNew(tmp, dir, `${base}-${name}`, "gif");
          v.gif = { fps: fit.fps, height: fit.height, fits: fit.fits, attempts: fit.attempts.length };
          v.notes.push(
            fit.fits
              ? `GIF at ${fit.fps}fps and ${fit.height}px tall fits the ${(target.maxBytes! / 1e6).toFixed(0)} MB budget${fit.attempts.length > 1 ? ` after ${fit.attempts.length} tries` : ""}.`
              : `GIF is ${(fit.bytes / 1e6).toFixed(1)} MB even at ${fit.fps}fps and ${fit.height}px; shorten the clip (screenstudio_loop makes a short one).`,
          );
        } finally {
          await rm(tmp, { force: true }).catch(() => {});
        }
      } else {
        v.file = done.outputPath;
        v.jobId = job.jobId;
      }
      v.media = mediaSummary(await probe(v.file!), (await stat(v.file!)).size);
      v.checks = limitChecks(name, target, v.media);
      for (const c of v.checks.filter((c) => !c.ok)) warnings.push(`${name}: ${c.message}`);
      if (burn && ext !== "gif")
        try {
          v.captioned = await burnNarration(
            studio,
            dir,
            `${base}-${name}-captioned`,
            v.file!,
            narration.cues,
            {
              ...project.config?.captions,
              ...(target.captions ?? {}),
              aspect: (ASPECTS[target.aspect] as number) ?? 16 / 9,
            },
          );
          v.notes.push(
            `Narration captions burned into ${basename(v.captioned)}, sized for the ${target.aspect} frame.`,
          );
        } catch (e) {
          warnings.push(
            `${name}: narration captions were not burned in: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`,
          );
        }
    } catch (e) {
      v.status = "failed";
      v.error = e instanceof Error ? e.message : String(e);
      if (jobId && !v.jobId) v.jobId = jobId;
    } finally {
      if (render && target.format === "gif") await rm(render, { force: true }).catch(() => {});
    }
  }

  const done = variants.filter((v) => v.status === "completed" && v.file);
  const kit: Record<string, unknown> = {};
  let sheet: { path: string; data: Buffer } | null = null;
  /** A kit file that fails to write is a warning; the renders are already on disk. */
  const tryWrite = async (what: string, write: () => Promise<string>) => {
    try {
      return await write();
    } catch (e) {
      warnings.push(`No ${what}: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  };
  if (req.kit !== false && done.length) {
    progress(targets.length, steps, "Writing the delivery kit");
    const beats: Beat[] = plan?.beats ?? [];
    const poster = payoffMs(beats, slices);
    // One poster per aspect, at the payoff, from the first rendered video of that aspect.
    const posters: string[] = [];
    for (const aspect of [...new Set(done.map((v) => v.aspect))]) {
      const v = done.find((x) => x.aspect === aspect && x.jobId) ?? done.find((x) => x.aspect === aspect)!;
      try {
        const frame = await videoFrame(studio, v.file!, poster);
        try {
          posters.push(await copyNew(frame, dir, `${base}-${aspect.replace(":", "x")}-poster`, "png"));
        } finally {
          await rm(frame, { force: true }).catch(() => {});
        }
      } catch (e) {
        warnings.push(`No ${aspect} poster: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    kit.posters = posters;
    notes.push(
      beats.length
        ? `Posters show ${clock(poster)}, where the ${beats.some((b) => b.role === "payoff") ? "payoff" : "last"} beat's result has settled.`
        : `Posters show ${clock(poster)}, 1.5s before the end, since the footage has not been analysed.`,
    );

    // Narration the app renders as its own captions is in the transcript already.
    const voiced = narration.mode === "screen-studio" ? [] : narration.cues;
    const cues = captionCues(
      [...playbackWords(input.words ?? [], slices), ...voiced].sort((x, y) => x.startMs - y.startMs),
    );
    if (cues.length) {
      kit.srt = await tryWrite("captions file (.srt)", () => writeNew(dir, base, "srt", toSrt(cues)));
      kit.vtt = await tryWrite("captions file (.vtt)", () => writeNew(dir, base, "vtt", toVtt(cues)));
      notes.push(
        `Captions: ${cues.length} cues in playback time${voiced.length ? ", with the narration" : ""}, for players and uploads that take a captions file.`,
      );
    } else notes.push("No captions file: the project has no transcript or narration cues.");
    if (burn && done.some((v) => v.captioned))
      notes.push(
        "The narration's captions were burned into a -captioned copy of each video; the plain files stay for players that take a captions file.",
      );

    let list = req.chapters?.length ? req.chapters : chapters(beats, slices);
    if (req.chapters?.length) {
      const tidy = tidyChapters(req.chapters);
      list = tidy.chapters;
      notes.push(...tidy.notes);
    }
    if (list.length >= 2) {
      kit.chapters = await tryWrite("chapters file", () =>
        writeNew(dir, `${base}-chapters`, "txt", chapterLines(list)),
      );
      if (!req.chapters?.length)
        notes.push("Chapter titles come from the beats; pass chapters with real titles for YouTube or docs.");
    }

    try {
      const s = await contactSheetFromFile(
        studio,
        done.map((v) => ({ path: v.file!, label: v.target })),
      );
      sheet = s;
      kit.sheet = await copyNew(s.path, dir, `${base}-sheet`, "png");
      notes.push(...s.notes);
    } catch (e) {
      warnings.push(`No contact sheet: ${e instanceof Error ? e.message : String(e)}`);
    }

    const rel = (p: unknown) => (typeof p === "string" ? basename(p) : p);
    kit.manifest = await tryWrite("manifest", () =>
      writeNew(
        dir,
        `${base}-manifest`,
        "json",
        JSON.stringify(
          {
            project: basename(path, ".screenstudio"),
            createdAt: new Date().toISOString(),
            source,
            playbackMs: round(playbackDuration(slices)),
            variants: variants.map((v) => ({
              target: v.target,
              status: v.status,
              file: rel(v.file),
              ...(v.captioned ? { captioned: rel(v.captioned) } : {}),
              aspect: v.aspect,
              ...v.media,
              checks: v.checks,
              error: v.error,
            })),
            posters: (kit.posters as string[]).map(rel),
            captions: kit.srt || kit.vtt ? { srt: rel(kit.srt) ?? null, vtt: rel(kit.vtt) ?? null } : null,
            chapters: kit.chapters ? list : null,
            sheet: rel(kit.sheet),
          },
          null,
          2,
        ) + "\n",
      ),
    );
  }
  progress(steps, steps, "Done");
  return {
    outputDir: dir,
    source,
    variants,
    kit,
    warnings,
    notes,
    sheet,
  };
}

/**
 * Burns narration captions into a copy of a rendered video: an ASS file styled
 * like the project's captions and sized for this video's frame, through ffmpeg's
 * subtitles filter. The original file is never touched.
 */
async function burnNarration(
  studio: Studio,
  dir: string,
  stem: string,
  video: string,
  words: TimedText[],
  style: CaptionStyle & { aspect: number },
) {
  if (!(await hasFilter("subtitles"))) throw new Error("this ffmpeg has no subtitles filter (libass)");
  const ass = await studio.statePath(`narration-${randomUUID()}.ass`);
  const tmp = await studio.statePath(`captioned-${randomUUID()}.mp4`);
  try {
    await writeFile(ass, buildAss(captionLines(words), words, style, assCanvas(style.aspect)));
    await burnSubtitles(video, ass, tmp);
    return await copyNew(tmp, dir, stem, "mp4");
  } finally {
    await rm(ass, { force: true }).catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------- loops

/** Similarity score (0-1) of the recording at two source times. */
export type FrameMatcher = (aMs: number, bMs: number) => Promise<number>;

export interface LoopPlan {
  seamless: boolean;
  ssim: number | null;
  sourceRange: Span;
  playbackMs: number;
  ops: EditOp[];
  notes: string[];
}

/** The parts of the planned slices inside [startMs, endMs]. */
export function clipSlices(slices: Plan["slices"], startMs: number, endMs: number) {
  return slices
    .map((s) => ({ startMs: Math.max(s.startMs, startMs), endMs: Math.min(s.endMs, endMs), speed: s.speed }))
    .filter((s) => s.endMs - s.startMs > 0);
}

const asSlices = (s: { startMs: number; endMs: number; speed: number }[]): Slice[] =>
  s.map((x) => ({ sourceStartMs: x.startMs, sourceEndMs: x.endMs, timeScale: 1 / x.speed }));

/** Settings for a loop: the cursor returns to where it started, and it plays silent. */
export const LOOP_CONFIG = {
  "cursor.loopPositionBeforeEndMs": 600,
  "audio.muteSystemAudio": true,
  "audio.muteMicrophone": true,
  "audio.muteBackgroundAudio": true,
  "output.avoidEmptyZoomArea": false,
};

/**
 * Picks a stretch of the recording that loops: it starts and ends on beat
 * boundaries whose frames match (SSIM 0.9 or more), so the last frame flows into
 * the first. Pairs are scored by similarity times how close they come to
 * targetMs; every distinct pair is compared, up to LOOP_CHECKS spread across
 * lengths (frames are read once per time, so this costs a frame per beat edge
 * plus one quick comparison per pair). Beats start and end in the pauses
 * between sentences. When no pair of beat edges matches, the rest of the
 * budget goes to windows inside a run of beats (one long beat, or a talk split
 * per sentence), cut at sentence breaks and still screens (loopEdges). With no
 * matching pair it takes whichever is closest to the target: a beat held on its
 * settled result toward the target, a run of beats, or a window, never longer
 * than maxMs. A pick whose frames match after all is seamless; otherwise the
 * notes say the join shows a jump.
 * Zooms inside the range end 800ms before the loop does, so the last frame is
 * wide like the first.
 */
export const LOOP_CHECKS = 200;

/**
 * Up to `cap` candidates to compare: all of them when they fit, else taken in
 * turn from each 2s band of length (closest to the target first within a band),
 * so a matching pair far from the target still gets checked.
 */
export function spreadByLength<C extends { len: number; fit: number }>(candidates: C[], cap: number): C[] {
  const sorted = [...candidates].sort((x, y) => y.fit - x.fit);
  if (sorted.length <= cap) return sorted;
  const bands = new Map<number, C[]>();
  for (const c of sorted) {
    const k = Math.round(c.len / 2000);
    const band = bands.get(k);
    if (band) band.push(c);
    else bands.set(k, [c]);
  }
  const queues = [...bands.values()];
  const out: C[] = [];
  for (let i = 0; out.length < cap; i++) {
    const before = out.length;
    for (const q of queues) if (q[i] && out.length < cap) out.push(q[i]);
    if (out.length === before) break;
  }
  return out.sort((x, y) => y.fit - x.fit);
}

/** A place a loop can start or end on, and how clean a cut it makes there (1 best). */
export interface LoopEdge {
  ms: number;
  kind: "beat" | "sentence" | "still" | "time";
  q: number;
}

type Spoken = Span & { text?: string };

const edgeWords = (e: LoopEdge) =>
  ({
    beat: "the beat's edge",
    sentence: "a sentence break",
    still: "a still screen",
    time: "the target length",
  })[e.kind];

/**
 * Sentence breaks in source ms: between the analysis's sentences when it has
 * them, else between spoken phrases and, inside a phrase, after each word that
 * ends a sentence (. ! ?), with the phrase's words taken as evenly spread.
 */
export function sentenceBreaks(a: { sentences?: Spoken[]; speech?: Spoken[] }) {
  const said = [...(a.sentences?.length ? a.sentences : (a.speech ?? []))].sort(
    (x, y) => x.startMs - y.startMs,
  );
  const out: number[] = [];
  said.forEach((p, i) => {
    const next = said[i + 1];
    if (i === 0) out.push(Math.max(0, p.startMs - 150));
    out.push(next ? (p.endMs + Math.max(p.endMs, next.startMs)) / 2 : p.endMs + 150);
    if (a.sentences?.length || !p.text) return;
    const words = p.text.trim().split(/\s+/);
    words.forEach((w, k) => {
      if (k < words.length - 1 && /[.!?]["')\]]?$/.test(w))
        out.push(p.startMs + ((k + 1) / words.length) * (p.endMs - p.startMs));
    });
  });
  return out.sort((x, y) => x - y);
}

/**
 * Places inside [startMs, endMs] where a loop can cut cleanly: sentence breaks,
 * and the still points of the screen (inside each quiet stretch between screen
 * activity, and the middle of each idle span). A still point in the middle of a
 * spoken phrase is a poorer cut than one in a pause.
 */
export function loopEdges(a: Analysis, startMs: number, endMs: number) {
  const inside = (t: number) => t > startMs + 300 && t < endMs - 300;
  const said: Span[] = a.sentences?.length ? a.sentences : (a.speech ?? []);
  const talking = (t: number) => said.some((p) => t > p.startMs && t < p.endMs);
  const edges: LoopEdge[] = sentenceBreaks(a)
    .filter(inside)
    .map((ms) => ({ ms, kind: "sentence", q: 1 }));
  const quiet = subtractSpans([{ startMs, endMs }], a.screen.active ?? [], 400);
  const still = [
    ...(a.screen.active?.length
      ? quiet.flatMap((q) => [q.startMs + 300, (q.startMs + q.endMs) / 2, q.endMs - 300])
      : []),
    ...a.idle.map((q) => (q.startMs + q.endMs) / 2),
  ];
  for (const ms of still) if (inside(ms)) edges.push({ ms, kind: "still", q: talking(ms) ? 0.6 : 0.9 });
  return edges.sort((x, y) => x.ms - y.ms);
}

export async function planLoop(
  a: Analysis,
  o: { targetMs?: number; minMs?: number; maxMs?: number; style?: Style },
  match: FrameMatcher,
): Promise<LoopPlan> {
  const targetMs = o.targetMs ?? 8000;
  const minMs = o.minMs ?? 4000;
  const maxMs = o.maxMs ?? 15000;
  const plan = planEdit(a, { style: o.style });
  const R = STYLES[plan.style];
  const tail = plan.slices.at(-1)?.endMs ?? a.sourceDurationMs;
  if (!plan.beats.length) throw new Error("The recording has no actions to loop. Record a short demo first.");
  // Beats start and end in the pauses between sentences: a lead-in or hold that
  // would land inside a sentence (or cut into the next one's first word) moves to
  // the sentence break instead.
  const breaks = sentenceBreaks(a);
  const said: Span[] = a.sentences?.length ? a.sentences : (a.speech ?? []);
  const inSentence = (t: number) => said.some((p) => t > p.startMs && t < p.endMs);
  const starts = plan.beats.map((b) => {
    const soft = Math.max(0, b.sourceStartMs - R.leadInMs);
    if (!inSentence(soft)) return soft;
    return breaks.find((t) => t >= soft && t <= b.sourceStartMs) ?? soft;
  });
  const ends = plan.beats.map((b, i) => {
    const next = plan.beats[i + 1]?.sourceStartMs ?? Infinity;
    const hard = Math.min(tail, b.sourceEndMs + R.holdAfterMs, next - 200);
    if (hard >= b.sourceEndMs && !inSentence(hard)) return hard;
    const limit = Math.min(tail, b.sourceEndMs + R.holdAfterMs, next);
    return breaks.filter((t) => t >= b.sourceEndMs && t <= limit).at(-1) ?? hard;
  });
  type Candidate = {
    slices: ReturnType<typeof clipSlices>;
    len: number;
    fit: number;
    first: number;
    last: number;
    /** For a window inside a beat: what it starts and ends on. */
    from?: LoopEdge;
    to?: LoopEdge;
  };
  // Playback positions bound the pairs worth building: past maxMs, nothing later fits.
  const planTimeline = asSlices(plan.slices);
  const pb = (ms: number) => toPlaybackNearest(planTimeline, ms);
  // One candidate per distinct pair of first and last frames: the closest to the target.
  const byFrames = new Map<string, Candidate>();
  for (let i = 0; i < starts.length; i++)
    for (let k = i; k < ends.length; k++) {
      if (pb(Math.min(plan.beats[k].sourceStartMs, tail)) - pb(starts[i]) > maxMs + 1000) break;
      const s = clipSlices(plan.slices, starts[i], ends[k]);
      if (!s.length) continue;
      const len = playbackDuration(asSlices(s));
      if (len < minMs || len > maxMs) continue;
      const fit = Math.max(0.05, 1 - Math.abs(len - targetMs) / targetMs);
      const c = { slices: s, len, fit, first: s[0].startMs, last: s.at(-1)!.endMs };
      const key = `${Math.round(c.first)}:${Math.round(c.last)}`;
      if ((byFrames.get(key)?.fit ?? -1) < fit) byFrames.set(key, c);
    }
  const candidates = [...byFrames.values()];
  // Windows inside a run of beats, cut at sentence breaks and still screens (or,
  // failing those, targetMs after the run starts), for footage whose beats are
  // too long or too few to loop edge to edge, such as someone talking over one
  // long beat. Beats a phrase's pause apart or less (a talk split per sentence)
  // make one run, so its sentence breaks fall inside.
  const runs: { startMs: number; endMs: number }[] = [];
  plan.beats.forEach((b, i) => {
    const last = runs.at(-1);
    if (last && b.sourceStartMs - plan.beats[i - 1].sourceEndMs <= 600) last.endMs = ends[i];
    else runs.push({ startMs: starts[i], endMs: ends[i] });
  });
  const windowsByFrames = new Map<string, Candidate>();
  for (const run of runs) {
    const points: LoopEdge[] = [
      { ms: run.startMs, kind: "beat" as const, q: 1 },
      ...loopEdges(a, run.startMs, run.endMs),
      ...(run.startMs + targetMs < run.endMs
        ? [{ ms: run.startMs + targetMs, kind: "time" as const, q: 0.5 }]
        : []),
      { ms: run.endMs, kind: "beat" as const, q: 1 },
    ].sort((x, y) => x.ms - y.ms);
    for (let x = 0; x < points.length; x++)
      for (let y = x + 1; y < points.length; y++) {
        const from = points[x];
        const to = points[y];
        if (pb(to.ms) - pb(from.ms) > maxMs + 1) break;
        if (from.kind === "beat" && to.kind === "beat") continue;
        const s = clipSlices(plan.slices, from.ms, to.ms);
        if (!s.length) continue;
        const len = playbackDuration(asSlices(s));
        if (len < minMs || len > maxMs) continue;
        const fit = Math.max(0.05, 1 - Math.abs(len - targetMs) / targetMs) * from.q * to.q;
        const c = { slices: s, len, fit, first: s[0].startMs, last: s.at(-1)!.endMs, from, to };
        const key = `${Math.round(c.first)}:${Math.round(c.last)}`;
        if ((windowsByFrames.get(key)?.fit ?? -1) < fit) windowsByFrames.set(key, c);
      }
  }
  const windows = [...windowsByFrames.values()];
  const notes: string[] = [];
  let best: (Candidate & { ssim: number }) | null = null;
  let unread = 0;
  const scores = new Map<Candidate, number | null>();
  const check = async (list: Candidate[]) => {
    for (const c of list) {
      const score = await match(c.first, c.last).catch(() => null);
      scores.set(c, score);
      if (score === null) unread++;
      if (score === null || score < 0.9) continue;
      if (!best || score * c.fit > best.ssim * best.fit) best = { ...c, ssim: score };
    }
  };
  // Beat edges first; when none of them matches, the rest of the budget goes to windows.
  const checked = spreadByLength(candidates, LOOP_CHECKS);
  await check(checked);
  if (!best && LOOP_CHECKS > checked.length) {
    const more = spreadByLength(windows, LOOP_CHECKS - checked.length);
    await check(more);
    checked.push(...more);
  }
  let chosen: Candidate;
  let similarity: number | null;
  let seamless = !!best;
  const seamlessNote = (c: Candidate, ssim: number) =>
    `Loops ${secs(c.first)}-${secs(c.last)} of the recording${c.from ? `, a window inside one beat from ${edgeWords(c.from)} to ${edgeWords(c.to!)}` : ""}: its last frame matches its first (SSIM ${ssim.toFixed(2)}), so the join is invisible. ${secs(c.len)} on screen against a ${secs(targetMs)} target.`;
  if (best) {
    const found: Candidate & { ssim: number } = best;
    chosen = found;
    similarity = found.ssim;
    notes.push(seamlessNote(found, found.ssim));
  } else {
    // Where a hold may run: up to the next beat, and never into the stop click.
    const stops = [...a.clicks.map((c) => c.atMs), ...a.shortcuts.map((k) => k.atMs)].filter(
      (t) => t >= a.sourceDurationMs - STOP_CLICK_MS,
    );
    const footageEnd = stops.length ? Math.min(...stops) - 400 : a.sourceDurationMs;
    const holdTo = Math.max(minMs, Math.min(targetMs, maxMs));
    // The single beat closest to the target, held on its settled result long enough
    // to read before restarting: first the still screen after it (never into the
    // next beat), toward the target length, then its last second slowed down, to
    // 0.25x at most.
    const options = plan.beats.flatMap((b, i) => {
      const start = starts[i];
      const s = clipSlices(plan.slices, start, Math.min(ends[i], start + maxMs));
      if (!s.length) return [];
      let len = playbackDuration(asSlices(s));
      const room = Math.min(footageEnd, (plan.beats[i + 1]?.sourceStartMs ?? Infinity) - 200);
      let heldMs = 0;
      let slowed: number | null = null;
      const lastOf = () => s.at(-1)!;
      if (len < holdTo && room > lastOf().endMs) {
        heldMs = Math.min(room - lastOf().endMs, holdTo - len);
        if (lastOf().speed === 1) lastOf().endMs += heldMs;
        else s.push({ startMs: lastOf().endMs, endMs: lastOf().endMs + heldMs, speed: 1 });
        len += heldMs;
      }
      if (len < minMs) {
        const last = lastOf();
        const piece = Math.min(1000, last.endMs - last.startMs);
        const speed = Math.max(0.25, piece / (piece / last.speed + minMs - len));
        s.splice(
          s.length - 1,
          1,
          ...[
            { startMs: last.startMs, endMs: last.endMs - piece, speed: last.speed },
            { startMs: last.endMs - piece, endMs: last.endMs, speed: Math.round(speed * 100) / 100 },
          ].filter((x) => x.endMs > x.startMs),
        );
        slowed = Math.round(speed * 100) / 100;
        len = playbackDuration(asSlices(s));
      }
      return [
        {
          slices: s,
          len,
          fit: 1 - Math.abs(len - targetMs) / targetMs,
          first: s[0].startMs,
          last: s.at(-1)!.endMs,
          heldMs,
          slowed,
        },
      ];
    });
    // Any stretch near the target will do now: one beat held, several beats, or a window.
    const pick: (Candidate & { heldMs: number; slowed: number | null }) | undefined = [
      ...options.filter((x) => x.len <= maxMs + 0.5),
      ...candidates.map((c) => ({ ...c, heldMs: 0, slowed: null })),
      ...windows.map((w) => ({ ...w, heldMs: 0, slowed: null })),
    ].sort((x, y) => y.fit - x.fit)[0];
    if (!pick) throw new Error("No part of the recording is long enough to loop.");
    chosen = pick;
    const known = [...scores.entries()].find(([c]) => c.first === pick.first && c.last === pick.last);
    similarity = known ? known[1] : await match(chosen.first, chosen.last).catch(() => null);
    if (!known && similarity === null) unread++;
    if (similarity !== null && similarity >= 0.9) {
      seamless = true;
      notes.push(seamlessNote(pick, similarity));
    } else {
      if (unread && (unread === checked.length || (!checked.length && similarity === null)))
        notes.push(
          "The recording's frames could not be read (is the session video there?), so no join could be checked.",
        );
      const hold = [
        pick.heldMs ? `${secs(pick.heldMs)} of the settled screen after it` : "",
        pick.slowed !== null ? `its last second slowed to ${pick.slowed}x` : "",
      ].filter(Boolean);
      const what = pick.from
        ? `a window of ${secs(pick.len)} inside one beat, from ${edgeWords(pick.from)} to ${edgeWords(pick.to!)},`
        : options.includes(pick as (typeof options)[number])
          ? `one beat${hold.length ? ` held on its result (${hold.join(", ")})` : ""}`
          : `${secs(pick.len)} from one beat's start to a later beat's end`;
      notes.push(
        `${checked.length ? `No checked stretch of ${secs(minMs)}-${secs(maxMs)} (${checked.length} compared) ends where it starts` : `No stretch of ${secs(minMs)}-${secs(maxMs)} starts and ends on beat edges`}, so this loop is ${what} and the restart shows a jump${similarity !== null ? ` (SSIM ${similarity.toFixed(2)})` : ""}. For a seamless loop, record the action ending back on the starting screen.`,
      );
    }
    if (pick.len < minMs - 1)
      notes.push(
        `The loop is only ${secs(pick.len)}, under ${secs(minMs)}: the beat is short and the next one starts right after it.`,
      );
  }
  const loop = asSlices(chosen.slices);
  const zoomStart = toSource(loop, 500);
  const zoomEnd = toSource(loop, chosen.len - 800);
  const zooms = plan.zooms
    .map((z) => ({
      ...z,
      sourceStartMs: Math.max(z.sourceStartMs, zoomStart),
      sourceEndMs: Math.min(z.sourceEndMs, zoomEnd),
    }))
    .filter((z) => (playbackRange(loop, z.sourceStartMs, z.sourceEndMs)?.visibleMs ?? 0) >= 2000);
  if (zooms.length)
    notes.push(
      `${zooms.length} zoom${zooms.length > 1 ? "s" : ""} kept inside the loop, ending 0.8s before the restart so the last frame is wide like the first.`,
    );
  notes.push("Sound is muted and the cursor glides back to its starting point over the last 0.6s.");
  const ops = [
    {
      op: "setSlices",
      slices: chosen.slices.map((s) => ({ ...s, startMs: round(s.startMs), endMs: round(s.endMs) })),
    },
    { op: "clearZooms" },
    ...zooms.map((z) => ({
      op: "addZoom",
      startMs: Math.ceil(z.sourceStartMs),
      endMs: Math.floor(z.sourceEndMs),
      zoom: z.zoom,
      follow: z.follow,
      ...(z.follow ? {} : { target: z.target }),
    })),
    { op: "config", changes: LOOP_CONFIG },
  ] as EditOp[];
  return {
    seamless,
    ssim: similarity === null ? null : Math.round(similarity * 1000) / 1000,
    sourceRange: { startMs: round(chosen.first), endMs: round(chosen.last) },
    playbackMs: round(chosen.len),
    ops,
    notes,
  };
}

/**
 * Compares recording frames at two source times with ffmpeg's SSIM, caching
 * extracted frames. A time at a session's very end seeks to its last frame (an
 * accurate seek past the last frame's start finds nothing), as previews do.
 */
export function frameMatcher(studio: Studio, a: Analysis) {
  const frames = new Map<number, Promise<string>>();
  const timings = new Map<string, Promise<{ endSec: number; frameSec: number } | null>>();
  const logs: string[] = [];
  const timing = (video: string) => {
    if (!timings.has(video))
      timings.set(
        video,
        videoTiming(video).catch(() => null),
      );
    return timings.get(video)!;
  };
  const frame = (ms: number) => {
    const key = Math.round(ms);
    if (!frames.has(key))
      frames.set(
        key,
        (async () => {
          const { video, localMs } = sessionAt(a, key);
          const t = await timing(video);
          const seconds = t?.endSec ? previewSeconds(Math.min(localMs, t.endSec * 1000), t) : localMs / 1000;
          const out = await studio.statePath(`loop-frame-${randomUUID()}.png`);
          await frameAt(video, seconds, out, { vf: "scale=320:-2", timeoutMs: 30000 });
          return out;
        })(),
      );
    return frames.get(key)!;
  };
  const match: FrameMatcher = async (x, y) => {
    const log = await studio.statePath(`loop-ssim-${randomUUID()}.log`);
    logs.push(log);
    try {
      return await ssim(await frame(x), await frame(y), log);
    } finally {
      await rm(log, { force: true }).catch(() => {});
    }
  };
  return {
    match,
    frame,
    async cleanup() {
      for (const p of frames.values()) await rm(await p.catch(() => ""), { force: true }).catch(() => {});
      for (const log of logs) await rm(log, { force: true }).catch(() => {});
      frames.clear();
    },
  };
}

export interface LoopRequest {
  targetMs: number;
  outputDir: string;
  baseName?: string;
  formats: ("mp4" | "webm" | "gif")[];
  maxGifBytes: number;
  apply: boolean;
  show: boolean;
}

/** A free sibling project path: "<name> Loop.screenstudio", then "<name> Loop 2.screenstudio". */
async function loopProjectPath(projectPath: string) {
  const stem = basename(projectPath, ".screenstudio");
  for (let n = 1; n < 100; n++) {
    const p = join(dirname(projectPath), `${stem} Loop${n > 1 ? ` ${n}` : ""}.screenstudio`);
    if (!(await stat(p).catch(() => null))) return p;
  }
  throw new Error("Too many loop copies next to this project.");
}

/**
 * Plans a loop, applies it to a copy of the project (the main edit stays as it
 * is), renders it, and converts it for the web: MP4, silent WebM and a GIF under
 * budget, with a poster and the first and last frames side by side.
 */
export async function makeLoop(
  studio: Studio,
  editor: Editor,
  projectPath: string,
  a: Analysis,
  req: LoopRequest,
) {
  const path = await studio.path(projectPath);
  const dir = await outputFolder(req.outputDir);
  const base = baseNameFor(path, req.baseName, "-loop");
  const m = frameMatcher(studio, a);
  try {
    const loop = await planLoop(a, { targetMs: req.targetMs }, m.match);
    if (!req.apply) {
      try {
        const seam = await sideBySide(studio, [
          {
            path: await m.frame(loop.sourceRange.startMs),
            label: `first · ${secs(loop.sourceRange.startMs)} in the recording`,
          },
          {
            path: await m.frame(loop.sourceRange.endMs),
            label: `last · ${secs(loop.sourceRange.endMs)} in the recording`,
          },
        ]);
        return { loop, files: {}, seam, notes: [...loop.notes, ...seam.notes] };
      } catch (e) {
        const why = e instanceof Error ? e.message.split("\n")[0] : String(e);
        return { loop, files: {}, notes: [...loop.notes, `No join image: ${why}`] };
      }
    }
    const copy = await loopProjectPath(path);
    await studio.duplicate(path, copy);
    await editor.open(copy);
    // An older project may lack a loop setting; skip it rather than fail the whole apply.
    const config = (await editor.raw(copy)).config;
    const missing = Object.keys(LOOP_CONFIG).filter((k) => !has(config, k));
    const ops = loop.ops.map((op) =>
      op.op === "config"
        ? {
            ...op,
            changes: Object.fromEntries(Object.entries(op.changes).filter(([k]) => !missing.includes(k))),
          }
        : op,
    );
    if (missing.length)
      loop.notes.push(`This project has no ${missing.join(", ")} setting, so it was left out.`);
    const applied = await editor.apply(copy, undefined, ops, req.show ? { stepMs: 350 } : undefined);
    if ("partial" in applied) throw new Error(`The loop copy could not be edited: ${applied.error}`);
    await editor.save(copy);
    const live = await editor.liveProject(copy);
    if (!live) throw new Error("The loop copy is not open in the editor; open it and run again.");
    const keepMp4 = req.formats.includes("mp4");
    const mp4 = keepMp4
      ? await freePath(dir, base, "mp4")
      : await studio.statePath(`loop-${randomUUID()}.mp4`);
    const job = await studio.startRender(
      copy,
      mp4,
      {
        height: renderHeight(
          live.config?.output?.aspectRatio,
          1080,
          captureRatio(a.capture, live.config?.crop?.rect01),
        ),
        fps: 60,
        format: "mp4",
        quality: "studio",
      },
      live,
      "live",
    );
    const done = await studio.waitForExport(job.jobId);
    if (done.status !== "completed")
      throw new Error(`The loop render ended as ${done.status}${done.error ? `: ${done.error}` : ""}.`);
    const files: Record<string, string> = {};
    const notes = [...loop.notes];
    if (keepMp4) files.mp4 = mp4;
    const temps: string[] = [];
    const temp = async (name: string) => {
      const p = await studio.statePath(name);
      temps.push(p);
      return p;
    };
    try {
      if (req.formats.includes("webm")) {
        const tmp = await temp(`loop-${randomUUID()}.webm`);
        await toWebm(mp4, tmp);
        files.webm = await copyNew(tmp, dir, base, "webm");
      }
      if (req.formats.includes("gif")) {
        const tmp = await temp(`loop-${randomUUID()}.gif`);
        const fit = await fitGif(async (o) => {
          await toGif(mp4, tmp, o);
          return (await stat(tmp)).size;
        }, req.maxGifBytes);
        files.gif = await copyNew(tmp, dir, base, "gif");
        notes.push(
          fit.fits
            ? `GIF at ${fit.fps}fps, ${fit.height}px tall, ${(fit.bytes / 1e6).toFixed(1)} MB.`
            : `GIF is ${(fit.bytes / 1e6).toFixed(1)} MB even at ${fit.fps}fps and ${fit.height}px; use the WebM or a shorter targetMs.`,
        );
      }
      const timing = mediaSummary(await probe(mp4));
      const first = await videoFrame(studio, mp4, 0);
      temps.push(first);
      const last = await videoFrame(studio, mp4, timing.durationMs);
      temps.push(last);
      files.poster = await copyNew(first, dir, `${base}-poster`, "png");
      const seam = await sideBySide(studio, [
        { path: first, label: "first frame" },
        { path: last, label: `last frame · ${clock(timing.durationMs)}` },
      ]);
      notes.push(...seam.notes);
      return { loop, project: copy, files, media: timing, seam, notes, embed: loopEmbed(files) };
    } finally {
      for (const t of temps) await rm(t, { force: true }).catch(() => {});
      if (!keepMp4) await rm(mp4, { force: true }).catch(() => {});
    }
  } finally {
    await m.cleanup();
  }
}

/**
 * An HTML snippet for the loop: a silent autoplaying video with the WebM and MP4
 * it has, or an image when only a GIF was made. File names are URL-encoded.
 */
export function loopEmbed(files: { mp4?: string; webm?: string; gif?: string; poster?: string }) {
  const url = (p: string) => encodeURIComponent(basename(p));
  if (!files.mp4 && !files.webm)
    return files.gif ? `<img src="${url(files.gif)}" alt="" loading="lazy">` : undefined;
  return `<video autoplay muted loop playsinline${files.poster ? ` poster="${url(files.poster)}"` : ""}>${files.webm ? `<source src="${url(files.webm)}" type="video/webm">` : ""}${files.mp4 ? `<source src="${url(files.mp4)}" type="video/mp4">` : ""}</video>`;
}
