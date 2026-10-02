// The microphone's loudness between sentences. Recognizer word edges are often
// 100ms off and speakers rarely pause more than 200ms between sentences, so the
// transcript alone seldom leaves room for a clean cut. The audio does: between
// two sentences the level drops into a valley, and a cut in its middle clips
// nothing.
import { ffmpegFailure, readRecordingMeta } from "./recording.js";
import { ffmpeg } from "./media.js";
import type { Span } from "./spans.js";

/** The microphone's level over one frame: `t` is the frame's start in source ms. */
export interface Level {
  t: number;
  db: number;
}

/**
 * The quietest moment between two adjacent sentences. `afterMs` and `beforeMs`
 * name the boundary: the earlier sentence's end and the next one's start.
 */
export interface Valley {
  afterMs: number;
  beforeMs: number;
  /** The middle of the quiet stretch: where a cut between the two sentences goes. */
  atMs: number;
  /** The quietest 40ms against the median level of speech, in dB (negative: quieter). */
  quietDb: number;
  /** How long the level stays within 3dB of that quietest window. */
  widthMs: number;
}

/** Envelope frames: 10ms at 8kHz mono, so a minute of audio is 6000 numbers. */
export const FRAME_MS = 10;
const RATE = 8000;
/** The quietest window searched for, and how far around the transcript's boundary to look. */
const WINDOW_MS = 40;
const SEARCH_MS = 150;
/** Frames within this much of the quietest window still count as the same valley. */
const FLAT_DB = 3;
/** Digital silence reads as -inf; it counts as this. */
const FLOOR_DB = -100;

/**
 * How far below speech a valley must dip before a cut may sit in it. Inside a
 * word the level rarely falls more than 6-10dB below the median of speech (a
 * stop consonant's closure, a soft vowel); between words and sentences, where
 * the speaker breathes or closes their mouth, it falls 15dB and more. 12dB (a
 * quarter of speech's amplitude) sits between the two: deep enough that the cut
 * lands where no syllable is sounding, shallow enough for room tone and a quiet
 * breath to count. On a measured 35s talking-head take, 9 of 11 sentence
 * boundaries dipped 14-34dB; the two where the speaker ran straight on dipped
 * 8.5dB and 11dB.
 */
export const VALLEY_DB = 12;

/** True when a cut may sit in the valley: it is at least VALLEY_DB below speech. */
export const quietValley = (v: Pick<Valley, "quietDb">) => v.quietDb <= -VALLEY_DB;

/** The valley between two adjacent sentences (an earlier one ending, the next starting), if one was found. */
export const valleyBetween = (valleys: Valley[] | undefined, earlier: Span, next: Span) =>
  valleys?.find((v) => Math.abs(v.afterMs - earlier.endMs) < 1 && Math.abs(v.beforeMs - next.startMs) < 1);

/** ffmpeg's per-frame RMS levels for an audio file, mono at 8kHz. */
const LEVEL_FILTER = [
  `aformat=sample_fmts=flt:sample_rates=${RATE}:channel_layouts=mono`,
  `asetnsamples=n=${(RATE * FRAME_MS) / 1000}:p=0`,
  "astats=metadata=1:reset=1",
  "ametadata=print:key=lavfi.astats.1.RMS_level:file=-",
].join(",");

/**
 * Parses ametadata's print output (`frame:N pts:P pts_time:T` then
 * `lavfi.astats.1.RMS_level=V`) into levels, shifted by `offsetMs` and kept
 * before `untilMs`.
 */
export function parseLevels(stdout: string, offsetMs = 0, untilMs = Infinity): Level[] {
  const out: Level[] = [];
  let t: number | null = null;
  for (const line of stdout.split("\n")) {
    const time = /pts_time:(-?[\d.]+)/.exec(line);
    if (time) {
      t = Number(time[1]) * 1000 + offsetMs;
      continue;
    }
    const rms = /RMS_level=(\S+)/.exec(line);
    if (!rms || t === null || t >= untilMs) continue;
    const db = Number(rms[1]);
    out.push({ t: Math.round(t), db: Number.isFinite(db) ? Math.max(FLOOR_DB, db) : FLOOR_DB });
    t = null;
  }
  return out;
}

