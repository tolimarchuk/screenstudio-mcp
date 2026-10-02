// Editing judgment as code: a pacing check for any timeline, in playback time,
// and a visual-settings check for settings that look wrong on screen.
import type { Analysis } from "./recording.js";
import {
  SPRINGS,
  mapSlices,
  playbackDuration,
  playbackRange,
  round,
  springSettleMs,
  toPlayback,
  toPlaybackNearest,
  type Slice,
  type Spring,
  type Zoom,
} from "./timeline.js";
import { DEFAULT_STYLE, STYLES, type PacingRules, type Style } from "./styles.js";
import { overlaps, type Span } from "./spans.js";
import { quietValley } from "./audio.js";
import type { Recipe } from "./recipes.js";

export interface Issue {
  severity: "error" | "warn" | "info";
  code: string;
  message: string;
  atPlaybackMs?: number;
  zoomId?: string;
}

export interface PacingReport {
  verdict: "good" | "needs work" | "too fast";
  sourceMs: number;
  playbackMs: number;
  cuts: number;
  speedChanges: number;
  zooms: number;
  zoomsPerMinute: number;
  zoomTransitionMs: number;
  issues: Issue[];
}

export const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** A playback moment the way an editor's timeline shows it: 0:07, 1:32. */
export const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Layout changes closer than this in playback feel like the camera can't sit still. */
export const LAYOUT_CHANGE_GAP_MS = 5000;

/** A camera layout stretch on the timeline. */
export interface LayoutSpan {
  sourceStartMs: number;
  sourceEndMs: number;
  type?: string;
  isDisabled?: boolean;
}

/** Screen Studio's own stop click lands in the last second of every recording; it is not part of the demo. */
export const STOP_CLICK_MS = 1000;

/** Jump cuts inside a talk per 10s of playback; cuts between scenes follow the style's cutsPer10s. */
export const CUTS_PER_10S = { talking: 3 };

/** Speed changes read as ramping past this many per 10s of playback (and more than two in all). */
export const SPEED_CHANGES_PER_10S = 1.5;
export const speedRamping = (changes: number, playbackMs: number) =>
  playbackMs > 0 && (changes / playbackMs) * 10000 > SPEED_CHANGES_PER_10S && changes > 2;

/** Shortest zoom worth its two transitions. */
export const shortZoomMs = (rules: PacingRules) => Math.min(2500, rules.zoomMinMs);

/**
 * How close a cut edge must be to a quiet valley's middle to count as placed on
 * it: the editor may move an edge to a frame (17ms at 60fps).
 */
const VALLEY_SNAP_MS = 20;

/** Silence the speaker keeps on each side of a jump cut. */
const BREATH_MS = 1000;

/**
 * A jump cut inside a talk removes a filler word, or only the silence between
 * two phrases with a breath kept on each side. It reads as one take, so it may
 * come more often than a cut between scenes.
 */
export function isTalkingCut(fromMs: number, toMs: number, speech: Span[] = [], fillers: Span[] = []) {
  if (fillers.some((f) => fromMs >= f.startMs - 100 && toMs <= f.endMs + 100)) return true;
  return (
    !overlaps({ startMs: fromMs, endMs: toMs }, speech) &&
    speech.some((p) => p.endMs <= fromMs && fromMs - p.endMs <= BREATH_MS) &&
    speech.some((p) => p.startMs >= toMs && p.startMs - toMs <= BREATH_MS)
  );
}

/** Errors with these codes mean the edit moves faster than a viewer can follow. */
const TOO_FAST_CODES = ["choppy", "fast-action", "short-zoom", "zoom-ping-pong"];

const issue = (
  severity: Issue["severity"],
  code: string,
  message: string,
  extra?: Pick<Issue, "atPlaybackMs" | "zoomId">,
): Issue => ({ severity, code, message, ...extra });

