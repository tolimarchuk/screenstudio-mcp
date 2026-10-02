// Reads what happened in a recording: clicks, typing, shortcuts, cursor travel
// and on-screen change, all in source milliseconds with 0-1 frame coordinates.
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ffmpeg } from "./media.js";
import type { Valley } from "./audio.js";
import { mergeSpans, type Span } from "./spans.js";
import { shortHash, statePath } from "./util.js";

export interface Click {
  atMs: number;
  endMs: number;
  x: number;
  y: number;
  drag: boolean;
  button: string;
}
export interface Typing {
  startMs: number;
  endMs: number;
  chars: number;
  text?: string;
  x?: number;
  y?: number;
}
export interface Shortcut {
  atMs: number;
  keys: string;
}
export interface ScreenChange {
  atMs: number;
  score: number;
  kind: "region" | "page";
}
export interface Analysis {
  projectPath: string;
  sourceDurationMs: number;
  capture: { kind: string; widthPt: number; heightPt: number };
  sessions: { startMs: number; endMs: number; video: string }[];
  clicks: Click[];
  typing: Typing[];
  shortcuts: Shortcut[];
  movement: (Span & { distance01: number })[];
  /**
   * `unavailable` names the sessions whose video could not be read; those count
   * as busy. `unread` holds their spans: nothing is known of the screen there.
   */
  screen: { changes: ScreenChange[]; active: Span[]; unavailable?: string; unread?: Span[] };
  idle: Span[];
  /** Spoken phrases from the project transcript, when one exists. */
  speech?: (Span & { text: string; words: number })[];
  /**
   * Spoken sentences (split at . ? ! and at pauses of 350ms or more): beats and
   * camera changes split between them. Without them, the phrases stand in.
   */
  sentences?: (Span & { text: string; words: number })[];
  fillers?: (Span & { text: string })[];
  /** Markers added while recording (one per beat), mapped to source ms, in order. */
  markers?: Marker[];
  /** Whether the recording has a camera channel; absent in analyses made before this was read. */
  hasCamera?: boolean;
  /** Whether the recording has a microphone channel. */
  hasMicrophone?: boolean;
  /**
   * Where the microphone goes quiet between adjacent sentences: a cut may sit in
   * a valley the transcript shows no pause for. Filled with the sentences.
   */
  valleys?: Valley[];
  /** Why there are no valleys: no microphone, or its audio could not be read. */
  valleysUnavailable?: string;
}
export interface Marker {
  id: string;
  sourceMs: number;
}

const MOD: Record<string, string> = {
  command: "⌘",
  control: "⌃",
  option: "⌥",
  shift: "⇧",
};

// NSEvent characters for keys that print nothing: control codes and the
// private-use function-key range. F1-F35 are U+F704-U+F726.
const KEY_NAMES: Record<string, string> = {
  "\uf700": "Up",
  "\uf701": "Down",
  "\uf702": "Left",
  "\uf703": "Right",
  "\u007f": "Delete",
  "\uf728": "ForwardDelete",
  "\u001b": "Esc",
  "\r": "Return",
  "\u0003": "Enter",
  "\t": "Tab",
  "\u0019": "Tab",
  " ": "Space",
  "\uf729": "Home",
  "\uf72b": "End",
  "\uf72c": "PageUp",
  "\uf72d": "PageDown",
};

/** What Return and Tab add to typed text inside a burst. */
const TEXT_KEYS: Record<string, string> = { Return: "\n", Enter: "\n", Tab: "\t" };

/** Readable name of a key, as it appears in a shortcut. */
export function keyName(character: string) {
  const code = character.codePointAt(0) ?? 0;
  if (character.length === 1 && code >= 0xf704 && code <= 0xf726) return `F${code - 0xf703}`;
  return KEY_NAMES[character] ?? character.toUpperCase();
}

/** True when the key types visible text (not a control or function key). */
export function isPrintable(character: string) {
  if (!character) return false;
  for (const ch of character) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || (code >= 0xf700 && code <= 0xf8ff)) return false;
  }
  return true;
}

