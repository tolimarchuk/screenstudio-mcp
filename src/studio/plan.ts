// The planner: turns a recording analysis into calm cuts, speed-ups only for
// typing and waiting, and few, long zooms grouped like Screen Studio's auto-zoom.
import type { Analysis } from "./recording.js";
import { overlaps, subtractSpans, type Span } from "./spans.js";
import {
  checkPacing,
  clock,
  CUTS_PER_10S,
  isTalkingCut,
  secs,
  shortZoomMs,
  speedRamping,
  STOP_CLICK_MS,
  type PacingReport,
} from "./pacing.js";
import { DEFAULT_STYLE, STYLE_CONFIG, STYLES, type PacingRules, type Style } from "./styles.js";
import {
  playbackDuration,
  playbackRange,
  round,
  toPlayback,
  toPlaybackNearest,
  toSource,
  type Slice,
  type Spring,
} from "./timeline.js";
import {
  describeBeats,
  findRetakes,
  markerMode,
  sentencesOf,
  markerProtection,
  markerTimes,
  tagMarkers,
  voicedBeats,
  type Action,
  type BeatRole,
  type MarkerMode,
  type StoryBeat,
} from "./beats.js";
import { planLayouts, type CameraOptions } from "./camera.js";
import { quietValley, valleyBetween, type Valley } from "./audio.js";

export interface PlannedZoom {
  sourceStartMs: number;
  sourceEndMs: number;
  zoom: number;
  follow: boolean;
  target: { x: number; y: number };
  reason: string;
}

export interface PlannedBeat {
  sourceStartMs: number;
  sourceEndMs: number;
  actions: string[];
  /** What the beat is worth to the viewer; fit-to-length drops the lowest first. */
  score: number;
  role: BeatRole;
  label: string;
  /** False when the beat was dropped (fit to length, a retake) or cut by the caller's drops. */
  kept: boolean;
  /** The marker that starts the beat, when the recording has markers. */
  marker?: string;
  /** With markers: "chapters", the chapter the beat belongs to (0 before the first marker). */
  chapter?: number;
}

export interface DroppedBeat {
  sourceStartMs: number;
  sourceEndMs: number;
  label: string;
  score: number;
  reason: string;
}

export interface Plan {
  style: Style;
  beats: PlannedBeat[];
  droppedBeats: DroppedBeat[];
  slices: { startMs: number; endMs: number; speed: number; reason: string }[];
  zooms: PlannedZoom[];
  config: Record<string, unknown>;
  summary: string;
  /** Director's notes: each decision at its playback time, with the rule it follows. */
  notes: string[];
  /** With targetMs: whether the edit fits, and by how much it runs over when it cannot. */
  fit?: { targetMs: number; playbackMs: number; fitted: boolean; overshootMs: number };
  /** With structure hook-demo-payoff: the payoff's settled result, a moment to open on as a hook. */
  coldOpen?: { sourceStartMs: number; sourceEndMs: number; playbackStartMs: number; reason: string };
  /** With talkingHead: camera layouts planned over this edit. */
  layouts?: ReturnType<typeof planLayouts>;
  pacing: PacingReport;
}

export interface PlanOptions {
  style?: Style;
  keep?: Span[];
  drop?: Span[];
  zoom?: "auto" | "none";
  maxZooms?: number;
  speedUps?: boolean;
  /** Cut silences between spoken phrases down to this much on each side (talking videos: 250-400). */
  tightenPausesMs?: number;
  removeFillers?: boolean;
  /** Aim for this playback length: drop the lowest-value beats, then speed typing and waiting to the style's cap. */
  targetMs?: number;
  /** hook-demo-payoff shortens setup lead-ins and suggests a cold open on the payoff. Slices stay in order. */
  structure?: "linear" | "hook-demo-payoff";
  /** What markers dropped while recording do: keep (default when there are any), retake, chapters, ignore. */
  markers?: MarkerMode;
  /**
   * Voiced beats: one length per marker, in marker order (a narration line's
   * beatMs). Each marker keeps [marker, marker + ms], so a hold stretched for its
   * line survives as footage to read the line over.
   */
  markerBeatsMs?: number[];
  /** Pacing rule overrides on top of the style (a recipe's). */
  rules?: Partial<PacingRules>;
  /** Plan camera layouts for a talking-head recording too. */
  talkingHead?: boolean;
  camera?: CameraOptions;
}

type Beat = Span & { actions: Action[]; leadInMs?: number };
/** Says whether the gap between two kept pieces may be closed again, and what kind of cut it is. */
type Gaps = { hard: (a: Span, b: Span) => boolean; talking: (a: Span, b: Span) => boolean };
type SpeedUp = Span & { speed: number; reason: string };
type ScoredZoom = PlannedZoom & { value: number };
type PageChange = Analysis["screen"]["changes"][number];

/** True when targets this far apart (0-1 of the frame) fit a zoom level with a 12% margin. */
const fitsFrame = (spanX: number, spanY: number, level: number) =>
  spanX <= 1 / level - 0.24 && spanY <= 1 / level - 0.24;

const asTimeline = (slices: { startMs: number; endMs: number; speed: number }[]): Slice[] =>
  slices.map((x) => ({ sourceStartMs: x.startMs, sourceEndMs: x.endMs, timeScale: 1 / x.speed }));

function actionsOf(a: Analysis): Action[] {
  return [
    ...a.clicks.map((c) => ({
      kind: (c.drag ? "drag" : "click") as Action["kind"],
      startMs: c.atMs,
      endMs: Math.max(c.endMs, c.atMs + 100),
      x: c.x,
      y: c.y,
      label: `${c.drag ? "drag" : "click"} at (${c.x.toFixed(2)}, ${c.y.toFixed(2)})`,
    })),
    ...a.typing.map((t) => ({
      kind: "typing" as const,
      startMs: t.startMs,
      endMs: t.endMs + 150,
      x: t.x,
      y: t.y,
      label: `typing ${t.chars} chars`,
    })),
    ...a.shortcuts.map((k) => ({
      kind: "shortcut" as const,
      startMs: k.atMs,
      endMs: k.atMs + 150,
      label: `shortcut ${k.keys}`,
    })),
  ].sort((x, y) => x.startMs - y.startMs);
}

/** Silence kept after the last word before a dropped sentence, and before the first word after it. */
const BREATH_AFTER_MS = 120;
const BREATH_BEFORE_MS = 80;

/**
 * Where cuts next to each sentence may sit. When the transcript's pause between
 * two sentences holds the breath, a kept sentence keeps BREATH_AFTER_MS after
 * its last word and BREATH_BEFORE_MS before its first. Real pauses between
 * sentences are mostly under 200ms, so otherwise the cut goes to the middle of
 * the microphone's valley between them, when it dips at least VALLEY_DB below
 * speech. Without either, a kept sentence keeps the breath it would need, which
 * leaves no room to cut next to it.
 */
function sentenceEdges(sentences: Span[], valleys: Valley[] | undefined) {
  const at = new Map(sentences.map((s, i) => [s.startMs, i]));
  /** The quiet valley between sentence i and the next, when the gap is shorter than `breathMs`. */
  const valley = (i: number, breathMs: number) => {
    const p = sentences[i];
    const n = sentences[i + 1];
    if (!p || !n || n.startMs - p.endMs >= breathMs) return undefined;
    const v = valleyBetween(valleys, p, n);
    // A valley outside the two sentences' edges by more than the search reach is not theirs.
    return v && quietValley(v) && v.atMs > p.startMs && v.atMs < n.endMs ? v : undefined;
  };
  return (x: Span) => {
    const i = at.get(x.startMs);
    const before = (breathMs: number) => (i === undefined ? undefined : valley(i - 1, breathMs));
    const after = (breathMs: number) => (i === undefined ? undefined : valley(i, breathMs));
    return {
      /** Kept: the stretch around it that a cut must leave alone. */
      kept: {
        startMs: before(BREATH_BEFORE_MS)?.atMs ?? x.startMs - BREATH_BEFORE_MS,
        endMs: after(BREATH_AFTER_MS)?.atMs ?? x.endMs + BREATH_AFTER_MS,
      },
      /** Dropped: the stretch a cut must take out. */
      gone: {
        startMs: before(BREATH_AFTER_MS)?.atMs ?? x.startMs,
        endMs: after(BREATH_BEFORE_MS)?.atMs ?? x.endMs,
      },
    };
  };
}

