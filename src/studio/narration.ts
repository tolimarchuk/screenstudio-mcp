// Narration: voice each line, pin it to a moment in the footage, and mix the
// lines (over optional Screen Studio library music, ducked under speech) into
// the project's audio track. Lines pinned with sourceMs follow later edits when
// the narration is re-synced; playbackMs lines stay at their playback time.
// Music and narration share the project's one background audio track.
import { constants, existsSync } from "node:fs";
import { access, copyFile, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { Studio } from "./service.js";
import type { Editor } from "./editor/editor.js";
import { durationMs, exec, ffmpeg } from "./media.js";
import { appAsar, musicLibrary, readAsar } from "./assets.js";
import { phrases, spokenWords, writeNarrationTranscript, type Word } from "./transcript.js";
import { analyzeRecording, readRecordingMeta, recordingMarkers, type Marker } from "./recording.js";
import {
  assCanvas,
  buildAss,
  buildSrt,
  captionLines,
  cueWords,
  estimateWords,
  parseSrt,
  type CaptionStyle,
  type CaptionWord,
  CAPTIONS_MARKER,
} from "./narration-captions.js";
import {
  playbackDuration,
  playbackRange,
  round,
  toPlayback,
  toPlaybackNearest,
  toSource,
  type Slice,
} from "./timeline.js";
import { privateDir, shortHash } from "./util.js";

// No zod defaults on the settings: a re-sync keeps the last narration's values
// for anything the request leaves out, so an explicit value must be told apart
// from a default. Defaults are applied in narrationSpec().
export const narrationInput = {
  lines: z
    .array(
      z
        .object({
          sourceMs: z.number().min(0).optional(),
          playbackMs: z.number().min(0).optional(),
          text: z.string().min(1).max(1000),
        })
        .strict(),
    )
    .min(1, "Pass at least one line, or omit lines to re-sync. For music alone use screenstudio_music.")
    .max(60)
    .optional(),
  voice: z
    .string()
    .regex(/^[A-Za-z0-9-]+$/)
    .optional()
    .describe("Default en-US-AndrewMultilingualNeural; a re-sync keeps the last voice."),
  rate: z
    .number()
    .int()
    .min(-50)
    .max(50)
    .optional()
    .describe("Percent. Default 0; a re-sync keeps the last."),
  music: z
    .string()
    .max(80)
    .nullable()
    .optional()
    .describe(
      "Library track such as 'commercial/Product Uplift'; null removes music. A re-sync keeps the last.",
    ),
  musicVolume: z.number().min(0).max(1).optional().describe("Default 0.14; a re-sync keeps the last."),
  voiceVolume: z.number().min(0).max(2).optional().describe("Default 1; a re-sync keeps the last."),
  pinToMarkers: z
    .boolean()
    .optional()
    .describe(
      "Line i without sourceMs or playbackMs starts 300ms after recording marker i (from screenstudio_desktop_perform markers:true or screenstudio_record_control addMarker). A marker with no input before the next one (a beat that failed before its first step) is skipped.",
    ),
  skipMarkers: z
    .array(z.string().min(1).max(80))
    .max(100)
    .optional()
    .describe(
      "With pinToMarkers: marker ids to leave out, such as the first take of a beat you redid. screenstudio_analyze lists the markers.",
    ),
  captions: z
    .boolean()
    .optional()
    .describe(
      "Caption the narration. Without a microphone recording the words become Screen Studio's own captions; otherwise an .srt and a styled .ass are written next to the project for burn-in. Default false; a re-sync keeps the last.",
    ),
};
export type NarrationRequest = z.infer<z.ZodObject<typeof narrationInput>>;
type Line = NonNullable<NarrationRequest["lines"]>[number];

export const NARRATION_DEFAULTS = {
  voice: "en-US-AndrewMultilingualNeural",
  rate: 0,
  music: null as string | null,
  musicVolume: 0.14,
  voiceVolume: 1,
};
export type NarrationSpec = typeof NARRATION_DEFAULTS & { lines: Line[] };
/** What narrate() stores per project: the spec plus the project audio file it attached. */
type SavedNarration = Partial<NarrationSpec> & {
  fileName?: string;
  captions?: boolean;
  captionsMode?: "screen-studio" | "burn-in";
  /** Caption words in playback time of the cut narrated over, for the delivery kit and burn-in. */
  cues?: CaptionWord[];
};
/** What music() stores per project. */
type SavedMusic = { track: string; volume: number; fileName: string };

/** Voices that sound natural for product narration (edge-tts). */
export const VOICES = [
  { id: "en-US-AndrewMultilingualNeural", feel: "warm, confident; the default for product demos" },
  { id: "en-US-BrianMultilingualNeural", feel: "casual, approachable; founder-style walkthroughs" },
  { id: "en-US-AvaMultilingualNeural", feel: "expressive, friendly; onboarding and tutorials" },
  { id: "en-US-EmmaMultilingualNeural", feel: "cheerful, clear; upbeat launch clips" },
];

/** The library as shipped in the pinned build. Tracks are validated against the installed app. */
export const MUSIC = {
  commercial: ["Focus Mallets", "Marimba Bed", "Product Uplift", "Smile Piano"],
  electronic: ["Ambient Electronica", "Breezy House", "Electro Pop", "Pastel Synthwave"],
  instrumental: ["Corporate Smile", "Friendly Folk", "Noble Documentary", "Piano Smile"],
  "lo-fi": ["Bright Lounge", "Cozy Chillhop", "Lean Groove", "Sunny Lo‑Fi", "Uplifting Sunset"],
};

/**
 * Merges a request with the last narration (on re-sync, when lines are omitted)
 * and the defaults. Explicit request values win, then saved values, then defaults.
 */
export function narrationSpec(req: NarrationRequest, saved: SavedNarration | null): NarrationSpec {
  const base: SavedNarration = (req.lines ? {} : saved) ?? {};
  const lines = req.lines ?? base.lines;
  if (!lines?.length) throw new Error("No earlier narration for this project. Pass lines.");
  return {
    lines,
    voice: req.voice ?? base.voice ?? NARRATION_DEFAULTS.voice,
    rate: req.rate ?? base.rate ?? NARRATION_DEFAULTS.rate,
    music: req.music !== undefined ? req.music : (base.music ?? NARRATION_DEFAULTS.music),
    musicVolume: req.musicVolume ?? base.musicVolume ?? NARRATION_DEFAULTS.musicVolume,
    voiceVolume: req.voiceVolume ?? base.voiceVolume ?? NARRATION_DEFAULTS.voiceVolume,
  };
}

/** Matches a typed track name to the library, ignoring case and hyphen look-alikes, and returns it as shipped. */
export function resolveMusic(library: Record<string, string[]>, track: string): string {
  const norm = (s: string) =>
    s
      .normalize("NFKC")
      .replace(/[‐-―−]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const slash = track.indexOf("/");
  const genre = Object.keys(library).find((g) => norm(g) === norm(track.slice(0, slash)));
  const name =
    slash > 0 && genre ? library[genre].find((n) => norm(n) === norm(track.slice(slash + 1))) : undefined;
  if (genre && name) return `${genre}/${name}`;
  const all = Object.entries(library).flatMap(([g, names]) => names.map((n) => `${g}/${n}`));
  if (!all.length) throw new Error("Screen Studio's music library was not found in the app bundle.");
  throw new Error(`Unknown music track. Choose one of: ${all.join(", ")}`);
}

/** Copies a library track (as returned by resolveMusic) out of the app bundle. */
async function libraryTrack(studio: Studio, track: string, dir: string) {
  const file = join(dir, track.replace(/[^\w.-]+/g, "_") + ".mp3");
  await writeFile(file, await readAsar(appAsar(studio.appPath), `assets/background-audio/${track}.mp3`));
  return file;
}

/**
 * The volume expression that dips music to `duckTo` under each [start, end]
 * span (seconds), with linear ramps. Spans whose ramps touch are merged, and
 * the per-span terms are combined as a balanced max() tree: ffmpeg's expression
 * parser fails beyond about 100 levels of nesting, which a left fold reaches at
 * about 96 phrases.
 */
export function duckEnvelope(spans: [number, number][], duckTo: number, ramp = 0.35): string {
  const merged: [number, number][] = [];
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = merged.at(-1);
    if (last && a - ramp <= last[1] + ramp) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  if (!merged.length) return "1";
  let terms = merged.map(
    ([a, b]) => `clip(min((t-${(a - ramp).toFixed(3)})/${ramp},(${(b + ramp).toFixed(3)}-t)/${ramp}),0,1)`,
  );
  while (terms.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < terms.length; i += 2)
      next.push(i + 1 < terms.length ? `max(${terms[i]},${terms[i + 1]})` : terms[i]);
    terms = next;
  }
  return `1-${(1 - duckTo).toFixed(3)}*${terms[0]}`;
}

const lastLine = (text: unknown) =>
  String(text ?? "")
    .trim()
    .split("\n")
    .at(-1)
    ?.trim() ?? "";

/** Why a child process failed, in one line, without echoing its (possibly huge) command line. */
function failure(error: any) {
  if (error?.killed) return "timed out";
  return lastLine(error?.stderr) || String(error?.message ?? error).split("\n")[0];
}

async function render(args: string[]) {
  try {
    await ffmpeg(args, { timeoutMs: 180000 });
  } catch (error) {
    throw new Error(`Audio mix failed: ${failure(error)}`);
  }
}

/**
 * The edge-tts arguments; the text is one `--text=` argument so a line starting
 * with "-" is not read as an option. `subtitles` also writes the word timings as SRT.
 */
export function ttsArgs(text: string, voice: string, rate: number, out: string, subtitles?: string) {
  return [
    "--voice",
    voice,
    `--rate=${rate >= 0 ? "+" : ""}${rate}%`,
    `--text=${text}`,
    "--write-media",
    out,
    ...(subtitles ? ["--write-subtitles", subtitles] : []),
  ];
}

/** Finds edge-tts like ffmpeg: an env override, then the usual install places (a GUI-launched host has a short PATH). */
export async function edgeTts() {
  if (process.env.SCREENSTUDIO_EDGE_TTS) return process.env.SCREENSTUDIO_EDGE_TTS;
  const python = join(homedir(), "Library/Python");
  const versions = await readdir(python).catch(() => [] as string[]);
  const dirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local/bin"),
    ...versions
      .sort()
      .reverse()
      .map((v) => join(python, v, "bin")),
  ];
  for (const dir of dirs) {
    try {
      await access(join(dir, "edge-tts"), constants.X_OK);
      return join(dir, "edge-tts");
    } catch {}
  }
  return "edge-tts";
}