export function checkPacing(
  input: { slices: Slice[]; zooms: Zoom[]; screenSpring?: Spring; config?: any; layouts?: LayoutSpan[] },
  analysis?: Pick<Analysis, "clicks" | "typing" | "sourceDurationMs"> &
    Partial<Pick<Analysis, "capture" | "speech" | "sentences" | "fillers" | "valleys">>,
  style: Style = DEFAULT_STYLE,
  /** Rule overrides (a recipe's) and the recipe the look is judged against. */
  extra: { rules?: Partial<PacingRules>; recipe?: Pick<Recipe, "name" | "config"> } = {},
): PacingReport {
  const rules = { ...STYLES[style], ...extra.rules };
  const issues: Issue[] = [];
  const slices = mapSlices(input.slices);
  const playbackMs = playbackDuration(input.slices);
  const sourceMs = slices.length ? Math.max(...slices.map((x) => x.sourceEndMs)) : 0;
  const spring = input.screenSpring ?? SPRINGS.schemaDefault;
  const transitionMs = springSettleMs(spring);
  if (spring.stiffness / spring.mass > 70 && spring.damping / spring.mass < 10)
    issues.push(
      issue(
        "warn",
        "snappy-spring",
        `The zoom spring (${spring.stiffness}/${spring.damping}/${spring.mass}) snaps into place in ${secs(transitionMs)}. Use Screen Studio's Smooth preset (170/50/3) for calm zooms.`,
      ),
    );

  // Cuts and speed ramps. Jump cuts inside a talk are judged on their own.
  // Cuts and layout changes are judged against sentences: a long phrase holds
  // several, and the pause between two of them is a clean place to cut.
  const said = analysis?.sentences ?? analysis?.speech ?? [];
  const fillers = analysis?.fillers ?? [];
  let cuts = 0;
  let talkingCuts = 0;
  let speedChanges = 0;
  for (let i = 0; i < slices.length; i++) {
    const sl = slices[i];
    const len = sl.playbackEndMs - sl.playbackStartMs;
    const prev = slices[i - 1];
    if (prev && Math.abs(prev.sourceEndMs - sl.sourceStartMs) > 50) {
      if (isTalkingCut(prev.sourceEndMs, sl.sourceStartMs, said, fillers)) talkingCuts++;
      else cuts++;
    }
    if (prev && Math.abs(prev.speed - sl.speed) > 0.01) speedChanges++;
    if (round(len) < 1000 && slices.length > 1)
      issues.push(
        issue(
          "warn",
          "short-clip",
          `Clip at ${secs(sl.playbackStartMs)} is on screen for only ${secs(len)}. Merge it with a neighbour or keep more of it.`,
          { atPlaybackMs: round(sl.playbackStartMs) },
        ),
      );
    if (sl.speed > 4)
      issues.push(
        issue(
          "warn",
          "very-fast",
          `Clip at ${secs(sl.playbackStartMs)} plays at ${sl.speed.toFixed(1)}x. Cut it instead of racing through it.`,
          { atPlaybackMs: round(sl.playbackStartMs) },
        ),
      );
  }
  if (playbackMs > 0) {
    const perTen = (cuts / playbackMs) * 10000;
    if (perTen > rules.cutsPer10s && cuts > 1)
      issues.push(
        issue(
          perTen > rules.maxCutsPer10s ? "error" : "warn",
          "choppy",
          `${cuts} cuts in ${secs(playbackMs)} (${perTen.toFixed(1)} per 10s). Viewers lose their place. Keep to about one cut every ${secs(10000 / rules.cutsPer10s)}; merge beats separated by short pauses.`,
        ),
      );
    const talkPerTen = (talkingCuts / playbackMs) * 10000;
    if (talkPerTen > CUTS_PER_10S.talking && talkingCuts > 2)
      issues.push(
        issue(
          "warn",
          "jumpy-talk",
          `${talkingCuts} jump cuts in the talk in ${secs(playbackMs)} (${talkPerTen.toFixed(1)} per 10s). Leave some pauses in so the speaker can breathe.`,
        ),
      );
    if (speedRamping(speedChanges, playbackMs))
      issues.push(
        issue(
          "warn",
          "speed-ramping",
          `Speed changes ${speedChanges} times in ${secs(playbackMs)}. Constant speed reads calmer; speed up only typing and waiting.`,
        ),
      );
  }

  // Actions must play at a followable speed.
  if (analysis) {
    for (const c of analysis.clicks.filter((c) => c.atMs < analysis.sourceDurationMs - STOP_CLICK_MS)) {
      const sl = slices.find((x) => c.atMs >= x.sourceStartMs && c.atMs <= x.sourceEndMs);
      if (sl && sl.speed > rules.maxActionSpeed + 0.01)
        issues.push(
          issue(
            sl.speed > 1.5 ? "error" : "warn",
            "fast-action",
            `A click at ${secs(toPlayback(input.slices, c.atMs)!)} plays at ${sl.speed.toFixed(2)}x. Keep clicks at ${rules.maxActionSpeed}x so the viewer can follow the cursor.`,
            { atPlaybackMs: round(toPlayback(input.slices, c.atMs)!) },
          ),
        );
    }
    for (const p of analysis.speech ?? []) {
      const fast = slices.find(
        (x) => x.speed > 1.05 && x.sourceStartMs < p.endMs && x.sourceEndMs > p.startMs,
      );
      if (fast)
        issues.push(
          issue(
            "error",
            "fast-speech",
            `Speech "${p.text.slice(0, 40)}" plays at ${fast.speed.toFixed(2)}x. Never speed up someone talking; cut around it instead.`,
            { atPlaybackMs: round(fast.playbackStartMs) },
          ),
        );
    }
    // A cut edge in the middle of a quiet audio valley sits between two sentences,
    // whatever the recognizer's word edges say.
    const onValley = (t: number) =>
      (analysis.valleys ?? []).some((v) => quietValley(v) && Math.abs(v.atMs - t) <= VALLEY_SNAP_MS);
    for (const p of said) {
      for (let i = 1; i < slices.length; i++) {
        const cutAt = slices[i - 1].sourceEndMs;
        const resume = slices[i].sourceStartMs;
        const removed = { startMs: cutAt, endMs: resume };
        if (
          resume - cutAt > 50 &&
          cutAt > p.startMs + 150 &&
          cutAt < p.endMs - 150 &&
          !overlaps(removed, fillers) &&
          !onValley(cutAt)
        )
          issues.push(
            issue(
              "warn",
              "mid-phrase-cut",
              `A cut at ${secs(slices[i].playbackStartMs)} lands inside "${p.text.slice(0, 40)}". Cut in the pause before or after the sentence.`,
              { atPlaybackMs: round(slices[i].playbackStartMs) },
            ),
          );
      }
    }
    // Between two sentences of one phrase the pause is short: a cut there needs a
    // breath on each side, as recognizer word edges are often 100ms off.
    if (analysis.sentences?.length && analysis.speech?.length)
      for (let i = 1; i < slices.length; i++) {
        const cutAt = slices[i - 1].sourceEndMs;
        const resume = slices[i].sourceStartMs;
        if (resume - cutAt <= 50 || overlaps({ startMs: cutAt, endMs: resume }, fillers)) continue;
        const inPhrase = (t: number) => analysis.speech!.some((p) => t > p.startMs && t < p.endMs);
        const clipsEnd =
          inPhrase(cutAt) &&
          !onValley(cutAt) &&
          said.some((s) => cutAt >= s.endMs - 150 && cutAt - s.endMs < 100);
        const clipsStart =
          inPhrase(resume) &&
          !onValley(resume) &&
          said.some((s) => resume <= s.startMs + 150 && s.startMs - resume < 60);
        if (clipsEnd || clipsStart)
          issues.push(
            issue(
              "warn",
              "tight-cut",
              `A cut at ${secs(slices[i].playbackStartMs)} sits right on a word between two sentences, with no breath around it, so a syllable may clip. Leave about 120ms after the last word and 80ms before the next.`,
              { atPlaybackMs: round(slices[i].playbackStartMs) },
            ),
          );
      }
    const stop = analysis.sourceDurationMs - STOP_CLICK_MS;
    // The last playback moment each action is still on screen; an action cut off
    // by the trim ends on the last kept frame, one cut away entirely drops out.
    const visible = [
      ...analysis.clicks.filter((c) => c.atMs < stop).map((c) => [c.atMs, c.endMs]),
      ...analysis.typing.filter((t) => t.startMs < stop).map((t) => [t.startMs, t.endMs]),
    ]
      .map(
        ([a, b]) =>
          playbackRange(input.slices, a, b)?.endMs ??
          toPlayback(input.slices, b) ??
          toPlayback(input.slices, a),
      )
      .filter((p): p is number => p !== null);
    if (visible.length) {
      const lastP = Math.max(...visible);
      if (playbackMs - lastP < 1500)
        issues.push(
          issue(
            "warn",
            "abrupt-ending",
            `The video ends ${secs(playbackMs - lastP)} after the last action. Hold the final result for 2.5-3s.`,
          ),
        );
    }
    const stopClick = analysis.clicks.find((c) => c.atMs >= stop);
    const stopP = stopClick ? toPlayback(input.slices, stopClick.atMs) : null;
    if (stopP !== null)
      issues.push(
        issue(
          "warn",
          "stop-click",
          `The video shows Screen Studio's stop click at ${secs(stopP)}. End the last clip before the cursor heads for it.`,
          { atPlaybackMs: round(stopP) },
        ),
      );
  }

  // Zooms: few, long, separated by real wide shots.
  const zooms = input.zooms
    .filter((z) => !z.isDisabled)
    .map((z) => ({ z, r: playbackRange(input.slices, z.sourceStartMs, z.sourceEndMs) }))
    .filter((x) => x.r)
    .sort((a, b) => a.r!.startMs - b.r!.startMs);
  for (const [i, { z, r }] of zooms.entries()) {
    const visible = r!.visibleMs;
    const hold = visible - 2 * transitionMs;
    const at = round(r!.startMs);
    if (round(visible) < shortZoomMs(rules))
      issues.push(
        issue(
          visible < 2000 ? "error" : "warn",
          "short-zoom",
          `Zoom at ${secs(at)} is on screen ${secs(visible)}; ${secs(Math.max(0, hold))} of that is still. Make it at least ${secs(shortZoomMs(rules))} (Screen Studio's own auto-zooms last 2.8s+) or remove it.`,
          { atPlaybackMs: at, zoomId: z.id },
        ),
      );
    if (z.zoom > 2.2 && z.presentation !== "loupe")
      issues.push(
        issue(
          "warn",
          "deep-zoom",
          `Zoom at ${secs(at)} is ${z.zoom}x. Above 2x text blurs unless the source is 4K; use 1.4-1.8x.`,
          { atPlaybackMs: at, zoomId: z.id },
        ),
      );
    if (z.presentation === "loupe" && (z.zoom < 1.4 || z.zoom > 2.5))
      issues.push(
        issue(
          "info",
          "loupe-depth",
          `Loupe at ${secs(at)} magnifies ${z.zoom}x. A glass loupe reads best at 1.6-2x: shallower looks like a smudge, deeper loses the detail it frames.`,
          { atPlaybackMs: at, zoomId: z.id },
        ),
      );
    if (z.zoom < 1.15)
      issues.push(
        issue(
          "info",
          "shallow-zoom",
          `Zoom at ${secs(at)} is ${z.zoom}x, barely visible. Remove it or go to 1.4x.`,
          { atPlaybackMs: at, zoomId: z.id },
        ),
      );
    if (r!.maxSpeed > 1.3)
      issues.push(
        issue(
          "warn",
          "zoom-on-fast-clip",
          `Zoom at ${secs(at)} sits on a ${r!.maxSpeed.toFixed(1)}x clip. A sped-up clip under a zoom feels rushed.`,
          { atPlaybackMs: at, zoomId: z.id },
        ),
      );
    if (r!.startMs < rules.openingWideMs - 300 && playbackMs > 8000)
      issues.push(
        issue(
          "info",
          "early-zoom",
          `Zoom starts at ${secs(at)}. Open on a wide shot for about ${secs(rules.openingWideMs)} so viewers see where they are.`,
          { atPlaybackMs: at, zoomId: z.id },
        ),
      );
    // Only camera moves need a wide shot between them; a loupe is a lens over a still frame.
    const next =
      z.presentation === "loupe" ? undefined : zooms.slice(i + 1).find((n) => n.z.presentation !== "loupe");
    if (next) {
      const gap = next.r!.startMs - r!.endMs;
      if (gap < rules.zoomWideGapMs)
        issues.push(
          issue(
            gap < 1500 ? "error" : "warn",
            "zoom-ping-pong",
            `Only ${secs(Math.max(0, gap))} of wide shot between zooms at ${secs(at)} and ${secs(next.r!.startMs)}. Merge them into one zoom (it pans between targets) or drop one.`,
            { atPlaybackMs: round(r!.endMs), zoomId: next.z.id },
          ),
        );
    }
  }
  // Camera zooms set the rhythm; loupes are judged on their own (see loupe-overuse).
  const cameraZooms = zooms.filter((x) => x.z.presentation !== "loupe").length;
  const perMinute = playbackMs ? (cameraZooms / playbackMs) * 60000 : 0;
  const allowed = Math.max(1, Math.ceil((rules.zoomsPerMinute * playbackMs) / 60000));
  if (cameraZooms > allowed)
    issues.push(
      issue(
        cameraZooms > allowed + 1 ? "error" : "warn",
        "too-many-zooms",
        `${cameraZooms} camera zooms in ${secs(playbackMs)} (${perMinute.toFixed(1)}/min). Aim for ${allowed} at most: zoom only where the detail matters.`,
      ),
    );
  if (sourceMs > 0 && playbackMs / sourceMs < 0.3 && analysis)
    issues.push(
      issue(
        "info",
        "heavy-compression",
        `${secs(sourceMs)} of footage became ${secs(playbackMs)}. Check that every action still has time to land.`,
      ),
    );
  issues.push(...checkLayouts(input.layouts ?? [], input.slices, said));
  if (input.config) issues.push(...checkStyle(input.config, input.zooms, analysis?.capture, extra.recipe));
  const errors = issues.filter((i) => i.severity === "error").length;
  const warns = issues.filter((i) => i.severity === "warn").length;
  return {
    verdict:
      errors > 0
        ? issues.some((i) => TOO_FAST_CODES.includes(i.code))
          ? "too fast"
          : "needs work"
        : warns > 1
          ? "needs work"
          : "good",
    sourceMs: round(sourceMs),
    playbackMs: round(playbackMs),
    cuts: cuts + talkingCuts,
    speedChanges,
    zooms: zooms.length,
    zoomsPerMinute: Math.round(perMinute * 10) / 10,
    zoomTransitionMs: round(transitionMs),
    issues,
  };
}