// Input is logged in global screen points. A point this far outside the
// captured bounds (0-1) is rounding; further out, the video does not show it.
const EDGE = 0.01;

/** 0-1 frame position of a screen point, or null when it is outside the capture. */
export function framePoint(
  x: number,
  y: number,
  b: { x?: number; y?: number; width: number; height: number },
) {
  const fx = (x - (b.x ?? 0)) / b.width;
  const fy = (y - (b.y ?? 0)) / b.height;
  if (fx < -EDGE || fx > 1 + EDGE || fy < -EDGE || fy > 1 + EDGE) return null;
  return { x: Math.min(1, Math.max(0, fx)), y: Math.min(1, Math.max(0, fy)) };
}

export function ffmpegFailure(e: any) {
  if (e?.code === "ENOENT") return "ffmpeg not found";
  if (e?.killed || e?.signal) return "timed out";
  const stderr = String(e?.stderr ?? "")
    .trim()
    .split("\n")
    .at(-1);
  return stderr || String(e?.message ?? e);
}

const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const optional = async (path: string) => {
  try {
    return await json(path);
  } catch {
    return [];
  }
};

async function screenActivity(video: string, offsetMs: number): Promise<{ t: number; score: number }[]> {
  const stdout = await ffmpeg(
    [
      "-nostats",
      "-i",
      video,
      "-vf",
      "fps=10,scale=320:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score:file=-",
      "-an",
      "-f",
      "null",
      "-",
    ],
    { timeoutMs: 300000, maxBuffer: 64 * 1024 * 1024 },
  );
  const samples: { t: number; score: number }[] = [];
  let t = 0;
  for (const line of stdout.split("\n")) {
    const time = /pts_time:([\d.]+)/.exec(line);
    if (time) t = Number(time[1]) * 1000;
    const score = /scene_score=([\d.]+)/.exec(line);
    if (score) samples.push({ t: t + offsetMs, score: Number(score[1]) });
  }
  return samples;
}

export interface RecordingSession extends Span {
  video: string;
  processStart: number;
  /** Wall-clock start and end (ms since epoch); markers are stamped in wall-clock time. */
  unixStartMs?: number;
  unixEndMs?: number;
  bounds: { x?: number; y?: number; width: number; height: number };
  changes: string | null;
}

export interface RecordingMeta {
  dir: string;
  videoRecorder: any;
  inputRecorder: any;
  /** Pause/resume sessions of the screen channel, laid end to end in source time. */
  sessions: RecordingSession[];
  durationMs: number;
  /** A camera channel with at least one session (the type name is matched loosely: camera or webcam). */
  hasCamera: boolean;
  /**
   * Microphone sessions in source time. Session i plays over screen session i,
   * the same mapping the transcript's words use.
   */
  microphone: (Span & { audio: string })[];
}

export async function readRecordingMeta(projectPath: string): Promise<RecordingMeta> {
  const dir = join(projectPath, "recording");
  const meta = await json(join(dir, "metadata.json"));
  const recorders: any[] = meta.recorders ?? [];
  const videoRecorder = recorders.find((r) => ["window", "display"].includes(r.type));
  const inputRecorder = recorders.find((r) => r.type === "input");
  if (!videoRecorder) throw new Error("Recording has no screen video channel.");
  let durationMs = 0;
  const sessions = videoRecorder.sessions.map((s: any) => {
    const startMs = durationMs;
    durationMs += s.durationMs;
    return {
      startMs,
      endMs: durationMs,
      video: join(dir, s.outputFilename),
      processStart: s.processTimeStartMs,
      unixStartMs: s.unixStartMs,
      unixEndMs: s.unixEndMs,
      bounds: s.bounds ?? s.initialWindowBounds,
      changes: s.changesFilename ? join(dir, s.changesFilename) : null,
    };
  });
  const hasCamera = recorders.some(
    (r) => /camera|webcam/i.test(String(r.type ?? "")) && (r.sessions?.length ?? 0) > 0,
  );
  const micRecorder = recorders.find((r) => r.type === "microphone");
  const microphone = (micRecorder?.sessions ?? []).flatMap((s: any, i: number) =>
    sessions[i] && s.outputFilename
      ? [{ startMs: sessions[i].startMs, endMs: sessions[i].endMs, audio: join(dir, s.outputFilename) }]
      : [],
  );
  return { dir, videoRecorder, inputRecorder, sessions, durationMs, hasCamera, microphone };
}