/**
 * Voices one line into `file` and returns its duration. edge-tts creates its
 * output before streaming, so it writes to a temp file that is renamed into
 * the cache only once it probes as real audio.
 */
async function tts(text: string, voice: string, rate: number, file: string): Promise<number> {
  const tmp = `${file}.${process.pid}-${Date.now()}.part.mp3`;
  const subs = `${tmp}.srt`;
  const args = ttsArgs(text, voice, rate, tmp, subs);
  try {
    try {
      await exec(await edgeTts(), args, { timeout: 60000 });
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw new Error(`edge-tts failed: ${failure(error)}`);
      try {
        // Without Xcode's tools, /usr/bin/python3 is a stub that opens an install dialog.
        if (
          !existsSync("/Library/Developer/CommandLineTools/usr/bin/python3") &&
          !existsSync("/opt/homebrew/bin/python3") &&
          !existsSync("/usr/local/bin/python3")
        )
          throw Object.assign(new Error("no python3"), { code: "ENOENT" });
        await exec("python3", ["-m", "edge_tts", ...args], { timeout: 60000 });
      } catch (fallback: any) {
        if (fallback?.code === "ENOENT" || /No module named edge_tts/.test(String(fallback?.stderr)))
          throw new Error("Text-to-speech needs edge-tts. Install it with: pipx install edge-tts");
        throw new Error(`edge-tts failed: ${failure(fallback)}`);
      }
    }
    const ms = await durationMs(tmp).catch((e) => {
      if (/not found/.test(String(e?.message))) throw e;
      return NaN;
    });
    if (!(ms > 0))
      throw new Error("edge-tts returned no audio. Check the voice name (edge-tts --list-voices).");
    await rename(subs, subtitlesFor(file)).catch(() => {});
    await rename(tmp, file);
    return ms;
  } finally {
    await rm(tmp, { force: true });
    await rm(subs, { force: true });
  }
}