/** A last line shorter than this ("Thanks!") joins the beat before it. */
const SHORT_LINE_MS = 1500;

/**
 * 1. Beats: actions close in time belong together, and a marker always starts a
 * new beat. Speech splits at sentences: the next sentence starts a beat of its
 * own once the beat holds speech and nothing else in it runs on into that
 * sentence, so a long talk yields a beat per sentence and fitting to a length
 * can cut between them. An action's visible result keeps the beat busy too: a
 * sentence starting before the page has answered a click belongs with the
 * click, so the click and its result stay one beat. A short last line joins
 * the beat before.
 */
function findBeats(a: Analysis, actions: Action[], R: PacingRules, markers: number[] = []): Beat[] {
  const beats: Beat[] = [];
  const talks = (b: Beat) => b.actions.some((x) => x.kind === "speech");
  const busyUntil = (b: Beat) => {
    const done = Math.max(-Infinity, ...b.actions.filter((x) => x.kind !== "speech").map((x) => x.endMs));
    return done === -Infinity ? done : resultEndOf(a, { startMs: b.startMs, endMs: done, actions: [] }, R);
  };
  const marked = (from: number, to: number) => markers.some((m) => m > from && m <= to);
  const close = (b: Beat, act: Span) => act.startMs - b.endMs < R.minCutGapMs + R.holdAfterMs;
  for (const act of actions) {
    const last = beats.at(-1);
    const nextSentence = last && act.kind === "speech" && talks(last) && act.startMs >= busyUntil(last);
    if (last && !marked(last.startMs, act.startMs) && !nextSentence && close(last, act)) {
      last.endMs = Math.max(last.endMs, act.endMs);
      last.actions.push(act);
    } else beats.push({ startMs: act.startMs, endMs: act.endMs, actions: [act] });
  }
  const [before, end] = beats.slice(-2);
  if (
    end &&
    before &&
    end.actions.every((x) => x.kind === "speech") &&
    end.endMs - end.startMs < SHORT_LINE_MS &&
    talks(before) &&
    !marked(before.startMs, end.startMs) &&
    close(before, end)
  ) {
    before.endMs = Math.max(before.endMs, end.endMs);
    before.actions.push(...end.actions);
    beats.pop();
  }
  return beats;
}

/** When a beat's visible result (a screen change, loading, animation) is over. */
function resultEndOf(a: Analysis, b: Beat, R: PacingRules) {
  let resultEnd = b.endMs;
  for (const c of a.screen.changes)
    if (c.atMs > b.endMs && c.atMs - b.endMs <= R.resultWindowMs) resultEnd = Math.max(resultEnd, c.atMs);
  // Let ongoing motion (loading, animation) finish within the result window.
  for (const m of a.screen.active)
    if (m.startMs <= resultEnd + 200 && m.endMs > resultEnd && m.endMs - b.endMs <= R.resultWindowMs * 2)
      resultEnd = Math.max(resultEnd, m.endMs);
  return resultEnd;
}

/**
 * Where the video must end: before Screen Studio's stop click (or stop shortcut)
 * and, when the input log has it, before the cursor sets off towards it.
 */
function tailOf(a: Analysis, actions: Action[]) {
  const end = a.sourceDurationMs;
  const stops = [...a.clicks.map((c) => c.atMs), ...a.shortcuts.map((k) => k.atMs)].filter(
    (t) => t >= end - STOP_CLICK_MS,
  );
  if (!stops.length) return end;
  const stop = Math.min(...stops);
  const lastAction = Math.max(0, ...actions.filter((x) => x.startMs < stop).map((x) => x.endMs));
  const trip = a.movement.find((m) => m.startMs <= stop && m.endMs >= stop - 250);
  return Math.max(0, Math.min(stop - 400, trip ? Math.max(trip.startMs, lastAction) : Infinity));
}

/** 2. Keep each beat with a lead-in, its visible result, and a readable hold. */
function keepSpans(
  a: Analysis,
  beats: Beat[],
  extra: Span[],
  R: PacingRules,
  clamp: (n: number) => number,
  tail: number,
): Span[] {
  const upToTail = (n: number) => Math.max(0, Math.min(tail, n));
  const keep: Span[] = beats.map((b) => ({
    startMs: upToTail(b.startMs - (b.leadInMs ?? R.leadInMs)),
    endMs: upToTail(resultEndOf(a, b, R) + R.holdAfterMs),
  }));
  for (const k of extra) keep.push({ startMs: clamp(k.startMs), endMs: clamp(k.endMs) });
  if (!keep.length) keep.push({ startMs: 0, endMs: tail });
  keep.sort((x, y) => x.startMs - y.startMs);
  keep[0].startMs = clamp(Math.min(keep[0].startMs, keep[0].startMs - (R.openingHoldMs - R.leadInMs)));
  const last = keep.at(-1)!;
  last.endMs = Math.max(last.endMs, upToTail(last.endMs + R.finalHoldMs - R.holdAfterMs));
  return keep.filter((k) => k.endMs > k.startMs);
}

/** 3. Merge ranges separated by pauses too short to be worth a cut. */
function mergeShortGaps(keep: Span[], minCutGapMs: number): Span[] {
  const ranges: Span[] = [];
  for (const k of keep) {
    const last = ranges.at(-1);
    if (last && k.startMs - last.endMs < minCutGapMs) last.endMs = Math.max(last.endMs, k.endMs);
    else ranges.push({ ...k });
  }
  return ranges;
}

/**
 * Pauses between phrases: keep a breath on each side and cut the still parts of
 * the rest. Input, cursor travel and screen motion stay, and so does the result
 * of an action with its readable hold.
 */
function pauseCuts(
  a: Analysis,
  speech: Span[],
  results: Span[],
  actions: Action[],
  tightenPausesMs?: number,
): Span[] {
  if (!tightenPausesMs) return [];
  const pauses = speech.slice(1).map((p, i) => ({
    startMs: speech[i].endMs + tightenPausesMs,
    endMs: p.startMs - tightenPausesMs,
  }));
  const busy = [...results, ...actions.map((x) => ({ startMs: x.startMs - 200, endMs: x.endMs + 200 }))];
  return pauses
    .flatMap((p) =>
      a.idle.map((i) => ({ startMs: Math.max(p.startMs, i.startMs), endMs: Math.min(p.endMs, i.endMs) })),
    )
    .filter((c) => c.endMs - c.startMs >= 300 && !overlaps(c, busy));
}

/**
 * Dead air is a still stretch between two actions; the opening and final holds
 * are not dead air, and neither are spans the caller protected (for example
 * narration over a still screen).
 */
function deadAir(a: Analysis, actions: Action[], protectedSpans: Span[], R: PacingRules): Span[] {
  const between = a.idle.filter(
    (i) => actions.some((x) => x.endMs <= i.startMs + 50) && actions.some((x) => x.startMs >= i.endMs - 50),
  );
  return subtractSpans(between, protectedSpans).filter(
    (i) => i.endMs - i.startMs > R.maxPauseMs + R.minCutGapMs,
  );
}

/**
 * Typing and waiting may be sped up, but never so much that they flash by.
 * Fitting to a length lets them run up to the style's cap as long as each
 * stays on screen a full second.
 */
function findSpeedUps(
  a: Analysis,
  actions: Action[],
  protectedSpans: Span[],
  R: PacingRules,
  fit = false,
): SpeedUp[] {
  const fast: SpeedUp[] = [];
  const speedFor = (len: number, max: number) => Math.min(max, len / (fit ? 1000 : 1200));
  /** Down to a quarter step, never past the cap (and never past 4x, where footage races). */
  const quarter = (speed: number, max: number) => {
    const cap = Math.min(MAX_SPEED, max);
    return Math.min(cap, Math.floor(speed * 4) / 4);
  };
  // A burst can run across a click into the next field; the click plays at natural speed.
  const clicks = actions
    .filter((x) => x.kind === "click" || x.kind === "drag")
    .map((x) => ({ startMs: x.startMs - 300, endMs: x.endMs + 300 }));
  for (const t of a.typing)
    if (t.endMs - t.startMs > 1500)
      for (const span of subtractSpans([{ startMs: t.startMs + 300, endMs: t.endMs - 200 }], clicks)) {
        const speed = speedFor(span.endMs - span.startMs, R.typingSpeed);
        if (speed >= 1.3 && !overlaps(span, protectedSpans))
          fast.push({ ...span, speed: quarter(speed, R.typingSpeed), reason: `typing ${t.chars} chars` });
      }
  for (const w of a.screen.active) {
    if (w.endMs - w.startMs < 2500) continue;
    const inner = { startMs: w.startMs + 600, endMs: w.endMs - 800 };
    const busy = actions.some((x) => x.startMs < inner.endMs + 300 && x.endMs > inner.startMs - 300);
    const speed = speedFor(inner.endMs - inner.startMs, R.waitSpeed);
    if (!busy && speed >= 1.3 && !overlaps(inner, protectedSpans))
      fast.push({ ...inner, speed: quarter(speed, R.waitSpeed), reason: "waiting for the screen" });
  }
  return fast.filter((f) => f.speed > 1);
}