/**
 * Camera layouts change on sentence boundaries and not too often. A change is
 * any start or end of a stretch the viewer sees, other than the first and last frame.
 */
export function checkLayouts(
  layouts: LayoutSpan[],
  slices: Slice[],
  speech: (Span & { text?: string })[] = [],
): Issue[] {
  const issues: Issue[] = [];
  const playbackMs = playbackDuration(slices);
  const changes = layouts
    .filter((l) => !l.isDisabled)
    .flatMap((l) => [l.sourceStartMs, l.sourceEndMs])
    // A change in cut footage lands on the next kept frame, where the viewer sees it.
    .map((sourceMs) => ({ sourceMs, at: toPlaybackNearest(slices, sourceMs) }))
    .filter((c) => c.at > 50 && c.at < playbackMs - 50)
    .sort((x, y) => x.at - y.at)
    .filter((c, i, all) => i === 0 || c.at - all[i - 1].at > 50);
  for (const [i, c] of changes.entries()) {
    const next = changes[i + 1];
    if (next && next.at - c.at < LAYOUT_CHANGE_GAP_MS)
      issues.push(
        issue(
          "warn",
          "layout-churn",
          `Camera layout changes at ${secs(c.at)} and again at ${secs(next.at)}. Hold a layout at least ${secs(LAYOUT_CHANGE_GAP_MS)} so the viewer is not jolted; merge the stretches or drop one.`,
          { atPlaybackMs: round(next.at) },
        ),
      );
    const p = speech.find((x) => c.sourceMs > x.startMs + 150 && c.sourceMs < x.endMs - 150);
    if (p)
      issues.push(
        issue(
          "warn",
          "layout-mid-phrase",
          `A layout change at ${secs(c.at)} lands inside "${p.text?.slice(0, 40) ?? "a phrase"}". Move it to the pause before or after the sentence.`,
          { atPlaybackMs: round(c.at) },
        ),
      );
  }
  return issues;
}