/**
 * Places wall-clock markers on the recording's source timeline. A marker inside
 * a session lands at its offset into that session; one stamped while recording
 * was paused (between sessions) snaps to the start of the next session, where
 * the beat it announced begins. Markers after the last session land at its end.
 * Sessions without wall-clock times (older recordings) place no markers.
 */
export function placeMarkers(
  raw: { id?: unknown; date?: unknown }[],
  sessions: { startMs: number; endMs: number; unixStartMs?: number; unixEndMs?: number }[],
): Marker[] {
  const timed = sessions.filter((s) => Number.isFinite(s.unixStartMs));
  if (!timed.length) return [];
  const out: Marker[] = [];
  for (const [i, m] of raw.entries()) {
    const at = typeof m?.date === "number" ? m.date : Date.parse(String(m?.date ?? ""));
    if (!Number.isFinite(at)) continue;
    let sourceMs: number | null = null;
    for (const s of timed) {
      const length = s.endMs - s.startMs;
      const end = Number.isFinite(s.unixEndMs) ? s.unixEndMs! : s.unixStartMs! + length;
      if (at < s.unixStartMs!) {
        sourceMs = s.startMs;
        break;
      }
      if (at <= end) {
        sourceMs = s.startMs + Math.min(length, at - s.unixStartMs!);
        break;
      }
    }
    sourceMs ??= timed.at(-1)!.endMs;
    out.push({ id: typeof m?.id === "string" ? m.id : `marker-${i + 1}`, sourceMs: Math.round(sourceMs) });
  }
  return out.sort((a, b) => a.sourceMs - b.sourceMs);
}