/** Past this, footage races by; the pacing check flags it as very fast. */
const MAX_SPEED = 4;

/** How many times the speed changes from one slice to the next, the way the pacing check counts them. */
function speedChangesOf(slices: Plan["slices"]) {
  return slices.slice(1).filter((x, i) => Math.abs(x.speed - slices[i].speed) > 0.01).length;
}

/**
 * Speed-ups must not make the speed ramp up and down: while the slices change
 * speed more often than the pacing check allows, the speed-up that saves the
 * least plays at natural speed instead.
 */
function limitSpeedRamps(kept: Span[], fast: SpeedUp[]): SpeedUp[] {
  let left = fast;
  for (;;) {
    const slices = buildSlices(kept, left);
    if (!speedRamping(speedChangesOf(slices), playbackDuration(asTimeline(slices)))) return left;
    // Only the speed-ups that made it into the slices change the speed.
    const used = left.filter((f) =>
      slices.some((x) => x.speed === f.speed && x.reason === f.reason && overlaps(x, [f])),
    );
    if (!used.length) return left;
    const saves = (f: SpeedUp) =>
      kept.reduce((n, k) => n + Math.max(0, Math.min(k.endMs, f.endMs) - Math.max(k.startMs, f.startMs)), 0) *
      (1 - 1 / f.speed);
    const least = used.reduce((w, f) => (saves(f) < saves(w) ? f : w));
    left = left.filter((f) => f !== least);
  }
}

/** On-screen length of a kept span once its sped-up stretches are applied. */
const playbackOf = (k: Span, fast: SpeedUp[]) =>
  fast.reduce(
    (n, f) =>
      n - Math.max(0, Math.min(k.endMs, f.endMs) - Math.max(k.startMs, f.startMs)) * (1 - 1 / f.speed),
    k.endMs - k.startMs,
  );

/**
 * 4b. A cut must leave pieces long enough to read. Joins or grows short pieces in
 * place. The caller's drops are never rejoined or grown into.
 */
function joinShortPieces(
  kept: Span[],
  fast: SpeedUp[],
  R: PacingRules,
  tail: number,
  drops: Span[],
  gaps: Gaps,
) {
  for (let i = 0; i < kept.length;) {
    const k = kept[i];
    if (playbackOf(k, fast) >= 1200 || kept.length === 1) {
      i++;
      continue;
    }
    const prevGap = i > 0 && !gaps.hard(kept[i - 1], k) ? k.startMs - kept[i - 1].endMs : Infinity;
    const nextGap =
      i < kept.length - 1 && !gaps.hard(k, kept[i + 1]) ? kept[i + 1].startMs - k.endMs : Infinity;
    const joinable = R.maxPauseMs + R.minCutGapMs;
    if (prevGap <= nextGap && prevGap <= joinable) {
      kept[i - 1].endMs = k.endMs;
      kept.splice(i, 1);
      continue;
    }
    if (nextGap <= joinable) {
      kept[i + 1].startMs = k.startMs;
      kept.splice(i, 1);
      continue;
    }
    // Separated by dead air or drops on both sides: let the piece breathe instead,
    // on whichever side has room.
    const need = 1200 - playbackOf(k, fast);
    const from = Math.max(
      i > 0 ? kept[i - 1].endMs + 1 : 0,
      ...drops.filter((d) => d.endMs <= k.startMs).map((d) => d.endMs),
    );
    const to = Math.min(
      i < kept.length - 1 ? kept[i + 1].startMs - 1 : tail,
      ...drops.filter((d) => d.startMs >= k.endMs).map((d) => d.startMs),
    );
    const roomBefore = Math.max(0, k.startMs - from);
    const roomAfter = Math.max(0, to - k.endMs);
    const before = Math.min(roomBefore, Math.max(need / 2, need - roomAfter));
    k.startMs -= before;
    k.endMs += Math.min(roomAfter, need - before);
    // A sliver left between two forced cuts is better removed than flashed.
    if (playbackOf(k, fast) < 400) kept.splice(i, 1);
    else i++;
  }
}

/**
 * Cuts must stay rare: rejoin across the smallest gaps until the rate is calm.
 * Jump cuts inside a talk get their own, looser limit when pauses are tightened;
 * otherwise every cut counts against the calm limit. The caller's drops always
 * stay cut. Works in place.
 */
function limitCutRate(kept: Span[], fast: SpeedUp[], R: PacingRules, gaps: Gaps, tighten: boolean) {
  const joinable = R.maxPauseMs + R.minCutGapMs;
  for (;;) {
    const length = kept.reduce((n, k) => n + playbackOf(k, fast), 0);
    const all = kept.slice(1).map((k, j) => ({
      i: j + 1,
      ms: k.startMs - kept[j].endMs,
      hard: gaps.hard(kept[j], k),
      talking: gaps.talking(kept[j], k),
    }));
    const perTen = (n: number) => (n / length) * 10000;
    const scene = all.filter((g) => !g.talking);
    const sceneOver = perTen(scene.length) > R.cutsPer10s;
    const over = tighten
      ? all.filter((g) => (g.talking ? perTen(all.length - scene.length) > CUTS_PER_10S.talking : sceneOver))
      : perTen(all.length) > R.cutsPer10s
        ? all
        : [];
    const best = over.filter((g) => !g.hard).sort((x, y) => x.ms - y.ms)[0];
    if (best && best.ms <= joinable) {
      kept[best.i - 1].endMs = kept[best.i].endMs;
      kept.splice(best.i, 1);
      continue;
    }
    // Only dead air is left to rejoin: let the pieces next to it breathe into the
    // still screen until the cuts are calm again.
    if (perTen(scene.length) <= R.cutsPer10s) break;
    // A little over the exact need, so rounding to whole milliseconds stays under the bound.
    const want = (scene.length * 10000) / R.cutsPer10s - length + 100;
    let need = want;
    for (const g of scene.filter((g) => !g.hard).sort((x, y) => x.ms - y.ms)) {
      const take = Math.min(need, g.ms - R.minCutGapMs);
      if (take <= 0) continue;
      kept[g.i - 1].endMs += take / 2;
      kept[g.i].startMs -= take / 2;
      need -= take;
      if (need <= 0) break;
    }
    if (need === want) break;
  }
}

/**
 * 5. Speed only typing and waiting; clicks stay at a followable speed. Every
 * clip, sped up or not, stays on screen for at least a second.
 */
function buildSlices(kept: Span[], fast: SpeedUp[]): Plan["slices"] {
  const slices: Plan["slices"] = [];
  const push = (seg: Span, speed: number, reason: string) => {
    const last = slices.at(-1);
    if (last && last.endMs === seg.startMs && last.speed === speed) last.endMs = seg.endMs;
    else if (seg.endMs > seg.startMs) slices.push({ ...seg, speed, reason });
  };
  for (const k of kept) {
    let at = k.startMs;
    for (const f of fast
      .filter((x) => x.endMs > k.startMs && x.startMs < k.endMs)
      .sort((x, y) => x.startMs - y.startMs)) {
      const startMs = f.startMs <= at ? at : Math.max(f.startMs, at + 1000);
      const endMs = f.endMs >= k.endMs ? k.endMs : Math.min(f.endMs, k.endMs - 1000);
      if ((endMs - startMs) / f.speed < 1000) continue;
      push({ startMs: at, endMs: startMs }, 1, "action at natural speed");
      push({ startMs, endMs }, f.speed, f.reason);
      at = endMs;
    }
    push({ startMs: at, endMs: k.endMs }, 1, "action at natural speed");
  }
  return slices;
}