/**
 * The microphone's loudness envelope in source time. Each microphone session
 * maps to source time like its transcript: by the start of the screen session
 * with the same index. Without a microphone, or when ffmpeg cannot read it, no
 * levels and the reason.
 */
export async function micLevels(projectPath: string): Promise<{ levels: Level[]; unavailable?: string }> {
  const { microphone } = await readRecordingMeta(projectPath);
  if (!microphone.length) return { levels: [], unavailable: "the recording has no microphone" };
  try {
    const parts = await Promise.all(
      microphone.map(async (m) =>
        parseLevels(
          await ffmpeg(["-nostats", "-i", m.audio, "-vn", "-af", LEVEL_FILTER, "-f", "null", "-"], {
            timeoutMs: 120000,
            maxBuffer: 256 * 1024 * 1024,
          }),
          m.startMs,
          m.endMs,
        ),
      ),
    );
    const levels = parts.flat().sort((x, y) => x.t - y.t);
    return levels.length ? { levels } : { levels, unavailable: "the microphone audio has no samples" };
  } catch (e) {
    return { levels: [], unavailable: `the microphone audio could not be read (${ffmpegFailure(e)})` };
  }
}

const toPower = (db: number) => 10 ** (db / 10);
const toDb = (power: number) => (power > 0 ? Math.max(FLOOR_DB, 10 * Math.log10(power)) : FLOOR_DB);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * The valley between each pair of adjacent sentences: searching from 150ms
 * before the earlier one's end to 150ms after the next one's start, the
 * quietest 40ms window, how far below the median level of speech it sits, and
 * the stretch around it that stays within 3dB. Its middle is where a cut goes.
 * Levels must be in time order; boundaries the levels do not cover get none.
 */
export function findValleys(levels: Level[], sentences: Span[]): Valley[] {
  if (levels.length < WINDOW_MS / FRAME_MS || sentences.length < 2) return [];
  const said = [...sentences].sort((x, y) => x.startMs - y.startMs);
  // Speech level: the median frame inside the sentences (pauses inside them included, as the recognizer has them).
  const inSpeech: number[] = [];
  let k = 0;
  for (const l of levels) {
    while (k < said.length && said[k].endMs <= l.t) k++;
    if (k < said.length && l.t >= said[k].startMs) inSpeech.push(l.db);
  }
  if (!inSpeech.length) return [];
  const speechDb = median(inSpeech);
  const frames = WINDOW_MS / FRAME_MS;
  const first = (t: number) => {
    let lo = 0;
    let hi = levels.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (levels[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const out: Valley[] = [];
  for (let s = 1; s < said.length; s++) {
    const p = said[s - 1];
    const n = said[s];
    const from = Math.min(p.endMs, n.startMs) - SEARCH_MS;
    const to = Math.max(p.endMs, n.startMs) + SEARCH_MS;
    const lo = first(from);
    let hi = first(to);
    // Only frames that lie wholly inside the search range.
    while (hi > lo && levels[hi - 1].t + FRAME_MS > to) hi--;
    if (hi - lo < frames) continue;
    let best = -1;
    let bestDb = Infinity;
    for (let i = lo; i + frames <= hi; i++) {
      // A window spans contiguous frames only; a gap in the levels breaks it.
      if (levels[i + frames - 1].t - levels[i].t > (frames - 1) * FRAME_MS + 1) continue;
      let power = 0;
      for (let j = i; j < i + frames; j++) power += toPower(levels[j].db);
      const db = toDb(power / frames);
      if (db < bestDb) [best, bestDb] = [i, db];
    }
    if (best < 0) continue;
    let left = best;
    let right = best + frames - 1;
    const flat = (i: number) => levels[i].db <= bestDb + FLAT_DB;
    while (left > lo && flat(left - 1) && levels[left].t - levels[left - 1].t <= FRAME_MS + 1) left--;
    while (right < hi - 1 && flat(right + 1) && levels[right + 1].t - levels[right].t <= FRAME_MS + 1)
      right++;
    const startT = levels[left].t;
    const endT = levels[right].t + FRAME_MS;
    out.push({
      afterMs: Math.round(p.endMs),
      beforeMs: Math.round(n.startMs),
      atMs: Math.round((startT + endT) / 2),
      quietDb: Math.round((bestDb - speechDb) * 10) / 10,
      widthMs: endT - startT,
    });
  }
  return out;
}