/** Where a voiced clip's word timings are kept. */
const subtitlesFor = (clipFile: string) => clipFile.replace(/\.mp3$/, ".srt");

/** Cache name of a voiced line: the same in the shared voice-lines cache and a project's narration cache. */
const clipName = (text: string, voice: string, rate: number) => shortHash(`${voice}|${rate}|${text}`);

/** A line's words timed from the start of its clip, from edge-tts subtitles or estimated by length. */
export async function clipWords(file: string, text: string, durationMs: number) {
  const srt = await readFile(subtitlesFor(file), "utf8").catch(() => "");
  const words = cueWords(parseSrt(srt));
  return words.length
    ? { words, estimated: false }
    : { words: estimateWords(text, durationMs), estimated: true };
}

/**
 * The markers lines pin to: without the ones named in `skip` (a redone beat's
 * first take) and, when the input's times are known, without a marker that has
 * no input before the next one (a beat that failed before its first step and
 * was retried, which leaves a second marker for the same beat).
 */
export function liveMarkers(markers: Marker[], o: { skip?: string[]; actionTimes?: number[] } = {}) {
  const notes: string[] = [];
  const skip = new Set(o.skip ?? []);
  for (const id of skip)
    if (!markers.some((m) => m.id === id))
      notes.push(`No marker ${id} to skip; the markers are ${markers.map((m) => m.id).join(", ")}.`);
  const kept = markers.filter((m, i) => {
    if (skip.has(m.id)) {
      notes.push(`Skipped marker ${m.id}, as asked.`);
      return false;
    }
    const next = markers[i + 1];
    if (next && o.actionTimes && !o.actionTimes.some((t) => t >= m.sourceMs && t < next.sourceMs)) {
      notes.push(
        `Skipped marker ${m.id}: nothing was clicked or typed before the next marker, so the beat was redone there.`,
      );
      return false;
    }
    return true;
  });
  return { markers: kept, notes };
}