/**
 * A zoom asks the viewer to read, so the footage under it plays at most 1.25x.
 * Slowing footage only lengthens zooms and the wide shots around them, so the
 * zooms stay valid without planning them again. Stretches that already play at
 * natural speed stay that way.
 */
function calmUnderZooms(fast: SpeedUp[], slices: Plan["slices"], zooms: PlannedZoom[]): SpeedUp[] {
  const zoomed = zooms.map((z) => ({ startMs: z.sourceStartMs, endMs: z.sourceEndMs }));
  return fast
    .filter((f) => slices.some((s) => s.speed === f.speed && s.reason === f.reason && overlaps(s, [f])))
    .map((f) => (f.speed > 1.25 && overlaps(f, zoomed) ? { ...f, speed: 1.25 } : f));
}

// ---------------------------------------------------------------- zooms

/** Groups targets by Screen Studio's own rule: actions under zoomGroupGapMs apart share one zoom. */
function groupTargets(targets: Action[], timeline: Slice[], R: PacingRules): Action[][] {
  const groups: Action[][] = [];
  for (const t of targets) {
    const g = groups.at(-1);
    const pt = toPlayback(timeline, t.startMs);
    if (pt === null) continue;
    const lastP = g ? toPlayback(timeline, g.at(-1)!.endMs) : null;
    if (g && lastP !== null && pt - lastP < R.zoomGroupGapMs) g.push(t);
    else groups.push([t]);
  }
  return groups;
}

/** A zoom ends before the screen is replaced; viewers need the wide view of a new page. */
function splitAtPages(group: Action[], pageChanges: PageChange[]): Action[][] {
  let split = [group];
  for (const c of pageChanges)
    split = split.flatMap((part) => {
      const i = part.findIndex((x) => x.startMs > c.atMs);
      return i > 0 && part[0].startMs < c.atMs ? [part.slice(0, i), part.slice(i)] : [part];
    });
  return split;
}

/** Deepest level that keeps every target inside a 12% margin. */
function fit(part: Action[], levels: number[]) {
  const xs = part.map((p) => p.x!);
  const ys = part.map((p) => p.y!);
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  return { xs, ys, spanX, spanY, level: levels.find((z) => fitsFrame(spanX, spanY, z)) };
}

/**
 * Too spread out for one frame: split at the biggest jump across the screen.
 * A shallow zoom over a wide group barely reads; a tighter zoom on part of it is better.
 */
function framed(part: Action[], levels: number[]): Action[][] {
  const shallowest = Math.min(...levels);
  const level = fit(part, levels).level;
  if (part.length < 2 || (level && level > shallowest)) return [part];
  let cut = 1;
  let jump = -1;
  for (let i = 1; i < part.length; i++) {
    const d = Math.hypot(part[i].x! - part[i - 1].x!, part[i].y! - part[i - 1].y!);
    if (d > jump) [jump, cut] = [d, i];
  }
  const halves = [part.slice(0, cut), part.slice(cut)];
  if (level && !halves.some((h) => (fit(h, levels).level ?? 0) > level)) return [part];
  return halves.flatMap((h) => framed(h, levels));
}

/** One zoom over a group of targets, stretched to the minimum length where the footage allows. */
function frameGroup(
  part: Action[],
  timeline: Slice[],
  pageChanges: PageChange[],
  R: PacingRules,
  clamp: (n: number) => number,
): ScoredZoom | null {
  const { xs, ys, spanX, spanY, level } = fit(part, R.zoomLevels);
  if (!level) return null;
  const prevPage = [...pageChanges].reverse().find((c) => c.atMs <= part[0].startMs);
  const startS = Math.max(part[0].startMs - R.zoomLeadMs, prevPage ? prevPage.atMs + 300 : 0);
  let endS = part.at(-1)!.endMs + R.zoomHoldMs;
  const nextPage = pageChanges.find((c) => c.atMs > part.at(-1)!.endMs + 150);
  if (nextPage) endS = Math.min(endS, nextPage.atMs - 150);
  const zoom: ScoredZoom = {
    sourceStartMs: clamp(startS),
    sourceEndMs: clamp(endS),
    zoom: level,
    // Manual: one fixed position that frames every target. Following the mouse is only
    // for tracking the pointer itself (a drag); clicks get a still, deliberate frame.
    follow: part.some((p) => p.kind === "drag"),
    target: {
      x: Math.round(((Math.max(...xs) + Math.min(...xs)) / 2) * 1000) / 1000,
      y: Math.round(((Math.max(...ys) + Math.min(...ys)) / 2) * 1000) / 1000,
    },
    reason: part.map((p) => p.label).join(", "),
    value:
      part.reduce((v, p) => v + (p.kind === "typing" ? 3 : 1), 0) + (spanX < 0.15 && spanY < 0.15 ? 1 : 0),
  };
  const range = playbackRange(timeline, zoom.sourceStartMs, zoom.sourceEndMs);
  if (range && range.visibleMs < R.zoomMinMs) {
    zoom.sourceEndMs = clamp(zoom.sourceEndMs + R.zoomMinMs - range.visibleMs);
    if (nextPage) zoom.sourceEndMs = Math.min(zoom.sourceEndMs, nextPage.atMs - 150);
    const after = playbackRange(timeline, zoom.sourceStartMs, zoom.sourceEndMs);
    if (after && after.visibleMs < R.zoomMinMs) {
      // Arrive earlier instead, but never across the previous page change.
      const earliest = Math.max(prevPage ? prevPage.atMs + 300 : 0, part[0].startMs - 1500);
      zoom.sourceStartMs = clamp(Math.max(earliest, zoom.sourceStartMs - (R.zoomMinMs - after.visibleMs)));
    }
  }
  return zoom;
}

/** Open and close wide: trim zooms into the middle of the video rather than dropping them. */
function openCloseWide(zooms: ScoredZoom[], timeline: Slice[], playbackMs: number, R: PacingRules) {
  return zooms.filter((z) => {
    const r = playbackRange(timeline, z.sourceStartMs, z.sourceEndMs);
    if (!r) return false;
    if (r.startMs < R.openingWideMs) z.sourceStartMs = toSource(timeline, Math.min(R.openingWideMs, r.endMs));
    const lastWide = playbackMs - R.closingWideMs;
    if (r.endMs > lastWide) z.sourceEndMs = toSource(timeline, Math.max(lastWide, 0));
    const after = playbackRange(timeline, z.sourceStartMs, z.sourceEndMs);
    return (
      after &&
      z.sourceEndMs > z.sourceStartMs &&
      after.visibleMs >= Math.max(R.zoomMinMs - 200, shortZoomMs(R))
    );
  });
}

/** Neighbours too close for a real wide shot: merge if they fit one frame, else keep the stronger. In place. */
function resolveNeighbours(
  zooms: ScoredZoom[],
  timeline: Slice[],
  pageChanges: PageChange[],
  R: PacingRules,
) {
  const visible = (z: PlannedZoom) => playbackRange(timeline, z.sourceStartMs, z.sourceEndMs);
  for (let i = 0; i < zooms.length - 1;) {
    const a1 = zooms[i];
    const b1 = zooms[i + 1];
    const gap = visible(b1)!.startMs - visible(a1)!.endMs;
    if (gap >= R.zoomWideGapMs) {
      i++;
      continue;
    }
    const spanX = Math.abs(a1.target.x - b1.target.x);
    const spanY = Math.abs(a1.target.y - b1.target.y);
    const level = Math.min(a1.zoom, b1.zoom);
    const pageBetween = pageChanges.some((c) => c.atMs > a1.sourceStartMs && c.atMs < b1.sourceEndMs);
    if (!pageBetween && fitsFrame(spanX, spanY, level)) {
      zooms.splice(i, 2, {
        sourceStartMs: a1.sourceStartMs,
        sourceEndMs: b1.sourceEndMs,
        zoom: level,
        follow: a1.follow || b1.follow,
        target: { x: (a1.target.x + b1.target.x) / 2, y: (a1.target.y + b1.target.y) / 2 },
        reason: `${a1.reason}; ${b1.reason}`,
        value: a1.value + b1.value,
      });
    } else if (!pageBetween) {
      // Too far apart for one frame: two manual zooms back to back, handing off where the
      // first ends, rather than zooming out and straight back in or re-aiming one zoom.
      // The first holds until the second begins, so neither gets shorter.
      if (b1.sourceStartMs >= a1.sourceEndMs) {
        a1.sourceEndMs = b1.sourceStartMs;
        i++;
        continue;
      }
      const handoff = Math.round((a1.sourceEndMs + b1.sourceStartMs) / 2);
      const was = { a: a1.sourceEndMs, b: b1.sourceStartMs };
      a1.sourceEndMs = handoff;
      b1.sourceStartMs = handoff;
      const tooShort = [a1, b1].some((z) => (visible(z)?.visibleMs ?? 0) < R.zoomMinMs);
      if (!tooShort) {
        i++;
        continue;
      }
      a1.sourceEndMs = was.a;
      b1.sourceStartMs = was.b;
      zooms.splice(a1.value >= b1.value ? i + 1 : i, 1);
    } else zooms.splice(a1.value >= b1.value ? i + 1 : i, 1);
  }
}

