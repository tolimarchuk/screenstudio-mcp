// ffmpeg, ffprobe and screencapture, found and spawned one way.
import { execFile } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

export const exec = promisify(execFile);

/** ffmpeg or ffprobe: an env override, the usual install places, then PATH. Null when missing. */
export async function locateTool(name: "ffmpeg" | "ffprobe"): Promise<string | null> {
  const env = process.env[name === "ffmpeg" ? "SCREENSTUDIO_FFMPEG" : "SCREENSTUDIO_FFPROBE"];
  if (env) return env;
  // ffprobe sits next to an ffmpeg given by path.
  const sibling =
    name === "ffprobe" && process.env.SCREENSTUDIO_FFMPEG ? [dirname(process.env.SCREENSTUDIO_FFMPEG)] : [];
  const dirs = [
    ...sibling,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local/bin"),
    "/usr/bin",
    ...(process.env.PATH ?? "").split(":").filter(Boolean),
  ];
  for (const dir of dirs) {
    const p = join(dir, name);
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

export async function findTool(name: "ffmpeg" | "ffprobe"): Promise<string> {
  const found = await locateTool(name);
  if (found) return found;
  throw new Error(
    `${name} not found. Install it with: brew install ffmpeg (or set ${name === "ffmpeg" ? "SCREENSTUDIO_FFMPEG" : "SCREENSTUDIO_FFPROBE"} to its path).`,
  );
}

/** Runs ffmpeg quietly (errors only) and returns its stdout. */
export async function ffmpeg(args: string[], options: { timeoutMs?: number; maxBuffer?: number } = {}) {
  const { stdout } = await exec(await findTool("ffmpeg"), ["-v", "error", ...args], {
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer,
  });
  return stdout;
}

/** Container and stream properties of a media file. */
export async function probe(path: string) {
  const { stdout } = await exec(
    await findTool("ffprobe"),
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size:stream=codec_name,width,height,avg_frame_rate",
      "-of",
      "json",
      path,
    ],
    { timeout: 15000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

export async function durationMs(path: string) {
  const { stdout } = await exec(
    await findTool("ffprobe"),
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
    { timeout: 30000 },
  );
  return Number(stdout) * 1000;
}

/**
 * Writes the frame at `seconds` into a video as a PNG, optionally through a
 * filter. A seek past the last frame writes nothing while ffmpeg still exits 0,
 * so an empty or missing output is an error here, not later.
 */
export async function frameAt(
  video: string,
  seconds: number,
  out: string,
  options: { vf?: string; timeoutMs?: number } = {},
) {
  await ffmpeg(
    [
      "-y",
      "-ss",
      String(seconds),
      "-i",
      video,
      "-frames:v",
      "1",
      ...(options.vf ? ["-vf", options.vf] : []),
      out,
    ],
    { timeoutMs: options.timeoutMs ?? 15000 },
  );
  const written = await stat(out).catch(() => null);
  if (!written?.size)
    throw new Error(
      `No frame at ${seconds.toFixed(3)}s in ${basename(video)}: the time is past its last frame.`,
    );
}

/** Burns an ASS subtitle file into a copy of a video; the audio is copied as is. */
export function burnSubtitles(video: string, ass: string, out: string) {
  return ffmpeg(
    [
      "-y",
      "-i",
      video,
      "-vf",
      `subtitles='${filterPath(ass)}'`,
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      out,
    ],
    { timeoutMs: 20 * 60000 },
  );
}

/** Crops an image to a pixel rectangle. */
export function cropPng(
  input: string,
  out: string,
  rect: { x: number; y: number; width: number; height: number },
) {
  return ffmpeg(["-y", "-i", input, "-vf", `crop=${rect.width}:${rect.height}:${rect.x}:${rect.y}`, out], {
    timeoutMs: 15000,
  });
}

/** Screenshots one native window, without its shadow. */
export async function captureWindow(windowId: number, out: string) {
  await exec("/usr/sbin/screencapture", ["-x", "-o", "-l", String(windowId), out], { timeout: 10000 });
}

// ---------------------------------------------------------------- delivery helpers

/** System fonts with the glyphs tile labels use, best first. */
const FONTS = [
  "/System/Library/Fonts/Helvetica.ttc",
  "/System/Library/Fonts/SFNS.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/Library/Fonts/Arial.ttf",
];

/** A font file drawtext can use, or null when none is installed. */
export async function labelFont(): Promise<string | null> {
  for (const f of FONTS)
    try {
      await access(f, constants.R_OK);
      return f;
    } catch {}
  return null;
}

let filterList: Promise<string> | null = null;
/** Whether this ffmpeg build has a filter (drawtext needs libfreetype, which some builds lack). */
export async function hasFilter(name: string) {
  filterList ??= findTool("ffmpeg")
    .then((ff) => exec(ff, ["-hide_banner", "-filters"], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }))
    .then((r) => r.stdout)
    .catch(() => "");
  return new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m").test(await filterList);
}

/** A path for a single-quoted ffmpeg filter option. */
export function filterPath(path: string) {
  if (/['\n\\]/.test(path)) throw new Error(`Path ${path} cannot be passed to an ffmpeg filter.`);
  return path.replace(/:/g, "\\:");
}

export interface TileLayout {
  columns: number;
  cellWidth: number;
  cellHeight: number;
  /** Per input, a file holding its label (read with expansion off, so it needs no escaping), or null. */
  labelFiles?: (string | null)[];
  font?: string | null;
  background?: string;
}

/**
 * The filter graph that fits each input into a cell (letterboxed, so mixed aspects line up),
 * draws its label on a dark band at the bottom, and lays the cells out in rows.
 */
export function tileFilter(count: number, l: TileLayout) {
  if (count < 1) throw new Error("A sheet needs at least one image.");
  const bg = l.background ?? "0x111111";
  const size = Math.max(14, Math.round(l.cellWidth / 26));
  const cells = Array.from({ length: count }, (_, i) => {
    const label = l.labelFiles?.[i];
    const text =
      label && l.font
        ? `,drawbox=x=0:y=ih-${size * 2}:w=iw:h=${size * 2}:color=black@0.6:t=fill,drawtext=fontfile='${filterPath(l.font)}':textfile='${filterPath(label)}':expansion=none:fontsize=${size}:fontcolor=white:x=${Math.round(size / 2)}:y=h-${Math.round(size * 1.5)}`
        : "";
    return `[${i}:v]scale=${l.cellWidth}:${l.cellHeight}:force_original_aspect_ratio=decrease,pad=${l.cellWidth}:${l.cellHeight}:(ow-iw)/2:(oh-ih)/2:color=${bg},setsar=1${text}[c${i}]`;
  });
  if (count === 1) return { graph: cells[0], out: "[c0]" };
  const layout = Array.from(
    { length: count },
    (_, i) => `${(i % l.columns) * l.cellWidth}_${Math.floor(i / l.columns) * l.cellHeight}`,
  ).join("|");
  const inputs = Array.from({ length: count }, (_, i) => `[c${i}]`).join("");
  return {
    graph: `${cells.join(";")};${inputs}xstack=inputs=${count}:layout=${layout}:fill=${bg}[sheet]`,
    out: "[sheet]",
  };
}

/** Lays images out in a labelled grid and writes it as one PNG. */
export async function tileImages(images: string[], out: string, layout: TileLayout) {
  const { graph, out: label } = tileFilter(images.length, layout);
  await ffmpeg(
    [
      "-y",
      ...images.flatMap((i) => ["-i", i]),
      "-filter_complex",
      graph,
      "-map",
      label,
      "-frames:v",
      "1",
      out,
    ],
    { timeoutMs: 60000 },
  );
}

/** The mean SSIM ("All") over the lines of an ffmpeg ssim stats file; null when it has none. */
export function parseSsim(stats: string): number | null {
  const all = [...stats.matchAll(/All:([\d.]+)/g)].map((m) => Number(m[1])).filter((n) => n >= 0);
  return all.length ? all.reduce((a, b) => a + b, 0) / all.length : null;
}

/** How alike two images are (SSIM, 0-1), both compared at 320 pixels wide. */
export async function ssim(a: string, b: string, stats: string) {
  await ffmpeg(
    [
      "-y",
      "-i",
      a,
      "-i",
      b,
      "-lavfi",
      `[0:v]scale=320:180,setsar=1[a];[1:v]scale=320:180,setsar=1[b];[a][b]ssim=stats_file='${filterPath(stats)}'`,
      "-f",
      "null",
      "-",
    ],
    { timeoutMs: 30000 },
  );
  const score = parseSsim(await readFile(stats, "utf8"));
  if (score === null) throw new Error("ffmpeg returned no similarity score.");
  return score;
}

/** Converts a video to a looping GIF with a palette made for it. */
export function toGif(video: string, out: string, o: { fps: number; height: number }) {
  return ffmpeg(
    [
      "-y",
      "-i",
      video,
      "-filter_complex",
      `fps=${o.fps},scale=-2:${o.height}:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`,
      "-loop",
      "0",
      out,
    ],
    { timeoutMs: 300000 },
  );
}

/** Converts a video to a silent VP9 WebM for the web. */
export function toWebm(video: string, out: string) {
  return ffmpeg(
    ["-y", "-i", video, "-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1", "-an", out],
    { timeoutMs: 600000 },
  );
}
