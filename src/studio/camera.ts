// The camera director: camera layouts for a talking-head recording, planned
// from the speech, the clicks and the zooms. The person stands cut out beside
// the screen by default; layouts change on sentence boundaries.
import type { Analysis } from "./recording.js";
import { sentencesOf } from "./beats.js";
import { clock, secs, STOP_CLICK_MS } from "./pacing.js";
import type { Span } from "./spans.js";
import { playbackRange, round, toPlaybackNearest, type Slice, type Zoom } from "./timeline.js";

export type LayoutType = "fullscreen-camera" | "screen-only" | "split-screen";

export interface LayoutStretch {
  sourceStartMs: number;
  sourceEndMs: number;
  type: LayoutType;
  reason: string;
}

export interface CameraOptions {
  /** Stretches closer than this (playback ms) join up instead of flashing the default layout between them. */
  minStretchMs?: number;
  /** Cutout camera side: 0 left, 1 right, auto away from the clicks. */
  side?: "auto" | 0 | 1;
  /** Full-screen camera for the opening line and the sign-off. */
  bookends?: boolean;
  /** Split screen under long stretches of talk with nothing clicked or zoomed. */
  splitScreen?: boolean;
  /** Screen only under glass loupes too, not just camera zooms. */
  loupesScreenOnly?: boolean;
  /** The project's current config, to tone down a LUT and lift captions over the camera. */
  config?: any;
  /**
   * Whether captions will be on once the plan applies (a recipe or brand may turn
   * them on or off); defaults to the current config's setting.
   */
  captionsOn?: boolean;
}

/** Rules as data: the numbers the director works by. */
export const CAMERA_RULES = {
  minStretchMs: 6000,
  /** Shortest opening line worth showing the person full screen. */
  openingLineMs: 2000,
  /** A bookend shorter than this on screen is dropped. */
  minBookendMs: 2500,
  /** Layout changes at least this far apart in playback (see layout-churn in the pacing check). */
  minChangeGapMs: 5000,
  /** Talk this long with nothing clicked or zoomed gets a split screen. */
  splitAfterMs: 12000,
  /** A boundary sits this far into the silence around a sentence, at most. */
  gapPadMs: 250,
  /** A zoom's screen-only stretch moves each edge to a sentence boundary at most this far away. */
  zoomSnapMs: 1500,
  /** ...and grows by at most this much in all. */
  zoomWidenMs: 3000,
  /** A click with no screen change this soon after is stray: the opening line may cover it. */
  strayClickMs: 2000,
  /** A screen change this soon before a click may hold the click's answer (changes within 400ms merge into the first). */
  changeMergeMs: 400,
  /** The opening line stops gathering sentences at a pause longer than this. */
  openingPauseMs: 600,
  /** ...and never runs longer than openingLineMs plus this. */
  openingExtraMs: 3000,
  cutout: { size: 0.6, zoomedScale: 0.5 },
  maxLutIntensity: 0.4,
};

/** Which stretch wins when two collide: the one that shows more of the screen. */
const SCREEN_PRIORITY: Record<LayoutType, number> = {
  "screen-only": 3,
  "split-screen": 2,
  "fullscreen-camera": 1,
};

const DESCRIBE: Record<LayoutType, string> = {
  "fullscreen-camera": "you full screen",
  "screen-only": "screen only",
  "split-screen": "split screen",
};

type Sentence = Span & { text: string };