/** Keeps the `cap` most valuable zooms, in timeline order. */
function capZooms(zooms: ScoredZoom[], cap: number) {
  if (zooms.length <= cap) return zooms;
  const best = new Set([...zooms].sort((x, y) => y.value - x.value).slice(0, cap));
  return zooms.filter((z) => best.has(z));
}

/** 6. Zooms: group by Screen Studio's own 5.3s rule, frame the group, then thin out. */
function planZooms(
  a: Analysis,
  actions: Action[],
  timeline: Slice[],
  R: PacingRules,
  clamp: (n: number) => number,
  maxZooms?: number,
): ScoredZoom[] {
  const playbackMs = playbackDuration(timeline);
  const pageChanges = a.screen.changes.filter((c) => c.kind === "page");
  const targets = actions.filter((x) => x.x !== undefined && x.kind !== "shortcut");
  let zooms: ScoredZoom[] = [];
  for (const g of groupTargets(targets, timeline, R))
    for (const part of splitAtPages(g, pageChanges).flatMap((p) => framed(p, R.zoomLevels))) {
      const zoom = frameGroup(part, timeline, pageChanges, R, clamp);
      if (zoom) zooms.push(zoom);
    }
  zooms = openCloseWide(zooms, timeline, playbackMs, R);
  resolveNeighbours(zooms, timeline, pageChanges, R);
  // zoomsPerMinute 0 means no zooms; otherwise a short video still earns one.
  const perMinute =
    R.zoomsPerMinute > 0 ? Math.max(1, Math.floor((R.zoomsPerMinute * playbackMs) / 60000)) : 0;
  return capZooms(zooms, maxZooms ?? perMinute);
}

/** Everything the cut needs that stays the same while fitting to a length. */
interface CutInput {
  a: Analysis;
  actions: Action[];
  /** The caller's drops and the filler words. */
  drops: Span[];
  /** The caller's keeps and what markers protect. */
  keep: Span[];
  speech: Span[];
  tail: number;
  clamp: (n: number) => number;
  options: PlanOptions;
}

interface Edit {
  slices: Plan["slices"];
  zooms: PlannedZoom[];
  playbackMs: number;
}

/** Steps 2-6, from beats to slices and zooms. Runs again each time fitting to a length drops a beat. */
function cutBeats(c: CutInput, beats: Beat[], beatDrops: Span[], R: PacingRules, fit: boolean): Edit {
  const { a, actions, speech, tail, clamp, options } = c;
  // The caller's drops, the filler words and dropped beats are hard cuts: nothing rejoins them.
  const drops = [...c.drops, ...beatDrops];
  const ranges = mergeShortGaps(keepSpans(a, beats, c.keep, R, clamp, tail), R.minCutGapMs);
  const results = beats.flatMap((b) => {
    const resultEnd = resultEndOf(a, b, R);
    return resultEnd > b.endMs ? [{ startMs: b.endMs, endMs: resultEnd + R.holdAfterMs }] : [];
  });

  // 4. Remove the drops, tightened pauses and long dead air inside kept ranges.
  const protectedSpans = [...c.keep, ...speech];
  const kept = subtractSpans(
    ranges,
    [
      ...drops,
      ...pauseCuts(
        a,
        speech,
        results,
        actions.filter((x) => x.kind !== "speech"),
        options.tightenPausesMs,
      ),
      ...deadAir(a, actions, protectedSpans, R).map((i) => ({
        startMs: i.startMs + R.maxPauseMs / 2,
        endMs: i.endMs - R.maxPauseMs / 2,
      })),
    ],
    400,
  );
  const gaps: Gaps = {
    hard: (x, y) => drops.some((d) => d.startMs < y.startMs && d.endMs > x.endMs),
    talking: (x, y) => isTalkingCut(x.endMs, y.startMs, speech, a.fillers),
  };
  const found = options.speedUps !== false ? findSpeedUps(a, actions, protectedSpans, R, fit) : [];
  joinShortPieces(kept, found, R, tail, drops, gaps);
  limitCutRate(kept, found, R, gaps, !!options.tightenPausesMs);
  // Fitting to a length keeps every speed-up: a ramp reads better than a dropped beat.
  const fast = fit ? found : limitSpeedRamps(kept, found);

  const draft = buildSlices(kept, fast);
  // Only the beats still in the edit can ask for a zoom.
  const live = beats.flatMap((b) => b.actions);
  const zooms =
    options.zoom !== "none" ? planZooms(a, live, asTimeline(draft), R, clamp, options.maxZooms) : [];
  const slices = zooms.length
    ? buildSlices(
        kept,
        fit ? calmUnderZooms(fast, draft, zooms) : limitSpeedRamps(kept, calmUnderZooms(fast, draft, zooms)),
      )
    : draft;
  const roundedSlices = slices.map((x) => ({ ...x, startMs: round(x.startMs), endMs: round(x.endMs) }));
  return {
    slices: roundedSlices,
    // Rounded outwards, so a zoom never loses on-screen time to rounding.
    zooms: zooms.map(({ value: _v, ...z }) => ({
      ...z,
      sourceStartMs: Math.floor(z.sourceStartMs),
      sourceEndMs: Math.ceil(z.sourceEndMs),
    })),
    playbackMs: playbackDuration(asTimeline(roundedSlices)),
  };
}

/** The payoff beat still in the edit: the one with the payoff role, else the last. */
const payoffOf = (beats: StoryBeat[]) => beats.find((b) => b.role === "payoff") ?? beats.at(-1);

/** The payoff's settled result: the moment after its last screen change, inside the kept footage. */
function coldOpenOf(a: Analysis, payoff: StoryBeat | undefined, slices: Plan["slices"], R: PacingRules) {
  if (!payoff || !slices.length) return undefined;
  const settled = resultEndOf(a, payoff, R);
  const pieces: Span[] = [];
  for (const s of slices) {
    const last = pieces.at(-1);
    if (last && s.startMs - last.endMs <= 1) last.endMs = s.endMs;
    else pieces.push({ startMs: s.startMs, endMs: s.endMs });
  }
  const piece =
    pieces.find((p) => settled >= p.startMs && settled <= p.endMs) ??
    [...pieces].reverse().find((p) => p.startMs <= settled) ??
    pieces[0];
  const len = Math.min(1800, piece.endMs - piece.startMs);
  const startMs = round(Math.max(piece.startMs, Math.min(settled, piece.endMs - len)));
  return {
    sourceStartMs: startMs,
    sourceEndMs: round(startMs + len),
    playbackStartMs: round(toPlaybackNearest(asTimeline(slices), startMs)),
    reason: `The payoff (${payoff.label}) once the screen has settled. Open on it as a hook: export these ${secs(len)} as their own clip to lead the post, or use the frame as the thumbnail. The editor keeps clips in source order, so the plan does not move it to the front.`,
  };
}