// ---------------------------------------------------------------- visual settings

/** Settings that look wrong on screen even when the timing is right. */
export function checkStyle(
  config: any,
  zooms: Zoom[] = [],
  capture?: { widthPt: number; heightPt: number },
  recipe?: Pick<Recipe, "name" | "config">,
): Issue[] {
  const issues: Issue[] = recipe ? offRecipe(config, recipe) : [];
  const out = config?.output ?? {};
  const cursor = config?.cursor ?? {};
  const audio = config?.audio ?? {};
  const anim = config?.animations ?? {};
  const aspect = typeof out.aspectRatio === "number" ? out.aspectRatio : null;
  const source = capture ? capture.widthPt / capture.heightPt : null;
  if (out.avoidEmptyZoomArea && aspect && (!source || Math.abs(aspect - source) > 0.03))
    issues.push(
      issue(
        "warn",
        "fill-crop",
        `"Avoid empty zoom area" is on with a fixed ${aspect.toFixed(2)} frame${source ? ` around a ${source.toFixed(2)} recording` : ""}. Screen Studio then magnifies the screen to fill the frame and pans with the cursor, cropping the top or bottom of every wide shot. Set output.avoidEmptyZoomArea to false.`,
      ),
    );
  if (
    cursor.hideNotMovingAfterMs !== null &&
    cursor.hideNotMovingAfterMs !== undefined &&
    cursor.hideNotMovingAfterMs < 1000
  )
    issues.push(
      issue(
        "warn",
        "cursor-flicker",
        `The cursor hides after ${cursor.hideNotMovingAfterMs}ms still, so it blinks in and out between small moves. Use 1500ms, or 2500ms for narrated videos.`,
      ),
    );
  if (typeof cursor.size === "number" && (cursor.size < 32 || cursor.size > 96))
    issues.push(
      issue(
        "info",
        "cursor-size",
        `Cursor size ${cursor.size} ${cursor.size < 32 ? "gets lost at 1080p" : "covers the UI"}. 48-64 suits a 1440-point window.`,
      ),
    );
  if (audio.clickSoundEffect && audio.clickSoundEffectVolume > 0.5)
    issues.push(
      issue(
        "info",
        "loud-clicks",
        `Click sounds at ${audio.clickSoundEffectVolume} compete with narration and music. 0.25-0.4 is felt more than heard.`,
      ),
    );
  if (typeof anim.motionBlurAmount === "number" && anim.motionBlurAmount > 1.2)
    issues.push(
      issue(
        "info",
        "heavy-blur",
        `Motion blur ${anim.motionBlurAmount} smears text during every pan. 0.4-0.8 keeps motion soft and text readable.`,
      ),
    );
  if (typeof out.paddingRatio01 === "number" && out.paddingRatio01 > 0.15)
    issues.push(
      issue(
        "info",
        "small-screen",
        `Padding ${out.paddingRatio01} shrinks the app; text gets small on phones. 0.05-0.10 keeps the Screen Studio frame without wasting space.`,
      ),
    );
  const loupes = zooms.filter((z) => z.presentation === "loupe" && !z.isDisabled).length;
  if (loupes > 3)
    issues.push(
      issue(
        "info",
        "loupe-overuse",
        `${loupes} loupes. The glass loupe is a special effect; two or three moments that deserve it land harder than many.`,
      ),
    );
  return issues;
}