/**
 * Line i without a time starts `leadMs` after marker i, so the voice lands just
 * after the beat it was recorded for begins. Lines that already have sourceMs
 * or playbackMs keep it.
 */
export function pinLinesToMarkers(lines: Line[], markers: Marker[], leadMs = 300) {
  const notes: string[] = [];
  const pinned = lines.map((line, i) => {
    if (line.sourceMs !== undefined || line.playbackMs !== undefined) return line;
    const marker = markers[i];
    if (!marker)
      throw new Error(
        `Line ${i + 1} has no time and the recording has ${markers.length} marker${markers.length === 1 ? "" : "s"}. Give it sourceMs, or record each beat with markers.`,
      );
    notes.push(`Line ${i + 1} starts ${leadMs}ms after marker ${i + 1} (source ${marker.sourceMs}ms).`);
    return { ...line, sourceMs: marker.sourceMs + leadMs };
  });
  return { lines: pinned, notes };
}

/**
 * Voices lines into the shared cache without touching any project, so each beat
 * can be sized to its line before recording. narrate() reuses these clips.
 */
export async function voiceLines(
  studio: Studio,
  req: { lines: { text: string }[]; voice?: string; rate?: number },
) {
  const voice = req.voice ?? NARRATION_DEFAULTS.voice;
  const rate = req.rate ?? NARRATION_DEFAULTS.rate;
  const dir = await privateDir(join(studio.stateDir, "voice-lines"));
  const lines = [];
  for (const [i, line] of req.lines.entries()) {
    const file = join(dir, `${clipName(line.text, voice, rate)}.mp3`);
    const durationMs = round(await clip(line.text, voice, rate, file));
    lines.push({ index: i + 1, text: line.text, durationMs, ...beatFor(line.text, durationMs) });
  }
  return { voice, rate, lines, ...scriptNotes(lines) };
}

/** How long a beat should last for its line, and how fast the line is spoken. */
export function beatFor(text: string, durationMs: number) {
  const words = text.split(/\s+/).filter(Boolean).length;
  return {
    beatMs: Math.round(durationMs) + 400,
    wordsPerSecond: Math.round((words / Math.max(durationMs, 1)) * 10000) / 10,
  };
}

/** Plain-English reading of a voiced script: total length and lines spoken too fast. */
export function scriptNotes(lines: { index: number; beatMs: number; wordsPerSecond: number }[]) {
  const totalMs = lines.reduce((n, l) => n + l.beatMs, 0);
  return {
    totalMs,
    notes: [
      "beatMs is each line plus 400ms: pass it as minDurationMs to screenstudio_desktop_perform so the beat lasts as long as its line, with markers:true so screenstudio_narrate pinToMarkers can put the line on its beat later.",
      `The whole script runs about ${Math.round(totalMs / 100) / 10}s.`,
      ...lines
        .filter((l) => l.wordsPerSecond > 3.4)
        .map(
          (l) =>
            `Line ${l.index} runs at ${l.wordsPerSecond} words a second, fast for a viewer also reading the screen. Shorten it or lower the rate.`,
        ),
    ],
  };
}

/** A project's cached clip, copied from the shared voice-lines cache when it was voiced there first. */
async function projectClip(studio: Studio, dir: string, text: string, voice: string, rate: number) {
  const name = clipName(text, voice, rate);
  const file = join(dir, `${name}.mp3`);
  if (!(await stat(file).catch(() => null))?.size) {
    const shared = join(studio.stateDir, "voice-lines", `${name}.mp3`);
    if ((await stat(shared).catch(() => null))?.size) {
      await copyFile(shared, file);
      await copyFile(subtitlesFor(shared), subtitlesFor(file)).catch(() => {});
    }
  }
  return file;
}

/** A cached clip's duration, regenerating it when the cached file is empty or unreadable. */
async function clip(text: string, voice: string, rate: number, file: string) {
  if ((await stat(file).catch(() => null))?.size) {
    const ms = await durationMs(file).catch(() => NaN);
    if (ms > 0) return ms;
  }
  await rm(file, { force: true });
  return tts(text, voice, rate, file);
}

/** The editor's live project; it must be open. */
async function openProject(editor: Editor, path: string) {
  const live = await editor.liveProject(path);
  if (!live) throw new Error("Open the project in the editor first (screenstudio_editor_open).");
  return live as {
    scenes: { slices: Slice[] }[];
    config?: {
      audio?: { backgroundAudioFileName?: string | null };
      captions?: CaptionStyle & { enableTranscript?: boolean };
      output?: { aspectRatio?: number | "auto" };
    };
  };
}

const readJson = <T>(file: string): Promise<T | null> =>
  readFile(file, "utf8")
    .then((text) => JSON.parse(text) as T)
    .catch(() => null);