export function planEdit(a: Analysis, options: PlanOptions = {}): Plan {
  const style = options.style ?? DEFAULT_STYLE;
  let R: PacingRules = { ...STYLES[style], ...options.rules };
  // Zoom levels from overrides may come in any order; framing picks the first that fits, deepest first.
  R = { ...R, zoomLevels: [...R.zoomLevels].sort((x, y) => y - x) };
  const end = a.sourceDurationMs;
  const clamp = (n: number) => Math.max(0, Math.min(end, n));
  const speech = a.speech ?? [];
  // Beats split between sentences; the phrases stand in when there are none.
  const sentences = sentencesOf(a);
  const edges = sentenceEdges(sentences, a.valleys);
  const fillers = options.removeFillers ? (a.fillers ?? []) : [];
  // Callers that skip the tool schema may pass empty or inverted spans; they mean nothing.
  const valid = (s: Span) => s.endMs > s.startMs;
  options = { ...options, keep: options.keep?.filter(valid), drop: options.drop?.filter(valid) };
  const drops = [
    ...(options.drop ?? []),
    ...fillers.map((f) => ({ startMs: f.startMs - 40, endMs: f.endMs + 40 })),
  ];
  const actions: Action[] = [
    ...actionsOf(a).filter((x) => !overlaps(x, drops) && x.startMs < end - STOP_CLICK_MS),
    ...sentences.map((p) => ({
      kind: "speech" as const,
      startMs: p.startMs,
      endMs: p.endMs,
      label: `says "${p.text.slice(0, 40)}"`,
      text: p.text,
    })),
  ].sort((x, y) => x.startMs - y.startMs);
  const tail = tailOf(a, actions);

  // Markers dropped while recording start beats and, in keep mode, protect what follows them.
  const mode = markerMode(a, options.markers);
  const markers = mode === "ignore" ? [] : markerTimes(a);
  const keep = [
    ...(options.keep ?? []),
    ...(mode === "keep" ? markerProtection(markers, speech, options.keep ?? [], tail) : []),
    ...(options.markerBeatsMs?.length ? voicedBeats(markerTimes(a), options.markerBeatsMs, tail) : []),
  ];

  // 1. Beats, each with a score, a role in the story and a label.
  const story = describeBeats(
    a,
    tagMarkers(
      findBeats(
        a,
        actions,
        R,
        markers.map((m) => m.sourceMs),
      ),
      markers,
    ),
    R,
  ) as (StoryBeat & Beat)[];
  if (options.structure === "hook-demo-payoff")
    for (const b of story) if (b.role === "setup") b.leadInMs = R.leadInMs / 2;
  const dropped: { beat: StoryBeat; spans: Span[]; reason: string }[] = [];
  const live = () => story.filter((b) => !dropped.some((d) => d.beat === b));
  /**
   * What dropping a beat cuts: its own actions and result, less the actions of
   * the beats still in the edit (markers can split a beat while a phrase or an
   * action is still running). Speech kept on either side keeps a breath: the cut
   * starts BREATH_AFTER_MS after the last word kept before it and ends
   * BREATH_BEFORE_MS before the next, since recognizer word edges are often off
   * by 100ms; where the transcript shows no such pause, the cut sits in the
   * middle of the audio valley between the sentences instead (sentenceEdges).
   * Null when the beat cannot go cleanly: nothing would be left to cut, or one
   * of its own actions or phrases would be cut in half (also when the pause
   * around a sentence is too short to cut in and the audio does not dip).
   */
  const dropSpans = (b: StoryBeat & Beat, span?: Span, group: StoryBeat[] = [b]): Span[] | null => {
    const reach = (x: Action): Span => (x.kind === "speech" ? edges(x).gone : x);
    const mine = group.flatMap((x) => (x as StoryBeat & Beat).actions).map(reach);
    const own = span ?? {
      startMs: Math.min(...b.actions.map((x) => reach(x).startMs)) - 150,
      endMs: Math.max(resultEndOf(a, b, R), ...b.actions.map((x) => reach(x).endMs)) + 150,
    };
    const range = { startMs: clamp(own.startMs), endMs: clamp(own.endMs) };
    const others = live()
      .filter((x) => !group.includes(x) && x.startMs < range.endMs + 1000 && x.endMs > range.startMs - 1000)
      .flatMap((x) => x.actions)
      .map((x) => (x.kind === "speech" ? edges(x).kept : x));
    const spans = subtractSpans([range], others).filter(valid);
    const gone = (x: Span) =>
      spans.some(
        (s) => s.startMs <= Math.max(x.startMs, range.startMs) && s.endMs >= Math.min(x.endMs, range.endMs),
      );
    return spans.length && mine.every(gone) ? spans : null;
  };
  /** Drops a beat (or a group: a whole retake); false (and nothing recorded) when it cannot go cleanly. */
  const drop = (b: StoryBeat, reason: string, span?: Span, group: StoryBeat[] = [b]) => {
    const spans = dropSpans(b as StoryBeat & Beat, span, group);
    if (spans) for (const x of group) dropped.push({ beat: x, spans: x === b ? spans : [], reason });
    return !!spans;
  };
  if (mode === "retake")
    for (const r of findRetakes(story, markers, speech))
      drop(
        r.beat,
        `retake: the take after marker ${r.marker.id} repeats ${Math.round(r.similarity * 100)}% of its words`,
        r.span,
        r.beats.includes(r.beat) ? r.beats : [...r.beats, r.beat],
      );

  const input: CutInput = { a, actions, drops, keep, speech, tail, clamp, options };
  let fitSpeeds = false;
  const build = () =>
    cutBeats(
      input,
      live(),
      dropped.flatMap((d) => d.spans),
      R,
      fitSpeeds,
    );
  let edit = build();

  // Fit to length. Gentler steps keep every beat, so they go first when they are
  // enough: typing and waiting run to the style's cap, then (for short targets)
  // shorter holds. Otherwise the beats worth least go, never the payoff or a beat
  // you keep, and the gentle steps are tried again once they could be enough.
  let fit: Plan["fit"];
  let fitSteps: string[] = [];
  /** Beats fit-to-length could not cut cleanly: no pause around them to cut in. */
  let uncut = 0;
  if (options.targetMs) {
    const target = options.targetMs;
    const bound = target * 1.05;
    const base = R;
    const steps: { R: PacingRules; fast: boolean; note: string }[] = [];
    if (options.speedUps !== false)
      steps.push({
        R: base,
        fast: true,
        note: `typing and waiting run up to ${base.typingSpeed}x and ${base.waitSpeed}x`,
      });
    if (target <= 30000) {
      const held = {
        ...base,
        openingHoldMs: Math.min(base.openingHoldMs, 900),
        holdAfterMs: round(base.holdAfterMs * 0.75),
      };
      steps.push({
        R: held,
        fast: options.speedUps !== false,
        note: `holds shortened to ${secs(held.openingHoldMs)} opening and ${secs(held.holdAfterMs)} after actions`,
      });
    }
    const gentlest = () => {
      for (const [i, step] of steps.entries()) {
        const tried = cutBeats(
          input,
          live(),
          dropped.flatMap((d) => d.spans),
          step.R,
          step.fast,
        );
        if (tried.playbackMs <= bound || i === steps.length - 1)
          return { ...step, edit: tried, notes: steps.slice(0, i + 1).map((x) => x.note) };
      }
      return null;
    };
    const payoff = payoffOf(live());
    const unclean = new Set<StoryBeat>();
    const droppable = (b: StoryBeat) =>
      b !== payoff && !unclean.has(b) && !overlaps(b, options.keep ?? []) && !(mode === "keep" && b.marker);
    // What the gentle steps save, measured once; later they are only tried when that could be enough.
    let gentle = edit.playbackMs > bound ? gentlest() : null;
    /** What the gentle steps keep of the current cut, read again each time they run. */
    const ratioOf = (g: typeof gentle) =>
      g ? Math.min(1, g.edit.playbackMs / Math.max(1, edit.playbackMs)) : 1;
    let ratio = ratioOf(gentle);
    const isDropped = (b: StoryBeat | undefined) => !!b && dropped.some((d) => d.beat === b);
    // Every round drops a beat or rules one out, so this many rounds always ends it.
    for (let rounds = 0; edit.playbackMs > bound && rounds < story.length * 2 + 4; rounds++) {
      const candidates = live().filter(droppable);
      if (!gentle && steps.length && (edit.playbackMs * ratio <= bound * 1.25 || !candidates.length)) {
        gentle = gentlest();
        ratio = ratioOf(gentle);
      }
      if (gentle && (gentle.edit.playbackMs <= bound || !candidates.length)) {
        ({ R, edit } = gentle);
        fitSpeeds = gentle.fast;
        fitSteps = gentle.notes;
        break;
      }
      if (!candidates.length) break;
      // How much each beat would take off, read from the current cut.
      const timeline = asTimeline(edit.slices);
      const est = new Map<StoryBeat, number>();
      for (const b of candidates) {
        const spans = dropSpans(b);
        if (!spans) unclean.add(b);
        else
          est.set(
            b,
            spans.reduce((n, s) => n + (playbackRange(timeline, s.startMs, s.endMs)?.visibleMs ?? 0), 0),
          );
      }
      const pool = candidates.filter((b) => (est.get(b) ?? 0) > 0);
      if (!pool.length) {
        for (const b of candidates) unclean.add(b);
        continue;
      }
      // Pick beats until they cover the overshoot: the lowest score first, then
      // its neighbours when they score about as low (one cut instead of two), and
      // among equals the beat whose length best matches what is left to cut.
      const picks: StoryBeat[] = [];
      const next = (b: StoryBeat, d: number) => story[story.indexOf(b as StoryBeat & Beat) + d];
      const joins = (b: StoryBeat) =>
        [next(b, -1), next(b, 1)].some((n) => isDropped(n) || picks.includes(n));
      let left = edit.playbackMs - target / ratio;
      while (left > 0 && pool.length) {
        const min = Math.min(...pool.map((b) => b.score));
        const joined = pool.filter((b) => b.score <= min + 1 && joins(b));
        const choices = joined.length ? joined : pool.filter((b) => b.score === min);
        const miss = (b: StoryBeat) => Math.abs(est.get(b)! - left);
        const best = choices.reduce((w, b) =>
          b.score < w.score || (b.score === w.score && miss(b) < miss(w)) ? b : w,
        );
        picks.push(best);
        pool.splice(pool.indexOf(best), 1);
        left -= est.get(best)!;
      }
      // Still over but nothing picked (the gentle steps looked like enough): drop the beat worth least.
      if (!picks.length)
        picks.push(
          pool.reduce((w, b) =>
            b.score < w.score || (b.score === w.score && est.get(b)! < est.get(w)!) ? b : w,
          ),
        );
      // Drop them in one go; when that cuts well under the target, try half as many.
      for (let count = Math.max(1, picks.length); ; count = Math.ceil(count / 2)) {
        const mark = dropped.length;
        for (const b of picks.slice(0, count))
          if (!drop(b, `lowest value (score ${b.score}: ${b.scoreParts.join(", ")}) to fit ${secs(target)}`))
            unclean.add(b);
        const tried = build();
        if (count === 1 || tried.playbackMs >= target * 0.9) {
          edit = tried;
          break;
        }
        dropped.length = mark;
      }
      gentle = null;
    }
    uncut = [...unclean].filter((b) => !isDropped(b)).length;
    fit = {
      targetMs: target,
      playbackMs: round(edit.playbackMs),
      fitted: edit.playbackMs <= bound,
      overshootMs: Math.max(0, round(edit.playbackMs - target)),
    };
  }
  const { slices, zooms } = edit;
  const timeline = asTimeline(slices);
  const layouts = options.talkingHead
    ? planLayouts(a, { slices: timeline, zooms }, options.camera)
    : undefined;
  // checkPacing judges cuts and layout changes against sentences: the plan cuts between them.
  const pacing = checkPacing(
    {
      slices: timeline,
      zooms,
      screenSpring: STYLE_CONFIG[style]["animations.screenMovementSpring"] as Spring,
      layouts: layouts?.stretches,
    },
    a,
    style,
    { rules: options.rules },
  );
  const coldOpen =
    options.structure === "hook-demo-payoff" ? coldOpenOf(a, payoffOf(live()), slices, R) : undefined;
  const shown = (s: Span) => overlaps(s, slices);
  const beats: PlannedBeat[] = story.map((b) => ({
    sourceStartMs: round(b.startMs),
    sourceEndMs: round(b.endMs),
    actions: b.actions.map((x) => x.label),
    score: b.score,
    role: b.role,
    label: b.label,
    // A cut placed on an audio valley may leave a dropped sentence's recognized edge on screen.
    kept: !dropped.some((d) => d.beat === b) && b.actions.some(shown),
    ...(b.marker ? { marker: b.marker } : {}),
    ...(mode === "chapters" ? { chapter: b.chapter } : {}),
  }));
  const droppedBeats: DroppedBeat[] = dropped.map((d) => ({
    sourceStartMs: round(d.beat.startMs),
    sourceEndMs: round(d.beat.endMs),
    label: d.beat.label,
    score: d.beat.score,
    reason: d.reason,
  }));

  const cut = a.sourceDurationMs - slices.reduce((n, x) => n + x.endMs - x.startMs, 0);
  const caveats = [
    ...(options.drop ?? []).filter(shown).map((d) => `Could not drop ${secs(d.startMs)}-${secs(d.endMs)}.`),
    ...(options.removeFillers
      ? [`Removed ${fillers.filter((f) => !shown(f)).length} of ${fillers.length} fillers.`]
      : []),
  ];
  // A fitted edit the pacing check fails is not a fit: say what went wrong.
  const fitErrors = fit ? pacing.issues.filter((i) => i.severity === "error") : [];
  if (fit && fit.fitted && fitErrors.length) fit.fitted = false;
  const fitLine = fit
    ? fitErrors.length && fit.playbackMs <= fit.targetMs * 1.05
      ? `Plays ${secs(fit.playbackMs)} for ${secs(fit.targetMs)}${dropped.length ? ` after dropping ${dropped.length} beat${dropped.length > 1 ? "s" : ""}` : ""}, but the cut fails the pacing check: ${fitErrors.map((i) => i.message.split(". ")[0]).join("; ")}. Raise targetMs, or keep a dropped beat by hand so fewer cuts land close together.`
      : fit.fitted
        ? `Fits ${secs(fit.targetMs)}: plays ${secs(fit.playbackMs)}${dropped.length ? ` after dropping ${dropped.length} beat${dropped.length > 1 ? "s" : ""}` : ""}${fitSteps.length ? `; ${fitSteps.join("; ")}` : ""}.`
        : `Runs ${secs(fit.overshootMs)} over ${secs(fit.targetMs)} (plays ${secs(fit.playbackMs)}): every beat left is the payoff${mode === "keep" && markers.length ? ", a marked beat" : ""}${uncut ? `, one with no pause around it to cut in (${uncut}${a.valleysUnavailable ? `; no audio valleys either: ${a.valleysUnavailable}` : ""})` : ""} or one you asked to keep${fitSteps.length ? `, after ${fitSteps.join(" and ")}` : ""}. Raise targetMs or drop a beat by hand${mode === "keep" && markers.length ? `, or pass markers: "chapters" so marked beats can go` : ""}.`
    : null;
  const notes = directorNotes({
    a,
    R,
    style,
    options,
    story,
    dropped,
    slices,
    zooms,
    markers,
    mode,
    fillersRemoved: caveats,
    fitLine,
    coldOpen,
    layoutNotes: layouts?.notes ?? [],
  });
  return {
    style,
    beats,
    droppedBeats,
    slices,
    zooms,
    config: STYLE_CONFIG[style],
    summary: [
      `${secs(a.sourceDurationMs)} of footage to ${secs(pacing.playbackMs)}: ${beats.filter((b) => b.kept).length} of ${beats.length} beats, ${secs(cut)} cut, ${slices.filter((x) => x.speed > 1).length} sped-up stretches, ${zooms.length} zooms.`,
      ...(fitLine ? [fitLine] : []),
      ...caveats,
    ].join(" "),
    notes,
    ...(fit ? { fit } : {}),
    ...(coldOpen ? { coldOpen } : {}),
    ...(layouts ? { layouts } : {}),
    pacing,
  };
}