/** Boundaries land in the silence between sentences, never inside one. */
function snapper(sentences: Sentence[]) {
  const inside = (t: number) => sentences.findIndex((p) => t > p.startMs && t < p.endMs);
  const pad = (gap: number) => Math.min(CAMERA_RULES.gapPadMs, Math.max(0, gap) / 2);
  /** The pause before sentence i, and the one after it. */
  const before = (i: number) =>
    sentences[i].startMs - pad(sentences[i].startMs - (sentences[i - 1]?.endMs ?? 0));
  const after = (i: number, end: number) =>
    sentences[i].endMs + pad((sentences[i + 1]?.startMs ?? end) - sentences[i].endMs);
  return {
    before(t: number) {
      const i = inside(t);
      return i < 0 ? t : before(i);
    },
    after(t: number, end: number) {
      const i = inside(t);
      return i < 0 ? t : after(i, end);
    },
    /**
     * Where an edge may go, best first: the edge itself when it is already in a
     * pause; else the pause outside its sentence (before a start edge, after an
     * end edge) and then the one inside it, each only when the sentence starts
     * or ends within `withinMs`; last, the edge itself, mid-sentence.
     */
    options(t: number, edge: "start" | "end", end: number, withinMs: number) {
      // With no speech there is no pause to find: the edge stays where it is.
      if (!sentences.length) return [{ at: t, quiet: false }];
      const i = inside(t);
      if (i < 0) return [{ at: t, quiet: true }];
      const p = sentences[i];
      const early = { at: before(i), d: t - p.startMs };
      const late = { at: after(i, end), d: p.endMs - t };
      return [...(edge === "start" ? [early, late] : [late, early])]
        .filter((o) => o.d <= withinMs)
        .map((o) => ({ at: o.at, quiet: true }))
        .concat({ at: t, quiet: false });
    },
  };
}

/**
 * The screen-only stretch for a zoom: each edge moves out to the pause between
 * sentences when one is within 1.5s (in, when only that one is), and the
 * stretch grows by at most 3s, so a long sentence never hides the camera for
 * long. An edge with no pause that close stays where the zoom is.
 */
function zoomStretch(z: Span, snap: ReturnType<typeof snapper>, end: number) {
  const { zoomSnapMs, zoomWidenMs } = CAMERA_RULES;
  const starts = snap.options(z.startMs, "start", end, zoomSnapMs);
  const ends = snap.options(z.endMs, "end", end, zoomSnapMs);
  // Never longer than the zoom plus 3s, and never so much shorter that it is too
  // short for a layout change and gets dropped.
  const length = z.endMs - z.startMs;
  const fits = (s: number, e: number) =>
    e > s && e - s <= length + zoomWidenMs && e - s >= Math.min(length, CAMERA_RULES.minChangeGapMs);
  // The best pair that fits: fewest fallbacks first, then the earliest start.
  for (let rank = 0; rank <= starts.length + ends.length - 2; rank++)
    for (let i = 0; i <= rank; i++) {
      const s = starts[i];
      const e = ends[rank - i];
      if (s && e && fits(s.at, e.at)) return { startMs: s.at, endMs: e.at, snapped: s.quiet && e.quiet };
    }
  return { ...z, snapped: false };
}

/**
 * Plans camera layouts over an edit (its slices and zooms) from the speech and
 * clicks: you full screen for the opening line and the sign-off, screen only
 * while a zoom asks the viewer to read, split screen under a long talk with
 * nothing on screen to follow, and the cutout camera everywhere else, on the
 * side away from the clicks. Returns the ops, the config, and notes in
 * playback time saying why.
 */