/** What the project's background track currently is, as far as these tools know. */
export function previousTrack(
  current: string | null | undefined,
  narration: SavedNarration | null,
  music: SavedMusic | null,
) {
  if (!current) return null;
  const kind =
    current === narration?.fileName ? "narration" : current === music?.fileName ? "music" : "custom";
  return { fileName: current, kind, ...(kind === "music" ? { track: music!.track } : {}) };
}

/** Audio files these tools put in a project (`<staged name>-<random>.m4a` after the app copies them). */
const TOOL_AUDIO = /^(narration|music)-\d+-[A-Za-z0-9]+\.m4a$/;

/** Tool-made audio files that nothing references any more. */
export function orphanedAudio(files: string[], referenced: string) {
  return files.filter((f) => TOOL_AUDIO.test(f) && !referenced.includes(f));
}

/**
 * Deletes earlier narration and music mixes from the project package that
 * neither the live project, the saved project nor an editor checkpoint uses.
 * Runs before a new track is attached, so the track being replaced survives for undo.
 */
async function sweepAudio(studio: Studio, editor: Editor, path: string, live: unknown) {
  const assets = join(path, "assets");
  const files = await readdir(assets).catch(() => [] as string[]);
  if (!files.some((f) => TOOL_AUDIO.test(f))) return;
  // What the editor references right now, not when this call started.
  live = (await editor.liveProject(path).catch(() => null)) ?? live;
  const saved = await readFile(join(path, "project.json"), "utf8").catch(() => null);
  if (saved === null) return;
  const checkpoints = await Promise.all(
    (await readdir(studio.stateDir).catch(() => [] as string[]))
      .filter((f) => /^editor-[0-9a-f-]{36}\.json$/.test(f))
      .map((f) => readFile(join(studio.stateDir, f), "utf8").catch(() => "")),
  );
  const referenced = [JSON.stringify(live), saved, ...checkpoints].join("\n");
  // Tracks from the last hour stay: the app's undo history may still point at them.
  const old = async (f: string) =>
    Date.now() -
      (await stat(join(assets, f)).then(
        (s) => s.mtimeMs,
        () => Date.now(),
      )) >
    3600_000;
  for (const f of orphanedAudio(files, referenced))
    if (await old(f)) await rm(join(assets, f), { force: true });
}

/** Copies a mixed track into the project and makes it the background audio, like choosing a custom track. */
async function attachBackgroundAudio(
  studio: Studio,
  editor: Editor,
  path: string,
  live: unknown,
  file: string,
  volume: number,
) {
  try {
    await sweepAudio(studio, editor, path, live);
    const fileName = await studio.call<string>("mutation", "project.copyFileToProject", {
      projectPath: path,
      sourcePath: file,
    });
    await editor.setAudio(path, {
      backgroundAudioFileName: fileName,
      backgroundAudioVolume: volume,
      muteBackgroundAudio: false,
    });
    return fileName;
  } finally {
    // The project keeps its own copy; the staged mix is not needed again.
    await rm(file, { force: true });
  }
}

/**
 * Background music from Screen Studio's library, laid under the edited video.
 * With duckUnderSpeech, the track dips smoothly while anyone speaks (from the
 * project transcript), so it can sit higher between phrases. When the track
 * slot holds this tool's narration, the music is mixed under the narration
 * instead of replacing it.
 */
/**
 * Narration and music share one background track, so calls for the same
 * project run one at a time: a parallel call must not sweep away the track the
 * other just attached.
 */
const audioQueue = new Map<string, Promise<unknown>>();
async function oneAtATime<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const before = audioQueue.get(path) ?? Promise.resolve();
  const run = before.catch(() => {}).then(fn);
  audioQueue.set(path, run);
  try {
    return await run;
  } finally {
    if (audioQueue.get(path) === run) audioQueue.delete(path);
  }
}

export async function music(
  studio: Studio,
  editor: Editor,
  projectPath: string,
  opts: { track: string; volume: number; duckUnderSpeech: boolean; duckTo: number },
) {
  const path = await studio.path(projectPath);
  return oneAtATime(path, () => musicNow(studio, editor, path, opts));
}