// ---------------------------------------------------------------- director's notes

/** The first or last few words of a line, for a note. */
const wordsOf = (text: string, end: "first" | "last", count = 3) => {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= count) return text.replace(/[.?!…,]+$/, "");
  return end === "first"
    ? `${words
        .slice(0, count)
        .join(" ")
        .replace(/[,.]+$/, "")}...`
    : `...${words.slice(-count).join(" ")}`;
};

/**
 * A note for a cut whose edges sit on audio valleys rather than in transcript
 * pauses: it starts in the breath after the last sentence kept, or ends in the
 * breath before the next one, or both. Null when neither edge is on a valley.
 */
function valleyNote(a: Analysis, gap: Span): string | null {
  const said = sentencesOf(a);
  const on = (t: number) =>
    (a.valleys ?? []).find(
      (v) => quietValley(v) && v.beforeMs - v.afterMs < BREATH_AFTER_MS && Math.abs(t - v.atMs) <= 1,
    );
  const dips = (v: { quietDb: number }) => `audio dips ${Math.round(-v.quietDb)}dB`;
  const pause = (v: { afterMs: number; beforeMs: number }) =>
    v.beforeMs > v.afterMs ? `only a ${round(v.beforeMs - v.afterMs)}ms pause` : "no pause";
  const out = on(gap.startMs);
  const back = on(gap.endMs);
  const last = out && said.find((s) => Math.abs(s.endMs - out.afterMs) < 1);
  const next = back && said.find((s) => Math.abs(s.startMs - back.beforeMs) < 1);
  const after = last && `the breath after "${wordsOf(last.text, "last")}"`;
  const before = next && `the breath before "${wordsOf(next.text, "first")}"`;
  if (after && before)
    return `cut in ${after} (${dips(out)}) and back in ${before} (${dips(back)}); the transcript shows ${pause(out) === pause(back) ? `${pause(out)} at either` : `${pause(out)} and ${pause(back)}`}.`;
  if (after) return `cut in ${after} (${dips(out)}; the transcript shows ${pause(out)}).`;
  if (before) return `cut in ${before} (${dips(back!)}; the transcript shows ${pause(back!)}).`;
  return null;
}

