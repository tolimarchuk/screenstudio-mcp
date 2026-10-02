// Beats as story units: what each one shows, what it is worth to the viewer,
// its role in the story, and the markers the person dropped while recording.
import type { Analysis } from "./recording.js";
import type { PacingRules } from "./styles.js";
import type { Span } from "./spans.js";

export interface Action {
  kind: "click" | "drag" | "typing" | "shortcut" | "speech";
  startMs: number;
  endMs: number;
  x?: number;
  y?: number;
  label: string;
  /** What is said, for speech. */
  text?: string;
}

/** signoff: talk after the payoff (a closing line); fit-to-length may drop it. */
export type BeatRole = "setup" | "demo" | "payoff" | "signoff";
export type MarkerMode = "ignore" | "keep" | "retake" | "chapters";
type Marker = NonNullable<Analysis["markers"]>[number];

export interface StoryBeat extends Span {
  actions: Action[];
  /** What the beat is worth to the viewer; fit-to-length drops the lowest first. */
  score: number;
  /** The score's parts in plain words, e.g. "typing +3". */
  scoreParts: string[];
  role: BeatRole;
  label: string;
  /** The marker that starts this beat, when markers split the recording. */
  marker?: string;
  chapter?: number;
  /** Lead-in for this beat when it differs from the style's (setup beats in hook-demo-payoff). */
  leadInMs?: number;
}

/** The sentences of the talk, or its phrases when the analysis has no sentences. */
export const sentencesOf = (a: Pick<Analysis, "speech" | "sentences">) =>
  [...(a.sentences ?? a.speech ?? [])].sort((x, y) => x.startMs - y.startMs);

/** Words that carry no meaning in a talk on their own, on top of the stopwords. */
const FILLER_WORDS = new Set(
  (
    "yeah yep yup right basically actually literally really kind sort anyway anyways alright guess " +
    "know mean stuff thing things gonna wanna kinda sorta hmm mm er erm ah huh cool great nice"
  ).split(" "),
);

/**
 * A line that says little. A short line (three words or fewer) only when none
 * of its words carry meaning, so "Ship it!" and "It just works." stand; a longer
 * one when under two of its words carry meaning, or under 30%. Scripts written
 * without spaces (Japanese, Chinese) read as one word and are never judged.
 */
export function fillerLike(text: string) {
  const all = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const meaningful = contentWords(text).filter((w) => !FILLER_WORDS.has(w));
  if (!all.length) return false;
  if (all.length <= 3) return meaningful.length === 0;
  return meaningful.length < 2 || meaningful.length < all.length * 0.3;
}

/** A line that only announces what comes next ("In this video I'll show you..."). */
const SETUP_LINE =
  /^(?:(?:so|okay|ok|alright|right|now|and|well|hey|hi|hello)\b[,.!]?\s*)*(?:today\b|in this (?:video|demo|clip|one)\b|let me (?:show|walk|explain|start|quickly)\b|let's (?:start|begin|take a look|have a look|look|see|get started|dive|jump)\b|i(?:'m| am) going to\b|i(?:'ll| will) (?:show|walk|explain|start)\b|i want to (?:show|walk|talk)\b|we(?:'re| are) going to\b|we(?:'ll| will) (?:start|look|see)\b|before (?:we|i) (?:start|begin|get)\b|here(?:'s| is) (?:how|what)\b|to (?:start|begin)\b)/i;
export const setupLine = (text: string) => SETUP_LINE.test(text.trim());

/**
 * The visible result of a beat: the kinds of screen change landing during it or
 * within the result window. A change at or after the next beat's start is that
 * beat's result, not this one's.
 */
export function resultOf(
  a: Pick<Analysis, "screen">,
  b: Span,
  R: Pick<PacingRules, "resultWindowMs">,
  nextStartMs = Infinity,
) {
  const changes = a.screen.changes.filter(
    (c) => c.atMs >= b.startMs && c.atMs - b.endMs <= R.resultWindowMs && c.atMs < nextStartMs,
  );
  return {
    page: changes.some((c) => c.kind === "page"),
    region: changes.some((c) => c.kind === "region"),
    lastChangeMs: changes.length ? Math.max(...changes.map((c) => c.atMs)) : null,
  };
}

/**
 * Scores, roles and labels. Typing is worth most (it is what a demo shows),
 * then a page that changes because of the beat. The payoff is the last beat
 * that types or changes the screen (the last beat when none does); talk after
 * it is the sign-off, which fit-to-length may drop, and the first beat sets the
 * scene. A beat that is only talk loses value when it says little or only
 * announces what comes next, so fitting a talk to a length drops those
 * sentences first.
 */