async function musicNow(
  studio: Studio,
  editor: Editor,
  path: string,
  opts: { track: string; volume: number; duckUnderSpeech: boolean; duckTo: number },
) {
  const key = shortHash(path);
  const track = resolveMusic(await musicLibrary(studio.appPath), opts.track);
  const live = await openProject(editor, path);
  const narration = await readJson<SavedNarration>(join(studio.stateDir, `narration-${key}.json`));
  const musicPath = join(studio.stateDir, `music-${key}.json`);
  const previous = previousTrack(
    live.config?.audio?.backgroundAudioFileName,
    narration,
    await readJson<SavedMusic>(musicPath),
  );
  if (previous?.kind === "narration") {
    const result = await narrate(studio, editor, path, { music: track, musicVolume: opts.volume });
    return {
      ...result,
      note: "The audio track holds the narration, so the music was mixed under the voice (ducked by it) instead of replacing it. screenstudio_narrate with music: null removes it.",
    };
  }

  const slices = live.scenes[0].slices;
  const total = playbackDuration(slices) / 1000;
  const dir = await privateDir(join(studio.stateDir, `music-${key}`));
  const src = await libraryTrack(studio, track, dir);
  const warnings: string[] = [];
  let envelope = "1";
  let ducked = 0;
  if (opts.duckUnderSpeech) {
    let words: Word[] = [];
    try {
      words = await spokenWords(studio, path);
    } catch (error) {
      warnings.push(
        `Couldn't read the transcript, so the music isn't ducked under speech (${failure(error)}). Run screenstudio_transcript_generate, then re-run screenstudio_music.`,
      );
    }
    const spans = phrases(words, 700)
      .map((p) => playbackRange(slices, p.startMs, p.endMs))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r): [number, number] => [r.startMs / 1000, r.endMs / 1000]);
    if (!words.length && !warnings.length)
      warnings.push(
        "No transcript words, so the music isn't ducked. If this video has speech, run screenstudio_transcript_generate, then re-run screenstudio_music.",
      );
    if (words.length && !spans.length)
      warnings.push("None of the transcript's speech falls inside the current cut, so nothing was ducked.");
    ducked = spans.length;
    envelope = duckEnvelope(spans, opts.duckTo);
  }
  if (previous?.kind === "custom")
    warnings.push(`Replaced the project's background track ${previous.fileName}.`);
  const out = join(dir, `music-${Date.now()}.m4a`);
  await render([
    "-y",
    "-stream_loop",
    "-1",
    "-i",
    src,
    "-filter_complex",
    `[0:a]atrim=0:${total + 0.3},volume='${envelope}':eval=frame,afade=t=in:d=1.2,afade=t=out:st=${Math.max(0, total - 2)}:d=2[out]`,
    "-map",
    "[out]",
    "-t",
    String(total + 0.3),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    out,
  ]);
  const fileName = await attachBackgroundAudio(studio, editor, path, live, out, opts.volume);
  await writeFile(musicPath, JSON.stringify({ track, volume: opts.volume, fileName } satisfies SavedMusic), {
    mode: 0o600,
  });
  return {
    fileName,
    track,
    volume: opts.volume,
    duckedUnderPhrases: ducked,
    previous,
    warnings,
    note: "Music is the project's background audio track (one slot, shared with narration; screenstudio_narrate keeps this music under the voice). Re-run after changing the cut so the ducking follows the speech.",
  };
}

export async function narrate(studio: Studio, editor: Editor, projectPath: string, req: NarrationRequest) {
  const path = await studio.path(projectPath);
  return oneAtATime(path, () => narrateNow(studio, editor, path, req));
}