/**
 * Every decision in playback order, the way an editor would explain the cut:
 * what happens at each moment and the rule behind it.
 */
function directorNotes(x: {
  a: Analysis;
  R: PacingRules;
  style: Style;
  options: PlanOptions;
  story: StoryBeat[];
  dropped: { beat: StoryBeat; spans: Span[]; reason: string }[];
  slices: Plan["slices"];
  zooms: PlannedZoom[];
  markers: NonNullable<Analysis["markers"]>;
  mode: MarkerMode;
  fillersRemoved: string[];
  fitLine: string | null;
  coldOpen: Plan["coldOpen"];
  layoutNotes: string[];
}): string[] {
  const { a, R, style, options, slices } = x;
  const timeline = asTimeline(slices);
  const at = (sourceMs: number) => toPlaybackNearest(timeline, sourceMs);
  const timed: { at: number; text: string }[] = [];
  const add = (atMs: number, text: string) => timed.push({ at: atMs, text });
  const live = x.story.filter((b) => !x.dropped.some((d) => d.beat === b) && overlaps(b, slices));
  if (!slices.length) return ["Nothing to keep: the recording has no footage before the stop click."];

  const first = live[0];
  if (first && at(first.startMs) >= 300)
    add(
      0,
      `opens on the starting screen for ${secs(at(first.startMs))} before the first action, so viewers see where they are (opening hold ${secs(R.openingHoldMs)}).`,
    );
  for (const b of live)
    add(
      at(b.startMs),
      `${b.role}${x.mode === "chapters" && b.chapter ? `, chapter ${b.chapter}` : ""}: ${b.label} (score ${b.score}: ${b.scoreParts.join(", ")}).`,
    );

  // Cuts, each with its reason. Jump cuts inside a talk and filler cuts are counted, not listed.
  let talkCuts = 0;
  let talkAt = -1;
  for (let i = 1; i < slices.length; i++) {
    const gap = { startMs: slices[i - 1].endMs, endMs: slices[i].startMs };
    if (gap.endMs - gap.startMs <= 50) continue;
    const p = at(gap.endMs);
    const len = secs(gap.endMs - gap.startMs);
    const gone = x.dropped.find((d) => overlaps(gap, d.spans));
    if (gone) {
      add(p, `cut ${len}: dropped "${gone.beat.label}", ${gone.reason}.`);
      const note = valleyNote(a, gap);
      if (note) add(p, note);
    } else if (overlaps(gap, options.drop ?? [])) add(p, `cut ${len} you asked to drop.`);
    else if (isTalkingCut(gap.startMs, gap.endMs, a.speech, a.fillers)) {
      talkCuts++;
      if (talkAt < 0) talkAt = p;
    } else
      add(
        p,
        `cut ${len} with nothing to watch: no click, typing or speech, only a still screen or a drifting cursor (each beat keeps ${secs(R.leadInMs)} before its first action and ${secs(R.holdAfterMs)} after its result; still moments over ${secs(R.maxPauseMs)} go).`,
      );
  }
  // A trim at either end can sit on a valley too, when a dropped sentence opened or closed the video.
  const opens = valleyNote(a, { startMs: -Infinity, endMs: slices[0].startMs });
  if (opens) add(0, opens);
  const closes = valleyNote(a, { startMs: slices.at(-1)!.endMs, endMs: Infinity });
  if (closes) add(playbackDuration(timeline), closes);
  if (talkCuts)
    add(
      talkAt,
      `${talkCuts} jump cut${talkCuts > 1 ? "s" : ""} inside the talk${options.tightenPausesMs ? `, pauses tightened to ${options.tightenPausesMs}ms of silence each side` : ""}${options.removeFillers ? " and fillers removed" : ""}: they read as one take, so they may come more often than scene cuts.`,
    );

  const capFor = (reason: string) => (reason.startsWith("typing") ? R.typingSpeed : R.waitSpeed);
  for (const s of slices.filter((s) => s.speed > 1)) {
    const r = playbackRange(timeline, s.startMs, s.endMs)!;
    add(
      r.startMs,
      `${s.reason} plays at ${s.speed}x for ${secs(r.visibleMs)} (${style} lets ${s.reason.startsWith("typing") ? "typing" : "waiting"} run up to ${capFor(s.reason)}x and never flash by; clicks and speech stay at a followable speed).`,
    );
  }
  for (const z of x.zooms) {
    const r = playbackRange(timeline, z.sourceStartMs, z.sourceEndMs);
    if (!r) continue;
    add(
      r.startMs,
      `zoom ${z.zoom}x for ${secs(r.visibleMs)} on ${z.reason}${z.follow ? ", following the pointer" : ", at one manual position"} (the deepest level that frames every target with a 12% margin; ${style} allows about ${R.zoomsPerMinute} a minute with ${secs(R.zoomWideGapMs)} of wide shot between).`,
    );
  }
  if (options.zoom === "none") add(0, "no zooms, as asked.");
  else if (!x.zooms.length)
    add(
      0,
      `no zooms: no group of actions earned one (a zoom needs ${secs(shortZoomMs(R))} on screen, must open and close wide and must end before the page changes).`,
    );

  const playbackMs = playbackDuration(timeline);
  const lastAction = Math.max(0, ...live.flatMap((b) => b.actions.map((y) => at(y.endMs))));
  if (lastAction > 0)
    add(
      lastAction,
      `holds the end ${secs(playbackMs - lastAction)} after the last action and stops before Screen Studio's stop click (final hold ${secs(R.finalHoldMs)}, longer while a result is still loading).`,
    );

  // A chapter starts where its marker plays, else at its first beat still in the
  // edit; a chapter with neither on screen says so instead of borrowing a time.
  const chaptersCut: string[] = [];
  if (x.mode === "chapters")
    for (const [i, m] of x.markers.entries()) {
      const onScreen = slices.some((s) => m.sourceMs >= s.startMs && m.sourceMs < s.endMs);
      const firstBeat = live.find((b) => b.chapter === i + 1);
      if (onScreen) add(at(m.sourceMs), `chapter ${i + 1} starts (marker ${m.id}).`);
      else if (firstBeat) add(at(firstBeat.startMs), `chapter ${i + 1} starts (marker ${m.id}).`);
      else chaptersCut.push(`Chapter ${i + 1} (marker ${m.id}) was cut: none of its footage is in the edit.`);
    }
  if (x.mode === "keep" && x.markers.length)
    add(
      0,
      `${x.markers.length > 1 ? `${x.markers.length} markers start beats; each keeps` : "1 marker starts a beat and keeps"} the moment after it (the stretch to the next marker when someone is talking over it, else 1.5s).`,
    );
  if (x.coldOpen)
    add(
      x.coldOpen.playbackStartMs,
      `cold open candidate, ${secs(x.coldOpen.sourceEndMs - x.coldOpen.sourceStartMs)}: ${x.coldOpen.reason}`,
    );

  return [
    ...(x.fitLine ? [x.fitLine] : []),
    ...x.fillersRemoved,
    ...chaptersCut,
    ...timed.sort((p, q) => p.at - q.at).map((n) => `${clock(n.at)} ${n.text}`),
    ...x.layoutNotes,
  ];
}