export function describeBeats(
  a: Pick<Analysis, "screen">,
  beats: (Span & { actions: Action[]; marker?: string; chapter?: number })[],
  R: Pick<PacingRules, "resultWindowMs">,
): StoryBeat[] {
  // No actions, no beats: nothing to score and no payoff to find.
  if (!beats.length) return [];
  const firstPage = Math.min(
    Infinity,
    ...a.screen.changes.filter((c) => c.kind === "page").map((c) => c.atMs),
  );
  const results = beats.map((b, i) => resultOf(a, b, R, beats[i + 1]?.startMs));
  const shows = (i: number) =>
    beats[i].actions.some((x) => x.kind === "typing") || results[i].page || results[i].region;
  let payoff = beats.length - 1;
  while (payoff > 0 && !shows(payoff)) payoff--;
  if (!shows(payoff)) payoff = beats.length - 1;
  let setupRun = true;
  return beats.map((b, i) => {
    const parts: [string, number][] = [];
    const count = (kind: Action["kind"][]) => b.actions.filter((x) => kind.includes(x.kind)).length;
    const typing = count(["typing"]);
    const clicks = count(["click", "drag", "shortcut"]);
    if (typing) parts.push([`typing ${typing > 1 ? `x${typing} ` : ""}`, 3 * typing]);
    if (clicks) parts.push([`${clicks} click${clicks > 1 ? "s" : ""} `, clicks]);
    const result = results[i];
    if (result.page) parts.push(["page changes ", 4]);
    if (result.region) parts.push(["screen updates ", 2]);
    if (count(["speech"])) parts.push(["speech ", 2]);
    // A beat that is only talk is worth what it says: filler and announcements go first.
    const said = b.actions.filter((x) => x.kind === "speech" && x.text).map((x) => x.text!);
    const talkOnly = said.length === b.actions.length && !result.page && !result.region;
    if (talkOnly && fillerLike(said.join(" "))) parts.push(["says little ", -2]);
    else if (talkOnly && setupLine(said[0])) parts.push(["sets up what follows ", -1]);
    if (i === payoff) parts.push(["the payoff ", 3]);
    else if (i > payoff) parts.push(["signs off after the payoff ", -1]);
    else if (i === 0) parts.push(["the opening ", 1]);
    // Setup: the leading beats before the first page change that type nothing
    // and change nothing; never more than half the beats.
    setupRun &&= !typing && !result.page && !result.region && b.endMs < firstPage && i < beats.length / 2;
    const role: BeatRole = i === payoff ? "payoff" : i > payoff ? "signoff" : setupRun ? "setup" : "demo";
    const lead = b.actions.find((x) => x.kind !== "speech") ?? b.actions[0];
    const outcome = result.page ? "page changes" : result.region ? "screen updates" : null;
    const more = b.actions.length > 1 ? ` +${b.actions.length - 1} more` : "";
    return {
      ...b,
      score: parts.reduce((n, [, v]) => n + v, 0),
      scoreParts: parts.map(([k, v]) => `${k}${v < 0 ? v : `+${v}`}`),
      role,
      label: [`${lead.label}${more}`, outcome].filter(Boolean).join(", "),
    };
  });
}

// ---------------------------------------------------------------- markers

/** The markers mode in force: markers keep their beats by default once there are any. */
export function markerMode(a: Pick<Analysis, "markers">, mode?: MarkerMode): MarkerMode {
  if (!a.markers?.length) return "ignore";
  return mode ?? "keep";
}

/** Marker times inside the recording, in order. */
export const markerTimes = (a: Pick<Analysis, "markers" | "sourceDurationMs">) =>
  [...(a.markers ?? [])]
    .filter((m) => m.sourceMs >= 0 && m.sourceMs < a.sourceDurationMs)
    .sort((x, y) => x.sourceMs - y.sourceMs);

/** Tags each beat with the marker that starts it and its chapter (1 after the first marker, 0 before). */
export function tagMarkers<B extends Span>(beats: B[], markers: Marker[]) {
  return beats.map((b) => {
    const before = markers.filter((m) => m.sourceMs <= b.startMs + 50);
    const own = before.at(-1);
    const previous = beats.filter((x) => x.startMs < b.startMs).at(-1);
    const starts = own && (!previous || own.sourceMs > previous.startMs + 50) ? own.id : undefined;
    return { ...b, marker: starts, chapter: before.length };
  });
}

/**
 * What a marker protects from dead-air cuts in keep mode: the stretch up to the
 * next marker when speech or narration covers at least half of it, else the
 * first 1.5s after the marker. Nothing past `tailMs` (where the video must end,
 * before Screen Studio's stop click) is ever protected.
 */
export function markerProtection(
  markers: Marker[],
  speech: Span[],
  narrated: Span[],
  tailMs: number,
): Span[] {
  return markers
    .map((m, i) => {
      const span = { startMs: m.sourceMs, endMs: Math.min(tailMs, markers[i + 1]?.sourceMs ?? tailMs) };
      const covered = [...speech, ...narrated].reduce(
        (n, s) => n + Math.max(0, Math.min(span.endMs, s.endMs) - Math.max(span.startMs, s.startMs)),
        0,
      );
      return covered * 2 >= span.endMs - span.startMs
        ? span
        : { startMs: m.sourceMs, endMs: Math.min(span.endMs, m.sourceMs + 1500) };
    })
    .filter((s) => s.endMs > s.startMs);
}