async function narrateNow(studio: Studio, editor: Editor, path: string, req: NarrationRequest) {
  const key = shortHash(path);
  const specPath = join(studio.stateDir, `narration-${key}.json`);
  const musicPath = join(studio.stateDir, `music-${key}.json`);
  const saved = await readJson<SavedNarration>(specPath);
  const spec = narrationSpec(req, saved);
  const resync = !req.lines;
  const notes: string[] = [];
  if (req.pinToMarkers) {
    // Input times, to tell a beat that was retried before any input; unknown when analysis fails.
    const actionTimes = await analyzeRecording(path, { cacheDir: studio.stateDir }).then(
      (a) => [
        ...a.clicks.map((c) => c.atMs),
        ...a.typing.map((t) => t.startMs),
        ...a.shortcuts.map((k) => k.atMs),
      ],
      () => undefined,
    );
    const beats = liveMarkers(await recordingMarkers(path), { skip: req.skipMarkers, actionTimes });
    const pinned = pinLinesToMarkers(spec.lines, beats.markers);
    spec.lines = pinned.lines;
    notes.push(...beats.notes, ...pinned.notes);
  }
  const captions = req.captions ?? saved?.captions ?? false;
  const live = await openProject(editor, path);
  const savedMusic = await readJson<SavedMusic>(musicPath);
  const previous = previousTrack(live.config?.audio?.backgroundAudioFileName, saved, savedMusic);
  const warnings: string[] = [];
  if (previous?.kind === "music" && req.music === undefined) {
    // screenstudio_music laid the current track after the last narration; keep it under the voice.
    spec.music = savedMusic!.track;
    spec.musicVolume = req.musicVolume ?? savedMusic!.volume;
    warnings.push(
      `Kept the music track ${spec.music} under the narration. Pass music: null to narrate without it.`,
    );
  } else if (previous?.kind === "music" && !spec.music)
    warnings.push(`Replaced the music track ${previous.track} with narration only.`);
  else if (previous?.kind === "custom")
    warnings.push(`Replaced the project's background track ${previous.fileName}.`);
  if (spec.music) spec.music = resolveMusic(await musicLibrary(studio.appPath), spec.music);

  const dir = await privateDir(join(studio.stateDir, `narration-${key}`));
  const slices = live.scenes[0].slices;
  const total = playbackDuration(slices);

  const placed = [];
  for (const [i, line] of spec.lines.entries()) {
    const at =
      line.sourceMs !== undefined
        ? (toPlayback(slices, line.sourceMs) ?? toPlaybackNearest(slices, line.sourceMs))
        : (line.playbackMs ?? null);
    if (at === null) throw new Error(`Line ${i + 1} needs sourceMs or playbackMs.`);
    if (resync && line.sourceMs === undefined)
      warnings.push(
        `Line ${i + 1} is pinned to playback time ${round(at)}ms, so it did not follow the cut. Give it sourceMs to keep it on its moment.`,
      );
    const file = await projectClip(studio, dir, line.text, spec.voice, spec.rate);
    placed.push({
      index: i + 1,
      text: line.text,
      file,
      startMs: round(at),
      durationMs: round(await clip(line.text, spec.voice, spec.rate, file)),
    });
  }
  placed.sort((a, b) => a.startMs - b.startMs);
  for (const [i, p] of placed.entries()) {
    const next = placed[i + 1];
    const end = p.startMs + p.durationMs;
    if (next && end + 250 > next.startMs)
      warnings.push(
        `Line ${p.index} runs ${round(end + 250 - next.startMs)}ms into line ${next.index}. Hold that beat longer, move line ${next.index} later, or shorten line ${p.index}.`,
      );
    if (end > total - 600)
      warnings.push(
        `Line ${p.index} ends ${round(end - total + 600)}ms too close to the end of the video. Hold the ending longer.`,
      );
  }

  // Mix: voice lines at their times, music looped under them and ducked while speaking.
  const out = join(dir, `narration-${Date.now()}.m4a`);
  const seconds = (total + 300) / 1000;
  const inputs: string[] = [];
  const filters: string[] = [];
  placed.forEach((p, i) => {
    inputs.push("-i", p.file);
    filters.push(
      `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${p.startMs}|${p.startMs},volume=${spec.voiceVolume}[v${i}]`,
    );
  });
  const voiceMix = `${placed.map((_, i) => `[v${i}]`).join("")}amix=inputs=${placed.length}:normalize=0,apad,atrim=0:${seconds}`;
  if (spec.music) {
    const musicFile = await libraryTrack(studio, spec.music, dir);
    inputs.push("-stream_loop", "-1", "-i", musicFile);
    const m = placed.length;
    filters.push(`${voiceMix},asplit=2[voice][key]`);
    filters.push(
      `[${m}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${seconds},volume=${spec.musicVolume},afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, seconds - 2.5)}:d=2.5[bed]`,
    );
    filters.push(`[bed][key]sidechaincompress=threshold=0.03:ratio=6:attack=40:release=500[ducked]`);
    filters.push(`[voice][ducked]amix=inputs=2:normalize=0,alimiter=limit=0.95[out]`);
  } else filters.push(`${voiceMix},alimiter=limit=0.95[out]`);
  await render([
    "-y",
    ...inputs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[out]",
    "-t",
    String(seconds),
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    out,
  ]);
  const fileName = await attachBackgroundAudio(studio, editor, path, live, out, 1);
  let caption: Awaited<ReturnType<typeof narrationCaptions>> | null = null;
  const words: CaptionWord[] = [];
  if (captions) {
    for (const p of placed) {
      const timed = await clipWords(p.file, p.text, p.durationMs);
      if (timed.estimated)
        notes.push(
          `Line ${p.index} came without word timings, so its caption words are spread evenly over the line.`,
        );
      words.push(
        ...timed.words.map((w) => ({ ...w, startMs: w.startMs + p.startMs, endMs: w.endMs + p.startMs })),
      );
    }
    try {
      caption = await narrationCaptions(studio, editor, path, live, words);
      notes.push(...caption.notes);
    } catch (error) {
      // The voice is already on the audio track; a caption failure should not hide that.
      warnings.push(`The narration is attached, but its captions failed: ${failure(error)}`);
    }
  } else if (saved?.captions)
    notes.push(
      "Captions are off for this narration. Captions written earlier stay until you turn them off (config captions.enableTranscript false) or delete the subtitle files.",
    );
  await writeFile(
    specPath,
    JSON.stringify({
      ...spec,
      fileName,
      captions,
      ...(caption ? { captionsMode: caption.mode, cues: words } : {}),
    } satisfies SavedNarration),
    { mode: 0o600 },
  );
  // Clips for lines no longer in the narration are dead cache entries.
  const keep = new Set(placed.map((p) => basename(p.file, ".mp3")));
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    const cached = /^([0-9a-f]{16})\.(mp3|srt)$/.exec(f);
    if (cached && !keep.has(cached[1])) await rm(join(dir, f), { force: true });
  }
  return {
    fileName,
    videoMs: round(total),
    lines: placed.map(({ file: _f, ...p }) => ({ ...p, endMs: p.startMs + p.durationMs })),
    music: spec.music,
    previous,
    warnings,
    ...(caption ? { captions: { mode: caption.mode, ...caption.files } } : {}),
    notes,
    note: "Narration plays as the project's background audio track. Re-run screenstudio_narrate without lines after changing the cut to re-sync it; voice, music and volumes carry over unless you pass new ones.",
  };
}