export function planLayouts(
  a: Pick<Analysis, "speech" | "sentences" | "clicks" | "sourceDurationMs" | "hasCamera"> &
    Partial<Pick<Analysis, "screen" | "typing" | "shortcuts">>,
  edit: {
    slices: Slice[];
    zooms: Pick<Zoom, "sourceStartMs" | "sourceEndMs" | "presentation" | "isDisabled">[];
  },
  opts: CameraOptions = {},
) {
  const minStretch = opts.minStretchMs ?? CAMERA_RULES.minStretchMs;
  // Two changes closer than the gap between changes read as churn, whatever minStretchMs says.
  const minGap = Math.max(minStretch, CAMERA_RULES.minChangeGapMs);
  // Bookends and boundaries follow sentences; split screen follows phrases, the longer runs of talk.
  const sentences = sentencesOf(a);
  const phrases = a.speech ? [...a.speech].sort((x, y) => x.startMs - y.startMs) : sentences;
  const clicks = a.clicks.filter((c) => c.atMs < a.sourceDurationMs - STOP_CLICK_MS);
  const slices = [...edit.slices].sort((x, y) => x.sourceStartMs - y.sourceStartMs);
  const videoStart = slices[0]?.sourceStartMs ?? 0;
  const videoEnd = slices.at(-1)?.sourceEndMs ?? a.sourceDurationMs;
  const snap = snapper(sentences);
  const at = (sourceMs: number) => clock(toPlaybackNearest(slices, sourceMs));
  const visible = (s: Span) => playbackRange(slices, s.startMs, s.endMs)?.visibleMs ?? 0;
  const notes: string[] = [];

  // Side: away from where the clicks land.
  const meanX = clicks.length ? clicks.reduce((n, c) => n + c.x, 0) / clicks.length : null;
  const side = opts.side === 0 || opts.side === 1 ? opts.side : meanX !== null && meanX > 0.5 ? 0 : 1;
  const sideName = side === 1 ? "right" : "left";
  const sideWhy =
    opts.side === 0 || opts.side === 1
      ? "as asked"
      : meanX === null
        ? "no clicks to avoid"
        : `clicks are on the ${meanX > 0.5 ? "right" : "left"}`;

  if (a.hasCamera === false)
    return {
      stretches: [] as LayoutStretch[],
      side,
      config: {} as Record<string, unknown>,
      layoutOps: [] as { op: "addLayout"; startMs: number; endMs: number; type: LayoutType }[],
      ops: [] as never[],
      notes: ["No camera in this recording, so no layouts were planned: there is no one to show."],
    };

  let stretches: LayoutStretch[] = [];
  // Bookends follow what the viewer hears: the first and last lines still in the edit.
  const heard = sentences.filter((x) => visible(x) >= (x.endMs - x.startMs) / 2);
  const shownClicks = clicks.filter((c) => visible({ startMs: c.atMs, endMs: c.atMs + 1 }) > 0);
  // A click the viewer needs to see is one the screen answers, or one typing
  // follows; a stray click changes nothing. Where the screen could not be read
  // (no analysis, or that session's video failed), every click counts.
  const { strayClickMs, changeMergeMs } = CAMERA_RULES;
  const screen = a.screen;
  const unknown = (t: number) =>
    !screen ||
    (!!screen.unavailable && !screen.unread) ||
    !!screen.unread?.some((u) => t >= u.startMs && t <= u.endMs);
  const meaningful = shownClicks.filter(
    (c) =>
      unknown(c.atMs) ||
      screen!.changes.some((x) => x.atMs >= c.atMs - changeMergeMs && x.atMs - c.atMs <= strayClickMs) ||
      screen!.active.some((x) => x.endMs > c.atMs && x.startMs <= c.atMs + strayClickMs) ||
      (a.typing ?? []).some((t) => t.startMs >= c.atMs && t.startMs - c.atMs <= strayClickMs),
  );
  /** Something happens on screen in [from, to]: typing, a shortcut, a screen change. */
  const happens = (from: number, to: number) =>
    (a.typing ?? []).some((t) => t.startMs <= to && t.endMs >= from) ||
    (a.shortcuts ?? []).some((k) => k.atMs >= from && k.atMs <= to) ||
    !!screen?.changes.some((x) => x.atMs >= from && x.atMs <= to);
  const firstHappening = Math.min(
    Infinity,
    ...(a.typing ?? []).map((t) => t.startMs),
    ...(a.shortcuts ?? []).map((k) => k.atMs),
    ...(screen?.changes ?? []).map((x) => x.atMs),
  );
  const zooms = edit.zooms.filter((z) => !z.isDisabled);
  const firstClick = Math.min(Infinity, ...meaningful.map((c) => c.atMs));
  const lastClick = Math.max(-Infinity, ...meaningful.map((c) => c.atMs));
  const clamped = (s: LayoutStretch) =>
    Math.min(videoEnd, s.sourceEndMs) <= Math.max(videoStart, s.sourceStartMs);
  if (opts.bookends !== false && heard.length) {
    const first = heard[0];
    // The opening line: the first sentences that end before anything is clicked,
    // until they make a line worth showing. It stops at a long pause, at anything
    // happening on screen, and a few seconds past the shortest line worth showing.
    const { openingLineMs, openingPauseMs, openingExtraMs } = CAMERA_RULES;
    let lineEnd: number | null = null;
    for (const s of heard) {
      if (s.endMs > firstClick) break;
      if (
        lineEnd !== null &&
        (s.startMs - lineEnd > openingPauseMs ||
          happens(lineEnd, s.endMs) ||
          s.endMs - first.startMs > openingLineMs + openingExtraMs)
      )
        break;
      lineEnd = s.endMs;
      if (lineEnd - first.startMs >= openingLineMs) break;
    }
    // The first line runs over the first click: the opening may run until just
    // before it, and before anything else happens on screen.
    const runsOver = firstClick < Infinity && first.startMs < firstClick && first.endMs > firstClick;
    const beforeClick = {
      startMs: videoStart,
      endMs: Math.min(firstClick, firstHappening) - 100,
    };
    if (first.startMs >= firstClick)
      notes.push(
        "No full-screen opening: the first line starts after a click, and the viewer needs to see it.",
      );
    else if (lineEnd !== null && lineEnd - first.startMs >= CAMERA_RULES.openingLineMs)
      stretches.push({
        sourceStartMs: videoStart,
        sourceEndMs: Math.max(lineEnd, Math.min(snap.after(lineEnd - 1, videoEnd), firstClick - 100)),
        type: "fullscreen-camera",
        reason: `for the opening line (${secs(lineEnd - first.startMs)}), before anything is clicked${
          shownClicks.some((c) => c.atMs < lineEnd!)
            ? ` that changes the screen (a stray click at ${at(shownClicks[0].atMs)} changes nothing)`
            : ""
        }`,
      });
    // The first line runs over a click: open on it until just before the click, when that is long enough.
    else if (runsOver && visible(beforeClick) >= CAMERA_RULES.minBookendMs)
      stretches.push({
        sourceStartMs: videoStart,
        sourceEndMs: beforeClick.endMs,
        type: "fullscreen-camera",
        reason: `for the opening line, until just before the first click at ${at(firstClick)}`,
      });
    else
      notes.push(
        runsOver
          ? "No full-screen opening: the first line runs over a click, and the viewer needs to see it."
          : "No full-screen opening: the first line is under 2s.",
      );
    // The sign-off: the last sentences after the last click, enough of them to hold the shot.
    let signOff: number | null = null;
    for (let i = heard.length - 1; i >= 1 && heard[i].startMs > lastClick; i--) {
      signOff = heard[i].startMs;
      if (visible({ startMs: signOff, endMs: videoEnd }) >= CAMERA_RULES.minBookendMs) break;
    }
    if (signOff !== null)
      stretches.push({
        sourceStartMs: snap.before(signOff + 1),
        sourceEndMs: videoEnd,
        type: "fullscreen-camera",
        reason: "for the sign-off, with nothing left to click",
      });
  }
  for (const z of zooms) {
    const loupe = z.presentation === "loupe";
    if (loupe && !opts.loupesScreenOnly) continue;
    const s = zoomStretch({ startMs: z.sourceStartMs, endMs: z.sourceEndMs }, snap, videoEnd);
    stretches.push({
      sourceStartMs: s.startMs,
      sourceEndMs: s.endMs,
      type: "screen-only",
      reason: `while the ${loupe ? "loupe" : "zoom"} asks the viewer to read, ${
        !sentences.length
          ? `held to the ${loupe ? "loupe" : "zoom"} (no speech to follow)`
          : s.snapped
            ? "widened to the pauses between sentences around it"
            : `held to the ${loupe ? "loupe" : "zoom"} where no pause between sentences is within ${secs(CAMERA_RULES.zoomSnapMs)}`
      }`,
    });
  }
  if (opts.splitScreen !== false)
    for (const p of phrases) {
      const busy =
        clicks.some((c) => c.atMs >= p.startMs && c.atMs <= p.endMs) ||
        edit.zooms.some((z) => z.sourceStartMs < p.endMs && z.sourceEndMs > p.startMs);
      if (p.endMs - p.startMs > CAMERA_RULES.splitAfterMs && !busy)
        stretches.push({
          sourceStartMs: snap.before(p.startMs + 1),
          sourceEndMs: snap.after(p.endMs - 1, videoEnd),
          type: "split-screen",
          reason: `under ${secs(p.endMs - p.startMs)} of talk with nothing clicked or zoomed`,
        });
    }
  for (const s of stretches)
    if (s.type === "fullscreen-camera" && clamped(s))
      notes.push(`No full-screen camera ${s.reason}: that line is cut from the edit.`);
  stretches = stretches
    .map((s) => ({
      ...s,
      sourceStartMs: Math.max(videoStart, s.sourceStartMs),
      sourceEndMs: Math.min(videoEnd, s.sourceEndMs),
    }))
    .filter((s) => s.sourceEndMs > s.sourceStartMs)
    .sort((x, y) => x.sourceStartMs - y.sourceStartMs);

  const dropped: string[] = [];
  const span = (s: LayoutStretch) => ({ startMs: s.sourceStartMs, endMs: s.sourceEndMs });
  const p = (sourceMs: number) => toPlaybackNearest(slices, sourceMs);
  const playbackEnd = p(videoEnd);
  const isBookend = (s: LayoutStretch) => p(s.sourceStartMs) <= 50 || p(s.sourceEndMs) >= playbackEnd - 50;
  // Resolve in an order where later steps only ever lengthen stretches:
  // 1. same-type neighbours closer than minStretchMs (at least 5s) join into one;
  // 2. where different types overlap, the one that shows more of the screen keeps its range;
  // 3. stretches too short to be worth a change go (a bookend needs 2.5s on screen;
  //    a stretch in the middle brings two changes, so it needs the full gap between changes);
  // 4. a gap shorter than that joins a neighbour, so the default layout never
  //    flashes up for a moment: the one showing more screen when something is clicked
  //    in the gap, else the one showing more of the person;
  // 5. the first and last stretch reach the video's edges when they stop short of
  //    them by less than that, so the cutout camera never shows for a moment there.
  // Length checks run first on the untrimmed stretches, and a stretch trimmed to
  // make room for one that is later dropped gets its range back.
  const neighbours = (fn: (x: LayoutStretch, y: LayoutStretch, i: number) => boolean) => {
    for (let i = 0; i < stretches.length - 1; i++) if (fn(stretches[i], stretches[i + 1], i)) return true;
    return false;
  };
  const close = (x: LayoutStretch, y: LayoutStretch) => p(y.sourceStartMs) - p(x.sourceEndMs) < minGap;
  /** Two full-screen camera stretches with a click the viewer needs to see between them. */
  const hidesClick = (x: LayoutStretch, y: LayoutStretch) =>
    x.type === "fullscreen-camera" &&
    y.type === "fullscreen-camera" &&
    meaningful.some((c) => c.atMs >= x.sourceEndMs && c.atMs <= y.sourceStartMs);
  const wins = (x: LayoutStretch, y: LayoutStretch) => SCREEN_PRIORITY[x.type] > SCREEN_PRIORITY[y.type];
  /** Trims made in step 2: undone when the stretch that won is dropped. */
  const trims: {
    loser: LayoutStretch;
    edge: "sourceStartMs" | "sourceEndMs";
    was: number;
    winner: LayoutStretch;
  }[] = [];
  const trim = (
    loser: LayoutStretch,
    edge: "sourceStartMs" | "sourceEndMs",
    to: number,
    winner: LayoutStretch,
  ) => {
    trims.push({ loser, edge, was: loser[edge], winner });
    loser[edge] = to;
  };
  const merge = () =>
    neighbours((x, y, i) => {
      if (x.type !== y.type || !close(x, y) || hidesClick(x, y)) return false;
      x.sourceEndMs = Math.max(x.sourceEndMs, y.sourceEndMs);
      if (!x.reason.includes(y.reason)) x.reason = `${x.reason}; ${y.reason}`;
      stretches.splice(i + 1, 1);
      for (const t of trims) if (t.winner === y) t.winner = x;
      for (let k = trims.length - 1; k >= 0; k--) if (trims[k].loser === y) trims.splice(k, 1);
      return true;
    });
  const dropShort = () => {
    const short = stretches.findIndex(
      (s) =>
        s.sourceEndMs <= s.sourceStartMs ||
        visible(span(s)) < (isBookend(s) ? CAMERA_RULES.minBookendMs : CAMERA_RULES.minChangeGapMs),
    );
    if (short < 0) return false;
    const s = stretches[short];
    if (s.sourceEndMs > s.sourceStartMs)
      dropped.push(
        `No ${DESCRIBE[s.type]} at ${at(s.sourceStartMs)}: it would last ${secs(visible(span(s)))}, too short for a layout change.`,
      );
    stretches.splice(short, 1);
    // Whatever made room for it gets its range back.
    for (let k = trims.length - 1; k >= 0; k--) {
      const t = trims[k];
      if (t.winner !== s) continue;
      t.loser[t.edge] = t.was;
      if (!stretches.includes(t.loser)) stretches.push(t.loser);
      trims.splice(k, 1);
    }
    return true;
  };
  const steps = [
    merge,
    () =>
      neighbours((x, y) => {
        if (y.sourceStartMs >= x.sourceEndMs) return false;
        if (wins(y, x)) trim(x, "sourceEndMs", y.sourceStartMs, y);
        else trim(y, "sourceStartMs", x.sourceEndMs, x);
        return true;
      }),
    dropShort,
    () =>
      neighbours((x, y) => {
        if (y.sourceStartMs === x.sourceEndMs || !close(x, y)) return false;
        // Joining them would hide the click under the camera: the shorter one goes.
        if (hidesClick(x, y)) {
          const gone = visible(span(x)) < visible(span(y)) ? x : y;
          const click = meaningful.find((c) => c.atMs >= x.sourceEndMs && c.atMs <= y.sourceStartMs)!;
          dropped.push(
            `No ${DESCRIBE[gone.type]} at ${at(gone.sourceStartMs)}: it would sit too close to the next full-screen camera, and joining them would hide the click at ${at(click.atMs)}.`,
          );
          stretches.splice(stretches.indexOf(gone), 1);
          return true;
        }
        const clicked = clicks.some((c) => c.atMs >= x.sourceEndMs && c.atMs <= y.sourceStartMs);
        if (wins(y, x) === clicked) y.sourceStartMs = x.sourceEndMs;
        else x.sourceEndMs = y.sourceStartMs;
        return true;
      }),
    () => {
      const first = stretches[0];
      const last = stretches.at(-1);
      // A full-screen camera never reaches over a click the viewer needs to see.
      const covers = (s: LayoutStretch, from: number, to: number) =>
        s.type === "fullscreen-camera" && meaningful.some((c) => c.atMs >= from && c.atMs <= to);
      if (
        first &&
        first.sourceStartMs > videoStart &&
        p(first.sourceStartMs) < minGap &&
        !covers(first, videoStart, first.sourceStartMs)
      ) {
        first.sourceStartMs = videoStart;
        return true;
      }
      if (
        last &&
        last.sourceEndMs < videoEnd &&
        playbackEnd - p(last.sourceEndMs) < minGap &&
        !covers(last, last.sourceEndMs, videoEnd)
      ) {
        last.sourceEndMs = videoEnd;
        return true;
      }
      return false;
    },
  ];
  const sorted = () => stretches.sort((x, y) => x.sourceStartMs - y.sourceStartMs);
  // Untrimmed first: join same-type neighbours and drop what is too short on its own.
  while (sorted() && (merge() || dropShort()));
  // Each pass makes one change; the budget grows with the timeline, so long ones finish.
  const budget = 10 * stretches.length + 50;
  let passes = 0;
  for (; passes < budget; passes++) {
    sorted();
    if (!steps.some((step) => step())) break;
  }
  if (passes >= budget)
    notes.push(
      `Stopped resolving layouts after ${budget} steps; some stretches may sit closer than ${secs(minGap)}. Check the layout issues.`,
    );

  const config: Record<string, unknown> = {
    "defaultLayout.type": "cutout-camera",
    "defaultLayout.cutoutCamera.cutoutCameraSizeRatio01": CAMERA_RULES.cutout.size,
    "defaultLayout.cutoutCamera.cutoutCameraZoomedScale": CAMERA_RULES.cutout.zoomedScale,
    "defaultLayout.cutoutCamera.cutoutCameraPositionX01": side,
    "camera.enableFaceTracking": true,
    "camera.background.edgeFalloff01": 0.4,
    "camera.hideDuringSilenceMs": null,
  };
  const cam = opts.config?.camera;
  if (cam?.lut && typeof cam.lutIntensity === "number")
    config["camera.lutIntensity"] = Math.min(cam.lutIntensity, CAMERA_RULES.maxLutIntensity);
  if (opts.captionsOn ?? opts.config?.captions?.enableTranscript)
    config["captions.position01"] = { x: 0.5, y: 0.93 };

  const rounded = stretches.map((s) => ({
    ...s,
    sourceStartMs: round(s.sourceStartMs),
    sourceEndMs: round(s.sourceEndMs),
  }));
  const layoutOps = rounded.map((s) => ({
    op: "addLayout" as const,
    startMs: s.sourceStartMs,
    endMs: s.sourceEndMs,
    type: s.type,
  }));

  notes.unshift(
    `${at(videoStart)} cutout camera on the ${sideName} (${sideWhy}), ${CAMERA_RULES.cutout.size} of the frame, shrinking to ${CAMERA_RULES.cutout.zoomedScale} under zooms. It is the default layout, so it needs no stretch of its own.`,
  );
  for (const [i, s] of rounded.entries()) {
    const len = visible({ startMs: s.sourceStartMs, endMs: s.sourceEndMs });
    notes.push(`${at(s.sourceStartMs)} ${DESCRIBE[s.type]} ${s.reason} (${secs(len)}).`);
    const next = rounded[i + 1];
    if (s.sourceEndMs < videoEnd - 50 && (!next || next.sourceStartMs > s.sourceEndMs))
      notes.push(
        `${at(s.sourceEndMs)} back to the cutout camera${!sentences.length ? "" : snap.after(s.sourceEndMs, videoEnd) === s.sourceEndMs ? ", in the pause after the sentence" : ", mid-sentence"}.`,
      );
  }
  notes.push(...dropped);
  if (!sentences.length)
    notes.push("No speech in the transcript, so layouts cannot follow sentences; only zooms were used.");
  if (cam?.lut && config["camera.lutIntensity"] !== undefined)
    notes.push(`The LUT runs at ${config["camera.lutIntensity"]}: a look, not a filter.`);
  // Edges on a zoom or just before a click may have had no pause to land in: say so.
  const midSentence = rounded
    .flatMap((s) => [s.sourceStartMs, s.sourceEndMs])
    .filter((t) => t > videoStart + 50 && t < videoEnd - 50)
    .filter((t) => sentences.some((x) => t > x.startMs + 150 && t < x.endMs - 150));
  if (!sentences.length) notes.push(`Layout changes sit at least ${secs(minGap)} apart.`);
  else if (!midSentence.length)
    notes.push(
      `Layout changes land in the silence between sentences and at least ${secs(minGap)} apart, so the viewer is never jolted mid-word.`,
    );
  else
    notes.push(
      `Layout changes sit at least ${secs(minGap)} apart and land between sentences, except at ${[...new Set(midSentence.map(at))].join(", ")}: a zoom or a click there left no pause close enough, so the change comes mid-sentence.`,
    );

  return {
    stretches: rounded,
    side,
    config,
    layoutOps,
    ops: [
      { op: "clearTrack" as const, track: "layouts" as const },
      ...layoutOps,
      { op: "config" as const, changes: config },
    ],
    notes,
  };
}