/**
 * Settings that work against the recipe the edit follows: effects it leaves
 * out on purpose, and a caption style with a different energy.
 */
function offRecipe(config: any, recipe: Pick<Recipe, "name" | "config">): Issue[] {
  const issues: Issue[] = [];
  const want = recipe.config;
  const off = (severity: Issue["severity"], message: string) =>
    issues.push(issue(severity, "off-recipe", `${message} (recipe ${recipe.name}).`));
  if (want["cursor.clickEffect"] === null && config?.cursor?.clickEffect)
    off(
      "warn",
      `Click effect ${config.cursor.clickEffect.type} is on, but this recipe keeps clicks quiet so attention stays on the content. Set cursor.clickEffect to null`,
    );
  if (want["audio.clickSoundEffect"] === null && config?.audio?.clickSoundEffect)
    off(
      "warn",
      `Click sound ${config.audio.clickSoundEffect} is on, but this recipe has no click sounds. Set audio.clickSoundEffect to null`,
    );
  const captions = config?.captions ?? {};
  const reveal = want["captions.wordsReveal"];
  if (captions.enableTranscript && reveal && captions.wordsReveal && captions.wordsReveal !== reveal)
    off(
      reveal === "line-by-line" ? "warn" : "info",
      reveal === "line-by-line"
        ? "Captions reveal word by word, which in Screen Studio shows one word at a time and is hard to follow; this recipe reveals whole lines"
        : "Captions reveal line by line; this recipe reveals them word by word",
    );
  return issues;
}
