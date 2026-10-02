// Captions for AI narration: word timings from edge-tts subtitles, grouped into
// readable caption lines, and written as SRT or styled ASS for burn-in.
import type { Span } from "./spans.js";

export interface CaptionWord extends Span {
  text: string;
}
export interface Cue extends Span {
  text: string;
}

const srtTime = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/;
const toMs = (m: RegExpExecArray) =>
  ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4].padEnd(3, "0"));

/** SRT cues as edge-tts writes them (one per sentence or per word, depending on its version). */
export function parseSrt(text: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of text.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((l) => l.trim());
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [a, b] = lines[at].split("-->");
    const start = srtTime.exec(a);
    const end = srtTime.exec(b);
    const body = lines
      .slice(at + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (!start || !end || !body) continue;
    cues.push({ startMs: toMs(start), endMs: Math.max(toMs(start), toMs(end)), text: body });
  }
  return cues.sort((x, y) => x.startMs - y.startMs);
}

/**
 * One timed word per spoken word. A cue holding several words (edge-tts writes
 * sentence cues by default) is split across its time by each word's length, so
 * long words get more of it.
 */
export function cueWords(cues: Cue[]): CaptionWord[] {
  const words: CaptionWord[] = [];
  for (const cue of cues) {
    const parts = cue.text.split(/\s+/).filter(Boolean);
    const total = parts.reduce((n, p) => n + p.length, 0);
    let at = cue.startMs;
    for (const p of parts) {
      const length = ((cue.endMs - cue.startMs) * p.length) / total;
      words.push({ text: p, startMs: Math.round(at), endMs: Math.round(at + length) });
      at += length;
    }
  }
  return words;
}

/** Word timings spread over a clip when no subtitles came with it. */
export function estimateWords(text: string, durationMs: number): CaptionWord[] {
  return cueWords([{ startMs: 0, endMs: Math.max(0, Math.round(durationMs)), text }]);
}

/**
 * Groups words into caption lines a viewer can read at a glance: at most
 * `maxChars` characters, a new line after a sentence ends or a pause longer than `gapMs`.
 */
export function captionLines(words: CaptionWord[], maxChars = 42, gapMs = 600): Cue[] {
  const out: (Cue & { open: boolean })[] = [];
  for (const w of words) {
    const last = out.at(-1);
    if (
      last &&
      last.open &&
      w.startMs - last.endMs <= gapMs &&
      last.text.length + 1 + w.text.length <= maxChars
    ) {
      last.text += ` ${w.text}`;
      last.endMs = w.endMs;
    } else out.push({ startMs: w.startMs, endMs: w.endMs, text: w.text, open: true });
    if (/[.!?]["')\]]?$/.test(w.text)) out.at(-1)!.open = false;
  }
  return out.map(({ open: _o, ...c }) => c);
}

const stamp = (ms: number, sep: string, digits: 2 | 3) => {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor(t / 60000) % 60;
  const s = Math.floor(t / 1000) % 60;
  const frac =
    digits === 3 ? String(t % 1000).padStart(3, "0") : String(Math.floor((t % 1000) / 10)).padStart(2, "0");
  return `${digits === 3 ? String(h).padStart(2, "0") : h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${frac}`;
};

export function buildSrt(lines: Cue[]): string {
  return lines
    .map((c, i) => `${i + 1}\n${stamp(c.startMs, ",", 3)} --> ${stamp(c.endMs, ",", 3)}\n${c.text}\n`)
    .join("\n");
}

/** Caption look, read from the project's captions config. */
export interface CaptionStyle {
  font?: "serif" | "sans-serif" | "mono";
  sizeRatio?: number;
  color?: string;
  backgroundColor?: string;
  position01?: { x: number; y: number };
  wordsReveal?: "line-by-line" | "word-by-word";
}

const FONTS = { "sans-serif": "Helvetica Neue", serif: "Georgia", mono: "Menlo" };

/** `#rrggbb[aa]` as an ASS colour `&HAABBGGRR` (ASS alpha 00 is opaque). */
export function assColor(hex: string, alphaScale = 1): string {
  const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
  const [rgb, a] = m ? [m[1], m[2] ?? "ff"] : ["ffffff", "ff"];
  const opacity = (parseInt(a, 16) / 255) * alphaScale;
  const alpha = Math.round((1 - opacity) * 255);
  const h = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  return `&H${h(alpha)}${rgb.slice(4, 6).toUpperCase()}${rgb.slice(2, 4).toUpperCase()}${rgb.slice(0, 2).toUpperCase()}`;
}

/** ASS canvas for an output aspect ratio, 1080 on the short side. */
export function assCanvas(aspect: number) {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return aspect >= 1
    ? { width: even(1080 * aspect), height: 1080 }
    : { width: 1080, height: even(1080 / aspect) };
}

const assText = (s: string) => s.replace(/[{}\\]/g, "").replace(/\n/g, " ");

/**
 * An ASS subtitle file for burning narration captions into an export. Styled
 * like the project's own captions (font, size, colours, position); with
 * word-by-word reveal each word lights up as it is spoken (\k karaoke tags).
 */
/** Marks caption files this tool wrote, so it only ever replaces its own. */
export const CAPTIONS_MARKER = "; Narration captions written by screenstudio-mcp";

export function buildAss(
  lines: Cue[],
  words: CaptionWord[],
  style: CaptionStyle,
  canvas: { width: number; height: number },
): string {
  const size = Math.round((style.sizeRatio ?? 0.05) * canvas.height);
  const color = style.color ?? "#ffffff";
  const back = style.backgroundColor ?? "#000000b3";
  const margin = Math.round(canvas.height * 0.06);
  const x = Math.round((style.position01?.x ?? 0.5) * canvas.width);
  const y = Math.min(Math.round((style.position01?.y ?? 1) * canvas.height), canvas.height - margin);
  const karaoke = style.wordsReveal === "word-by-word";
  const head = [
    "[Script Info]",
    CAPTIONS_MARKER,
    "ScriptType: v4.00+",
    `PlayResX: ${canvas.width}`,
    `PlayResY: ${canvas.height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // BorderStyle 3 draws an opaque box in the outline colour behind each line.
    `Style: Narration,${FONTS[style.font ?? "sans-serif"]},${size},${assColor(color)},${assColor(color, 0.45)},${assColor(back)},${assColor(back)},1,0,0,0,100,100,0,0,3,${Math.round(size * 0.3)},0,2,${margin},${margin},${margin},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = lines.map((line) => {
    let text = assText(line.text);
    if (karaoke) {
      const inLine = words.filter((w) => w.startMs >= line.startMs && w.endMs <= line.endMs);
      if (inLine.length)
        text = inLine
          .map((w, i) => {
            const until = inLine[i + 1]?.startMs ?? w.endMs;
            return `{\\k${Math.max(1, Math.round((until - w.startMs) / 10))}}${assText(w.text)}`;
          })
          .join(" ");
    }
    return `Dialogue: 0,${stamp(line.startMs, ".", 2)},${stamp(line.endMs, ".", 2)},Narration,,0,0,0,,{\\an2\\pos(${x},${y})}${text}`;
  });
  return [...head, ...events, ""].join("\n");
}