/** The project's recording markers file: superjson `{ json: [{ id, date }] }`, or a plain array. */
export async function readMarkerFile(projectPath: string): Promise<{ id?: unknown; date?: unknown }[]> {
  try {
    const data = await json(join(projectPath, "recording-markers.json"));
    const list = Array.isArray(data) ? data : data?.json;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Markers in source ms, read straight from the project without analysing the footage. */
export async function recordingMarkers(projectPath: string): Promise<Marker[]> {
  const { sessions } = await readRecordingMeta(projectPath);
  return placeMarkers(await readMarkerFile(projectPath), sessions);
}

export async function analyzeRecording(
  projectPath: string,
  options: { includeText?: boolean; cacheDir?: string } = {},
): Promise<Analysis> {
  const metaPath = join(projectPath, "recording", "metadata.json");
  // Typed text stays in memory only: it may hold passwords and would outlive the project.
  const cacheDir = options.includeText ? undefined : options.cacheDir;
  const markersMtime = await stat(join(projectPath, "recording-markers.json")).then(
    (s) => s.mtimeMs,
    () => 0,
  );
  const key = shortHash(`${projectPath}:${(await stat(metaPath)).mtimeMs}:${markersMtime}:v5`, 24);
  if (cacheDir)
    try {
      return await json(join(cacheDir, `analysis-${key}.json`));
    } catch {}
  const {
    dir,
    videoRecorder: videoRec,
    inputRecorder: inputRec,
    sessions,
    durationMs: total,
    hasCamera,
    microphone,
  } = await readRecordingMeta(projectPath);
  const first = sessions[0]?.bounds ?? { width: 1, height: 1 };

  const clicks: Click[] = [];
  const typing: Typing[] = [];
  const shortcuts: Shortcut[] = [];
  const movement: (Span & { distance01: number })[] = [];
  const inputTimes: number[] = [];
  for (const [i, input] of (inputRec?.sessions ?? []).entries()) {
    const session = sessions[i];
    if (!session) continue;
    const changes: any[] = session.changes ? await optional(session.changes) : [];
    const boundsAt = (processMs: number) => {
      let b = session.bounds;
      for (const c of changes) if (c.processTimeStartMs <= processMs && c.windowBounds) b = c.windowBounds;
      return b;
    };
    const toSource = (processMs: number) =>
      session.startMs +
      Math.min(Math.max(0, processMs - input.processTimeStartMs), session.endMs - session.startMs);
    const place = (p: { x: number; y: number; processTimeMs: number }) =>
      framePoint(p.x, p.y, boundsAt(p.processTimeMs));
    const raw: any[] = await optional(join(dir, input.mouseClicksFilename));
    for (let j = 0; j < raw.length; j++) {
      const down = raw[j];
      if (down.type !== "mouseDown") continue;
      const up = raw.slice(j + 1).find((e) => e.type === "mouseUp" && e.button === down.button) ?? down;
      const drag = Math.hypot(up.x - down.x, up.y - down.y) > 8;
      // Clicks on the Dock or another app are not in the video. A drag counts
      // where it is visible: from its start, or where it drops into the frame.
      const point = place(down) ?? (drag ? place(up) : null);
      if (!point) continue;
      const at = toSource(down.processTimeMs);
      clicks.push({ atMs: at, endMs: toSource(up.processTimeMs), ...point, drag, button: down.button });
      inputTimes.push(at);
    }
    const keys: any[] = (await optional(join(dir, input.keyStrokesFilename))).filter(
      (k: any) => k.type === "keyDown",
    );
    let burst: Typing | null = null;
    for (const k of keys) {
      const at = toSource(k.processTimeMs);
      inputTimes.push(at);
      const c = String(k.character ?? "");
      const name = keyName(c);
      const mods: string[] = (k.activeModifiers ?? []).filter((m: string) => m !== "shift");
      if (mods.length) {
        if (!k.isARepeat) shortcuts.push({ atMs: at, keys: mods.map((m) => MOD[m] ?? m).join("") + name });
        continue;
      }
      const text = isPrintable(c) ? c : TEXT_KEYS[name];
      const open = burst && at - burst.endMs < 1500 ? burst : null;
      if (open && (text !== undefined || name === "Delete")) {
        // Repeats and Delete keep a burst going without counting as typed characters.
        open.endMs = at;
        if (text !== undefined && !k.isARepeat) open.chars++;
        if (options.includeText) open.text = text !== undefined ? open.text + text : open.text!.slice(0, -1);
        continue;
      }
      if (k.isARepeat) continue;
      if (!isPrintable(c)) {
        // Navigation, Esc, Delete or a lone Return: a discrete action, not typing.
        shortcuts.push({ atMs: at, keys: name });
        continue;
      }
      const lastClick = [...clicks].reverse().find((x) => x.atMs <= at);
      burst = {
        startMs: at,
        endMs: at,
        chars: 1,
        ...(options.includeText ? { text } : {}),
        ...(lastClick ? { x: lastClick.x, y: lastClick.y } : {}),
      };
      typing.push(burst);
    }
    const moves: any[] = await optional(join(dir, input.mouseMovesFilename));
    let seg: (Span & { distance01: number }) | null = null;
    let prev: { x: number; y: number } | null = null;
    for (const m of moves) {
      const at = toSource(m.processTimeMs);
      const point = place(m);
      // Travel over other apps or screens is not on camera; leaving ends the segment.
      if (!point) {
        if (seg && seg.distance01 > 0.02) movement.push(seg);
        seg = null;
        prev = null;
        continue;
      }
      const d = prev ? Math.hypot(point.x - prev.x, point.y - prev.y) : 0;
      if (seg && at - seg.endMs < 250) {
        seg.endMs = at;
        seg.distance01 += d;
      } else {
        if (seg && seg.distance01 > 0.02) movement.push(seg);
        seg = { startMs: at, endMs: at, distance01: 0 };
      }
      prev = point;
      inputTimes.push(at);
    }
    if (seg && seg.distance01 > 0.02) movement.push(seg);
  }

  // Input alone still gives clicks, typing and idle when a video cannot be read.
  const screens = await Promise.all(
    sessions.map((s, i) =>
      screenActivity(s.video, s.startMs).then(
        (samples) => ({ samples, failure: null }),
        (e) => ({ samples: [], failure: `session ${i}: ${ffmpegFailure(e)}` }),
      ),
    ),
  );
  const samples = screens.flatMap((s) => s.samples);
  const failures = screens.flatMap((s) => (s.failure ? [s.failure] : []));
  const changes: ScreenChange[] = [];
  for (const s of samples) {
    if (s.score < 0.08) continue;
    const last = changes.at(-1);
    const kind = s.score >= 0.35 ? "page" : "region";
    if (last && s.t - last.atMs < 400) {
      if (s.score > last.score) Object.assign(last, { score: s.score, kind });
      continue;
    }
    changes.push({ atMs: s.t, score: s.score, kind });
  }
  const active = mergeSpans(
    samples.filter((s) => s.score > 0.003).map((s) => ({ startMs: s.t - 100, endMs: s.t })),
    350,
  );
  // An unread session might show anything, so none of it is offered as dead air.
  const unread = sessions.filter((_, i) => screens[i].failure);
  const busy = mergeSpans(
    [...active, ...unread, ...inputTimes.map((t) => ({ startMs: t - 150, endMs: t + 150 })), ...movement],
    200,
  );
  const idle: Span[] = [];
  let cursor = 0;
  for (const b of busy) {
    if (b.startMs - cursor >= 800) idle.push({ startMs: cursor, endMs: b.startMs });
    cursor = Math.max(cursor, b.endMs);
  }
  if (total - cursor >= 800) idle.push({ startMs: cursor, endMs: total });

  const r = (n: number) => Math.round(n);
  const rp = (n: number) => Math.round(n * 1000) / 1000;
  const result: Analysis = {
    projectPath,
    sourceDurationMs: r(total),
    hasCamera,
    hasMicrophone: microphone.length > 0,
    capture: { kind: videoRec.type, widthPt: first.width, heightPt: first.height },
    sessions: sessions.map((s) => ({ startMs: r(s.startMs), endMs: r(s.endMs), video: s.video })),
    clicks: clicks.map((c) => ({ ...c, atMs: r(c.atMs), endMs: r(c.endMs), x: rp(c.x), y: rp(c.y) })),
    typing: typing.map((t) => ({
      ...t,
      startMs: r(t.startMs),
      endMs: r(t.endMs),
      ...(t.x !== undefined ? { x: rp(t.x), y: rp(t.y!) } : {}),
    })),
    shortcuts: shortcuts.map((s) => ({ ...s, atMs: r(s.atMs) })),
    movement: movement.map((m) => ({
      startMs: r(m.startMs),
      endMs: r(m.endMs),
      distance01: rp(m.distance01),
    })),
    screen: {
      changes: changes.map((c) => ({ ...c, atMs: r(c.atMs), score: rp(c.score) })),
      active: active.map((a) => ({ startMs: r(Math.max(0, a.startMs)), endMs: r(a.endMs) })),
      ...(failures.length
        ? {
            unavailable: failures.join("; "),
            unread: unread.map((u) => ({ startMs: r(u.startMs), endMs: r(u.endMs) })),
          }
        : {}),
    },
    idle: idle.map((i) => ({ startMs: r(i.startMs), endMs: r(i.endMs) })),
    markers: placeMarkers(await readMarkerFile(projectPath), sessions),
  };
  if (cacheDir && !failures.length)
    await writeFile(await statePath(cacheDir, `analysis-${key}.json`), JSON.stringify(result), {
      mode: 0o600,
    });
  return result;
}

/** Locate the session video and local time for a source moment. */
export function sessionAt(analysis: Analysis, sourceMs: number) {
  const s =
    analysis.sessions.find((s) => sourceMs >= s.startMs && sourceMs < s.endMs) ?? analysis.sessions.at(-1)!;
  return { video: s.video, localMs: Math.max(0, Math.min(sourceMs, s.endMs - 1) - s.startMs) };
}