/** True when the recording has a microphone channel with at least one session. */
export function hasMicrophone(recorders: { type?: string; sessions?: unknown[] }[]) {
  return recorders.some((r) => r.type === "microphone" && (r.sessions?.length ?? 0) > 0);
}

/** Sibling subtitle files for a project bundle: `<name>-narration.srt` and `.ass`. */
export function captionFilePaths(projectPath: string) {
  const base = join(dirname(projectPath), basename(projectPath, ".screenstudio"));
  return { srt: `${base}-narration.srt`, ass: `${base}-narration.ass` };
}

/**
 * Captions the narration. A recording without a microphone has no spoken
 * transcript to lose, so the words go into Screen Studio as its transcript
 * (source time, so they follow later cuts) and the app renders them like any
 * captions. Otherwise, or when the app does not keep them, an SRT and an ASS
 * styled like the project's captions are written next to the project, timed to
 * the current cut, for burning into the export.
 */
async function narrationCaptions(
  studio: Studio,
  editor: Editor,
  path: string,
  live: Awaited<ReturnType<typeof openProject>>,
  words: CaptionWord[],
) {
  const slices = live.scenes[0].slices;
  const notes: string[] = [];
  const meta = await readRecordingMeta(path).catch(() => null);
  const recorders: { type?: string; sessions?: unknown[] }[] = meta
    ? (JSON.parse(await readFile(join(meta.dir, "metadata.json"), "utf8")).recorders ?? [])
    : [];
  if (meta && !hasMicrophone(recorders)) {
    try {
      const source = words.map((w) => ({
        text: w.text,
        startMs: toSource(slices, w.startMs),
        endMs: toSource(slices, w.endMs),
      }));
      const written = await writeNarrationTranscript(studio, path, source);
      if (!live.config?.captions?.enableTranscript)
        await editor.apply(path, undefined, [
          { op: "config", changes: { "captions.enableTranscript": true } },
        ]);
      notes.push(
        `The recording has no microphone, so the ${written.words} narration words are now Screen Studio's own captions, styled by the captions settings. The voice stays where it is when the cut changes, so after any cut change re-run screenstudio_narrate without lines: it re-syncs the voice and rewrites the captions together.`,
        written.editor === "stale"
          ? "The open editor could not reload the transcript; reopen the project to see the captions."
          : "Check a captioned frame with screenstudio_editor_frame.",
      );
      return { mode: "screen-studio" as const, files: {}, notes };
    } catch (error) {
      notes.push(
        `Screen Studio did not take the narration as captions (${error instanceof Error ? error.message.split("\n")[0] : error}), so they were written as subtitle files instead.`,
      );
    }
  } else if (meta)
    notes.push(
      "The recording has a microphone, and narration captions must not replace its transcript, so they were written as subtitle files for burn-in.",
    );
  const lines = captionLines(words);
  const style = live.config?.captions ?? {};
  const aspect = live.config?.output?.aspectRatio;
  const bounds = meta?.sessions[0]?.bounds;
  const ratio = typeof aspect === "number" ? aspect : bounds ? bounds.width / bounds.height : 16 / 9;
  const files = captionFilePaths(path);
  // Only replace caption files this tool wrote before (its .ass carries a marker line).
  const ours = await readFile(files.ass, "utf8").then(
    (t) => t.includes(CAPTIONS_MARKER),
    () => !existsSync(files.srt),
  );
  if (!ours)
    throw new Error(
      `${files.ass} or ${files.srt} already exists and was not written by this tool; move it away and narrate again.`,
    );
  await writeFile(files.srt, buildSrt(lines));
  await writeFile(files.ass, buildAss(lines, words, style, assCanvas(ratio)));
  notes.push(
    `Wrote ${lines.length} caption lines timed to the current cut. Burn them into the export with ffmpeg -i <export>.mp4 -vf "subtitles=<ass file>" <export>-captioned.mp4, or upload the .srt where a platform takes captions. Re-run screenstudio_narrate without lines after changing the cut to re-time them.`,
  );
  return { mode: "burn-in" as const, files, notes };
}