/**
 * Voiced beats: each marker keeps [marker, marker + beatMs] for the line that
 * will be read over it, so a hold stretched for the line is not cut as dead air.
 * One length per marker, in marker order; a missing or zero length keeps nothing.
 */
export function voicedBeats(markers: Marker[], beatMs: number[], tailMs: number): Span[] {
  return markers
    .map((m, i) => ({
      startMs: m.sourceMs,
      endMs: Math.min(tailMs, m.sourceMs + Math.max(0, beatMs[i] ?? 0)),
    }))
    .filter((s) => s.endMs > s.startMs);
}

/** Words that say nothing about which line it is; two different lines share them all the time. */
const STOPWORDS = new Set(
  (
    "a an the and or but so then now first next also just here there this that these those it its it's " +
    "we we're we'll i i'm i'll you you're you'll they he she me my our your their us them " +
    "is are was were be been being am do does did doing have has had will would can could should " +
    "to of in on at by for with from into onto up down out over under about as if when where how what " +
    "which who all any some no not yes ok okay oh um uh like well let's lets go going get got"
  ).split(" "),
);

const contentWords = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));

/** Length of the longest common subsequence: the words both lines say in the same order. */
function inOrder(x: string[], y: string[]) {
  let row = new Array<number>(y.length + 1).fill(0);
  for (const w of x) {
    const next = [0];
    for (let j = 0; j < y.length; j++) next.push(w === y[j] ? row[j] + 1 : Math.max(row[j + 1], next[j]));
    row = next;
  }
  return row[y.length];
}

/** Content words a retake must repeat, in order, before it counts as the same line. */
export const RETAKE_MIN_WORDS = 4;

/**
 * How much of the shorter line the other one says again, in the same order,
 * counting only content words. 0 when fewer than four content words match: two
 * different steps share "click", "save" and "page" all the time.
 */
export function sameWords(a: string, b: string) {
  const x = contentWords(a);
  const y = contentWords(b);
  const shared = inOrder(x, y);
  if (shared < RETAKE_MIN_WORDS) return 0;
  return shared / Math.min(x.length, y.length);
}

/**
 * Retakes: when the speech in the 8s after a marker repeats at least 60% of the
 * content words in the 8s before it, in order, the person started the take
 * again. The whole take before the marker goes: from the earliest line before
 * the marker that the new take says again (never before the previous marker or
 * retake), or from the beat just before the marker when that starts earlier, to
 * the marker, or to the end of the last phrase or action that started before
 * the marker when that runs later, so no sentence is cut in half. Every beat
 * starting inside that stretch goes with it.
 */
export function findRetakes<B extends Span>(
  beats: B[],
  markers: Marker[],
  speech: (Span & { text: string })[],
): { marker: Marker; beat: B; beats: B[]; span: Span; similarity: number }[] {
  // A phrase running across the marker belongs to neither take.
  const beforeLines = (m: number) => speech.filter((p) => p.endMs > m - 8000 && p.endMs <= m + 200);
  const after = (m: number) =>
    speech.filter((p) => p.startMs >= m - 200 && p.startMs < m + 8000).map((p) => p.text);
  const out: { marker: Marker; beat: B; beats: B[]; span: Span; similarity: number }[] = [];
  const taken = (b: B) => out.some((r) => r.beats.includes(b));
  for (const [i, m] of markers.entries()) {
    const lines = beforeLines(m.sourceMs);
    const again = after(m.sourceMs).join(" ");
    const similarity = sameWords(lines.map((p) => p.text).join(" "), again);
    if (similarity < 0.6) continue;
    const floor = Math.max(markers[i - 1]?.sourceMs ?? -Infinity, out.at(-1)?.span.endMs ?? -Infinity);
    const beat = beats.filter((b) => b.startMs < m.sourceMs && b.startMs >= floor && !taken(b)).at(-1);
    if (!beat) continue;
    // Walk back over the lines the new take says again; the earliest one starts the old take.
    const said = new Set(contentWords(again));
    const repeats = (text: string) => {
      const w = contentWords(text);
      return w.length > 0 && w.filter((x) => said.has(x)).length >= w.length * 0.5;
    };
    let startMs = beat.startMs;
    for (const p of [...lines].sort((x, y) => y.startMs - x.startMs)) {
      if (p.startMs >= m.sourceMs) continue;
      if (!repeats(p.text)) break;
      startMs = Math.min(startMs, Math.max(floor, p.startMs));
    }
    const take = beats.filter(
      (b) => b.startMs >= startMs - 50 && b.startMs < m.sourceMs && b.startMs >= floor && !taken(b),
    );
    const running = [
      ...speech.filter((p) => p.startMs < m.sourceMs && p.startMs >= startMs),
      ...take.flatMap((b) =>
        ((b as Span & { actions?: Span[] }).actions ?? []).filter((x) => x.startMs < m.sourceMs),
      ),
    ];
    const endMs = Math.max(m.sourceMs, ...running.map((x) => x.endMs));
    out.push({ marker: m, beat, beats: take, span: { startMs, endMs }, similarity });
  }
  return out;
}
