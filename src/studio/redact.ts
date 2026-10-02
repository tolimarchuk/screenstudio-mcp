// Finds private text in recorded frames and turns it into blur masks: sample
// frames (on a grid and around screen changes), read them with the native OCR,
// classify the text, follow each finding across frames, and cover the whole
// stretch it could be visible with one padded box. Found values stay in memory;
// results only ever carry a masked preview.
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { exec, ffmpeg, filterPath, frameAt, hasFilter, labelFont } from "./media.js";
import { subtractSpans, type Span } from "./spans.js";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface OcrWord {
  /** UTF-16 offsets into the line's text. */
  start: number;
  end: number;
  box: Rect;
}
/** One line of recognized text; boxes are 0-1 of the frame with a top-left origin. */
export interface OcrLine {
  text: string;
  confidence: number;
  box: Rect;
  words?: OcrWord[];
}

export const SENSITIVE_KINDS = [
  "custom",
  "api-key",
  "jwt",
  "url-token",
  "credential",
  "email",
  "card",
  "phone",
  "ipv4",
  "hex-secret",
  "base64-secret",
] as const;
export type SensitiveKind = (typeof SENSITIVE_KINDS)[number];

export interface Match {
  kind: SensitiveKind;
  start: number;
  end: number;
  value: string;
  /** Plain-English name of what was found, e.g. "GitHub token". */
  label: string;
}

interface Detector {
  kind: SensitiveKind;
  label: string;
  pattern: RegExp;
  /** `before` is the line's text in front of the value. */
  accept?: (value: string, before: string) => boolean;
  /** Capture group holding the value to hide (the pattern needs the d flag); the whole match otherwise. */
  group?: number;
}

const digits = (s: string) => s.replace(/\D/g, "");

/** Luhn checksum, which every real payment card number passes. */
export function luhn(number: string) {
  const d = digits(number);
  if (d.length < 12) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0;
}

/** Shannon entropy in bits per character: random tokens score high, words low. */
export function entropy(s: string) {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

const mixed = (s: string) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s);
/** A file path made of words ("/Users/Sam/Projects2024/MyApp"), not a base64 secret that holds slashes. */
const wordPath = (s: string) =>
  /^[/~]/.test(s) && s.split("/").every((p) => /^(?:~|[A-Za-z][A-Za-z._-]*\d*|)$/.test(p));
/** Values that name nothing secret even after a "token:" or "key=" label. */
const plainValue = (v: string) => /^(?:\d+|true|false|null|none|undefined|\*+|•+)$/i.test(v);
/**
 * A key or hash in hex: at least 32 hex digits with a letter among them.
 * Digits alone are an ID. A link's path segment that starts with 17 or more
 * digits (`before`, the text in front, ends in "/") is a post, order or user ID
 * that OCR ran into the text beside it. Anywhere else a digit run proves
 * nothing: random hex holds one now and then (about 1 in 70 128-digit keys has
 * a 17-digit run somewhere), and a missed key leaks while an extra blur costs
 * nothing.
 */
export function hexKey(value: string, before = "") {
  const v = value.replace(/^0x/i, "");
  if (v.length < 32 || !/^[0-9a-f]+$/i.test(v) || !/\d/.test(v) || !/[a-f]/i.test(v)) return false;
  return !(/^\d{17}/.test(v) && /\/$/.test(before));
}

// In priority order: when findings overlap they merge into one, named by the earliest.
const DETECTORS: Detector[] = [
  {
    kind: "api-key",
    label: "private key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  { kind: "api-key", label: "Secret API key (sk- prefix)", pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { kind: "api-key", label: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g },
  { kind: "api-key", label: "Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "api-key", label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "api-key", label: "Stripe key", pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { kind: "api-key", label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{30,}/g },
  {
    kind: "api-key",
    label: "AWS secret key",
    pattern: /(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g,
    accept: (v) => mixed(v) && entropy(v) >= 3.5 && !wordPath(v),
  },
  {
    kind: "jwt",
    label: "JSON web token",
    pattern: /\beyJ[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]+){0,2}/g,
  },
  {
    kind: "url-token",
    label: "link carrying a token",
    // The scheme is optional: an address bar shows "example.com/reset?token=...".
    pattern:
      /(?:\bhttps?:\/\/)?\b(?:localhost|(?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?(?:\/[^\s"'<>?#]*)?[?&#](?:[^\s"'<>]*?[?&#])?(?:access_token|refresh_token|id_token|token|api_?key|key|secret|sig|signature|auth|password|pwd|code|session|sid|x-amz-signature|x-amz-credential)=[^\s&"'<>]{6,}[^\s"'<>]*/gi,
  },
  {
    kind: "credential",
    label: "password in a link",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/([^\s/:@]+:[^\s@/]+)@/dgi,
    group: 1,
  },
  {
    kind: "credential",
    label: "password",
    pattern:
      /(?:^|[\s"'{,;(])[A-Za-z0-9_.-]*(?:password|passwd|passphrase|pwd)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?([^\s"',;]{3,})/dgi,
    group: 1,
    accept: (v) => !/^(?:\*+|•+|null|none|undefined)$/i.test(v),
  },
  {
    kind: "credential",
    label: "secret in a setting",
    pattern:
      /(?:^|[\s"'{,;(])[A-Za-z0-9_.-]*(?:secret|token|api[_-]?key|private[_-]?key|access[_-]?key|auth[_-]?key|client[_-]?secret|dsn|database[_-]?url|connection[_-]?string)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?([^\s"',;]{8,})/dgi,
    group: 1,
    accept: (v) => !plainValue(v),
  },
  {
    kind: "email",
    label: "email address",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
  },
  {
    kind: "card",
    label: "card number",
    // Not a path segment: digits after a slash are an ID in a link (a post, an order).
    pattern: /(?<![\d/-])(?:\d[ -]?){12,18}\d(?![\d-])/g,
    accept: (v) => luhn(v) && !/^(\d)\1+$/.test(digits(v)),
  },
  {
    kind: "phone",
    label: "phone number",
    // E.164, as payment, auth and CRM dashboards print numbers.
    pattern: /(?<![\w+])\+[1-9]\d{7,14}(?!\d)/g,
  },
  {
    kind: "phone",
    label: "phone number",
    // Ten or eleven digits with nothing between them count only next to a phone label.
    pattern: /\b(?:phone|tel|mobile|cell|whatsapp|sms)\b[^\d\n]{0,12}(\d{10,11})(?!\d)/dgi,
    group: 1,
  },
  {
    kind: "phone",
    label: "phone number",
    pattern:
      /(?<![\w+.]|\d[ -])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?|\d{2,4}[ .-])\d{3,4}[ .-]?\d{3,4}(?![\w.]?\d|[ -]\d)/g,
    accept: (v) => {
      const n = digits(v).length;
      return n >= 10 && n <= 15;
    },
  },
  {
    kind: "ipv4",
    label: "IP address",
    pattern: /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\.?\d)/g,
    // Loopback and "any" addresses say nothing about anyone.
    accept: (v) => !/^127\./.test(v) && v !== "0.0.0.0",
  },
  {
    kind: "hex-secret",
    label: "long hex string (key or hash)",
    // 0x-prefixed too, as wallets and crypto libraries print private keys.
    pattern: /(?<![A-Za-z0-9])(?:0x)?[0-9a-fA-F]{32,}(?![A-Za-z0-9])/g,
    accept: hexKey,
  },
  {
    kind: "base64-secret",
    label: "random-looking token",
    pattern: /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{32,}={0,2}/g,
    accept: (v) => mixed(v) && entropy(v) >= 3.5 && !wordPath(v),
  },
];

/**
 * Turns the person's extra terms into detectors: plain words match anywhere,
 * case-insensitively; /pattern/flags is a regular expression.
 */
export function customDetectors(terms: string[] = []): Detector[] {
  return terms
    .filter((t) => t.trim())
    .map((term) => {
      const regex = /^\/(.+)\/([a-z]*)$/s.exec(term);
      let pattern: RegExp;
      try {
        pattern = regex
          ? new RegExp(regex[1], regex[2].includes("g") ? regex[2] : regex[2] + "g")
          : new RegExp(term.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      } catch (e) {
        throw new Error(`Extra term ${term} is not a valid regular expression: ${(e as Error).message}`);
      }
      return { kind: "custom" as const, label: "term you asked to hide", pattern };
    });
}

/**
 * Every private-looking value in one line of text. Overlapping findings merge
 * into one that covers them all, so a short term you add never leaves the rest
 * of a longer secret around it showing; the merged finding is named by the most
 * specific detector (the built-in ones, in order, before your own terms).
 */
export function findSensitive(text: string, extra: Detector[] = [], ignore: SensitiveKind[] = []): Match[] {
  const all: (Match & { rank: number })[] = [];
  for (const [rank, d] of [...DETECTORS, ...extra].entries()) {
    if (ignore.includes(d.kind)) continue;
    for (const m of text.matchAll(d.pattern)) {
      const at = d.group
        ? (m as RegExpMatchArray & { indices?: [number, number][] }).indices?.[d.group]
        : undefined;
      const start = at ? at[0] : m.index!;
      const value = at ? text.slice(at[0], at[1]) : m[0];
      const end = start + value.length;
      if (!value.trim() || (d.accept && !d.accept(value, text.slice(0, start)))) continue;
      all.push({ kind: d.kind, start, end, value, label: d.label, rank });
    }
  }
  const merged: (Match & { rank: number })[] = [];
  for (const m of all.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = merged.at(-1);
    if (last && m.start < last.end) {
      last.end = Math.max(last.end, m.end);
      if (m.rank < last.rank) Object.assign(last, { kind: m.kind, label: m.label, rank: m.rank });
      last.value = text.slice(last.start, last.end);
    } else merged.push({ ...m });
  }
  return merged.map(({ rank: _r, ...m }) => m);
}

/** First and last two characters only, so results never repeat a secret. */
export function maskedPreview(value: string) {
  const v = value.trim();
  if (v.length <= 4) return "•".repeat(v.length);
  if (v.length <= 8) return `${v[0]}…${v.at(-1)}`;
  return `${v.slice(0, 2)}…${v.slice(-2)}`;
}

export const unionRect = (rects: Rect[]): Rect => {
  if (rects.length === 1) return { ...rects[0] };
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
};
const area = (r: Rect) => r.width * r.height;
function iou(a: Rect, b: Rect) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / (area(a) + area(b) - w * h);
}
const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** A horizontal slice of a box by character offsets, as if every character were the same width. */
function slice(box: Rect, from: number, to: number, length: number): Rect {
  const w = box.width / Math.max(1, length);
  // One character of slack each side: real fonts are not monospaced.
  const x0 = Math.max(box.x, box.x + w * (from - 1));
  const x1 = Math.min(box.x + box.width, box.x + w * (to + 1));
  return { x: x0, y: box.y, width: x1 - x0, height: box.height };
}

/**
 * Box of characters start..end in a line. Uses Vision's word boxes when they
 * are real; a word box as wide as the whole line is Vision declining to split
 * it, so that part falls back to an even slice of the line.
 */
export function matchBox(line: OcrLine, start: number, end: number): Rect {
  const real = (line.words ?? []).filter(
    (w) =>
      w.end > w.start && !(w.box.width >= line.box.width * 0.95 && w.end - w.start < line.text.length * 0.9),
  );
  const parts: Rect[] = [];
  let covered = true;
  for (let i = start; i < end; i++) {
    if (/\s/.test(line.text[i])) continue;
    if (!real.some((w) => i >= w.start && i < w.end)) covered = false;
  }
  for (const w of real) {
    if (w.end <= start || w.start >= end) continue;
    const exact = start <= w.start && end >= w.end;
    parts.push(
      exact
        ? w.box
        : slice(w.box, Math.max(start, w.start) - w.start, Math.min(end, w.end) - w.start, w.end - w.start),
    );
  }
  if (!covered || !parts.length) parts.push(slice(line.box, start, end, line.text.length));
  return unionRect(parts);
}

/** A finding in one frame. `key` groups the same value across frames and never leaves this module. */
export interface FrameFinding {
  kind: SensitiveKind;
  label: string;
  key: string;
  preview: string;
  box: Rect;
  confidence: number;
}

export function frameFindings(
  lines: OcrLine[],
  extra: Detector[] = [],
  ignore: SensitiveKind[] = [],
): FrameFinding[] {
  return lines.flatMap((line) =>
    findSensitive(line.text, extra, ignore).map((m) => ({
      kind: m.kind,
      label: m.label,
      key: m.value.toLowerCase().replace(/\s+/g, ""),
      preview: maskedPreview(m.value),
      box: matchBox(line, m.start, m.end),
      confidence: line.confidence,
    })),
  );
}

export interface Sample {
  atMs: number;
  findings: FrameFinding[];
}

export interface Detection {
  kind: SensitiveKind;
  label: string;
  preview: string;
  /** Source ms to blur: from the last frame without it to the first frame after it. */
  startMs: number;
  endMs: number;
  firstSeenMs: number;
  lastSeenMs: number;
  frames: number;
  /** Padded union of every place it was seen, 0-1 of the capture. */
  box: Rect;
  confidence: number;
  reason: string;
}

export interface TrackOptions {
  durationMs: number;
  typing?: { startMs: number; endMs: number; y?: number }[];
  /** Extra source ms added before and after each span. */
  padMs?: number;
  /** Box padding as a share of the text height (at least 0.004 of the frame). */
  padRatio?: number;
}

const r3 = (n: number) => Math.round(n * 10000) / 10000;
const clampRect = (r: Rect): Rect => {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  return {
    x: r3(x),
    y: r3(y),
    width: r3(Math.min(1, r.x + r.width) - x),
    height: r3(Math.min(1, r.y + r.height) - y),
  };
};

/**
 * Follows each finding from frame to frame. A finding continues a track when
 * it is the same kind and either the same text or in the same place (OCR may
 * misread a character between frames), seen again within two missed samples,
 * so a value OCR misses twice in a row stays one blur with no gap.
 * Each track's span runs from the sample before it was first seen to the
 * sample after it was last seen, so nothing shows between samples; text that
 * was typed in starts at the first keystroke.
 */
export function trackFindings(samples: Sample[], options: TrackOptions): Detection[] {
  const pad = options.padMs ?? 50;
  const padRatio = options.padRatio ?? 0.35;
  const sorted = [...samples].sort((a, b) => a.atMs - b.atMs);
  type Track = { first: number; last: number; findings: FrameFinding[]; keys: Set<string> };
  const tracks: Track[] = [];
  sorted.forEach((sample, i) => {
    const taken = new Set<Track>();
    for (const f of sample.findings) {
      const candidates = tracks.filter(
        (t) =>
          !taken.has(t) &&
          t.last >= i - 3 &&
          t.last < i &&
          t.findings[0].kind === f.kind &&
          (t.keys.has(f.key) || iou(t.findings.at(-1)!.box, f.box) > 0.5),
      );
      const best = candidates.sort(
        (a, b) => iou(b.findings.at(-1)!.box, f.box) - iou(a.findings.at(-1)!.box, f.box),
      )[0];
      const track = best ?? { first: i, last: i, findings: [], keys: new Set<string>() };
      if (!best) tracks.push(track);
      track.last = i;
      track.findings.push(f);
      track.keys.add(f.key);
      taken.add(track);
    }
  });
  return tracks.map((t) => {
    const firstSeenMs = sorted[t.first].atMs;
    const lastSeenMs = sorted[t.last].atMs;
    let startMs = t.first > 0 ? sorted[t.first - 1].atMs : 0;
    const endMs = t.last < sorted.length - 1 ? sorted[t.last + 1].atMs : options.durationMs;
    const box = unionRect(t.findings.map((f) => f.box));
    const textHeight = t.findings.reduce((n, f) => n + f.box.height, 0) / t.findings.length;
    const reasons = [
      `${t.findings[0].label} seen in ${t.findings.length} frame${t.findings.length > 1 ? "s" : ""}`,
    ];
    const centerY = box.y + box.height / 2;
    const typed = (options.typing ?? []).find(
      (b) =>
        b.startMs < firstSeenMs &&
        b.endMs >= startMs - 1500 &&
        (b.y === undefined || Math.abs(b.y - centerY) < 0.15),
    );
    if (typed && typed.startMs < startMs) {
      startMs = typed.startMs;
      reasons.push("it was typed in, so the blur starts at the first keystroke");
    }
    const p = Math.max(0.004, textHeight * padRatio);
    return {
      kind: t.findings[0].kind,
      label: t.findings[0].label,
      preview: t.findings[0].preview,
      startMs: Math.round(Math.max(0, startMs - pad)),
      endMs: Math.round(Math.min(options.durationMs, endMs + pad)),
      firstSeenMs: Math.round(firstSeenMs),
      lastSeenMs: Math.round(lastSeenMs),
      frames: t.findings.length,
      box: clampRect({ x: box.x - p, y: box.y - p, width: box.width + 2 * p, height: box.height + 2 * p }),
      confidence: Math.round(Math.min(...t.findings.map((f) => f.confidence)) * 100) / 100,
      reason: reasons.join("; "),
    };
  });
}

/** Unions the pair of rects that grows the covered area least until at most `max` remain; overlapping rects always merge. */
export function reduceRects(rects: Rect[], max = 10): Rect[] {
  let out = rects.map((r) => ({ ...r }));
  for (;;) {
    let best: [number, number, number] | null = null;
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        const grow = area(unionRect([out[i], out[j]])) - area(out[i]) - area(out[j]);
        const must = intersects(out[i], out[j]);
        const cost = must ? -1 : grow;
        if ((must || out.length > max) && (!best || cost < best[2])) best = [i, j, cost];
      }
    if (!best) return out;
    const [i, j] = best;
    out = [...out.filter((_, k) => k !== i && k !== j), unionRect([out[i], out[j]])];
  }
}

export interface MaskOp {
  op: "addMask";
  type: "sensitive-data";
  startMs: number;
  endMs: number;
  rects: Rect[];
}
export interface MaskUpdate {
  op: "updateItem";
  track: "masks";
  id: string;
  fields: { rects: Rect[] };
}

/** A mask already on the track. Only an enabled sensitive-data mask with known rects can take more boxes. */
export interface ExistingMask extends Span {
  id?: string;
  /** sensitive-data or highlight; unknown counts as sensitive-data. */
  type?: string;
  disabled?: boolean;
  /** Its boxes, 0-1 of the capture, when known. */
  rects?: Rect[];
}

const contains = (outer: Rect, r: Rect) =>
  outer.x <= r.x + 1e-4 &&
  outer.y <= r.y + 1e-4 &&
  outer.x + outer.width >= r.x + r.width - 1e-4 &&
  outer.y + outer.height >= r.y + r.height - 1e-4;

/**
 * Lays detections onto Screen Studio's mask track, where items cannot overlap:
 * each stretch with the same set of findings becomes one mask with a rect per
 * finding (at most 10), stretches shorter than `minMs` fold into a neighbour so
 * the blur does not flicker. Where an enabled sensitive-data mask already sits,
 * its boxes grow to cover the new findings (an updateItem op). Where a highlight
 * or a disabled mask sits, nothing can blur there: that time is reported.
 */
export function maskOps(
  detections: Pick<Detection, "startMs" | "endMs" | "box">[],
  options: { existing?: ExistingMask[]; minMs?: number; maxRects?: number } = {},
) {
  const minMs = options.minMs ?? 400;
  const cuts = [...new Set(detections.flatMap((d) => [d.startMs, d.endMs]))].sort((a, b) => a - b);
  type Segment = Span & { ids: Set<number> };
  let segments: Segment[] = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const s = { startMs: cuts[k], endMs: cuts[k + 1] };
    const ids = new Set(
      detections.flatMap((d, i) => (d.startMs <= s.startMs && d.endMs >= s.endMs ? [i] : [])),
    );
    if (!ids.size) continue;
    const last = segments.at(-1);
    const same = last && last.ids.size === ids.size && [...ids].every((i) => last.ids.has(i));
    if (last && last.endMs === s.startMs && same) last.endMs = s.endMs;
    else segments.push({ ...s, ids });
  }
  // A short stretch with no neighbour touching it stays: it still hides something.
  const alone = new Set<Segment>();
  for (;;) {
    const i = segments.findIndex((s) => s.endMs - s.startMs < minMs && !alone.has(s));
    if (i < 0) break;
    const s = segments[i];
    const before = segments[i - 1]?.endMs === s.startMs ? segments[i - 1] : undefined;
    const after = segments[i + 1]?.startMs === s.endMs ? segments[i + 1] : undefined;
    const into =
      before && after
        ? before.endMs - before.startMs <= after.endMs - after.startMs
          ? before
          : after
        : (before ?? after);
    if (!into) {
      alone.add(s);
      continue;
    }
    into.startMs = Math.min(into.startMs, s.startMs);
    into.endMs = Math.max(into.endMs, s.endMs);
    for (const id of s.ids) into.ids.add(id);
    segments = segments.filter((x) => x !== s);
  }
  const existing = options.existing ?? [];
  const blurs = (e: ExistingMask) => (e.type ?? "sensitive-data") === "sensitive-data" && !e.disabled;
  const ops: (MaskOp | MaskUpdate)[] = [];
  const skipped: (Span & { maskId?: string; reason?: "highlight" | "disabled" })[] = [];
  const grow = new Map<ExistingMask, Rect[]>();
  for (const s of segments) {
    const boxes = [...s.ids].map((i) => detections[i].box);
    for (const e of existing) {
      if (!(e.startMs < s.endMs && e.endMs > s.startMs)) continue;
      const overlap = {
        startMs: Math.max(s.startMs, e.startMs),
        endMs: Math.min(s.endMs, e.endMs),
        ...(e.id ? { maskId: e.id } : {}),
      };
      if (!blurs(e)) skipped.push({ ...overlap, reason: e.disabled ? "disabled" : "highlight" });
      else if (e.id && e.rects?.length) {
        const missing = boxes.filter((b) => !(grow.get(e) ?? e.rects!).some((r) => contains(r, b)));
        if (missing.length) grow.set(e, [...(grow.get(e) ?? e.rects), ...missing]);
      } else skipped.push(overlap);
    }
    const rects = reduceRects(boxes, options.maxRects ?? 10).map(clampRect);
    for (const piece of subtractSpans([s], existing, 1))
      ops.push({
        op: "addMask",
        type: "sensitive-data",
        startMs: Math.round(piece.startMs),
        endMs: Math.round(piece.endMs),
        rects,
      });
  }
  for (const [e, rects] of grow)
    ops.push({
      op: "updateItem",
      track: "masks",
      id: e.id!,
      fields: { rects: reduceRects(rects, options.maxRects ?? 10).map(clampRect) },
    });
  return { ops, skipped };
}

/** Rects of an existing mask as 0-1 of the capture, from its bounds in capture points. */
export function maskRects(
  bounds: unknown,
  capture?: { widthPt: number; heightPt: number },
): Rect[] | undefined {
  if (!Array.isArray(bounds) || !bounds.length || !capture?.widthPt || !capture?.heightPt) return undefined;
  const rects = bounds.map((b: any) =>
    [b?.x, b?.y, b?.width, b?.height].every((v) => typeof v === "number" && Number.isFinite(v))
      ? clampRect({
          x: b.x / capture.widthPt,
          y: b.y / capture.heightPt,
          width: b.width / capture.widthPt,
          height: b.height / capture.heightPt,
        })
      : null,
  );
  return rects.every(Boolean) ? (rects as Rect[]) : undefined;
}

/**
 * Source times to read: a regular grid, the last moment, and just before and
 * just after each screen change, so a finding's span is tight where the
 * screen changed. When everything would not fit maxFrames, the grid widens so
 * it still covers the whole recording in at most 70% of the frames, and the
 * rest go to changes, page changes before region changes. `stepMs` is the grid
 * interval used; `capped` says some changes were left unread.
 */
export function samplePlan(
  durationMs: number,
  everyMs: number,
  changes: { atMs: number; kind: "region" | "page" }[] = [],
  maxFrames = 400,
) {
  const end = Math.max(0, durationMs - 50);
  const around = (kind: "region" | "page") =>
    changes.filter((c) => c.kind === kind).flatMap((c) => [c.atMs - 120, c.atMs + 250]);
  const changeFrames = around("page").length + around("region").length;
  const gridFrames = (step: number) => Math.ceil(end / step) + 1;
  let stepMs = everyMs;
  if (gridFrames(stepMs) + changeFrames > maxFrames && gridFrames(stepMs) > Math.floor(maxFrames * 0.7))
    stepMs = Math.max(everyMs, Math.ceil(end / Math.max(1, Math.floor(maxFrames * 0.7) - 1)));
  const grid: number[] = [end];
  for (let t = 0; t < end; t += stepMs) grid.push(t);
  const kept: number[] = [];
  const near = (t: number) => kept.some((k) => Math.abs(k - t) < 100);
  let capped = false;
  for (const group of [grid, around("page"), around("region")])
    for (const t of group) {
      const c = Math.min(end, Math.max(0, Math.round(t)));
      if (near(c)) continue;
      if (kept.length >= maxFrames) {
        capped = true;
        break;
      }
      kept.push(c);
    }
  return { times: kept.sort((a, b) => a - b), stepMs, capped };
}

/** The source times samplePlan reads. */
export function sampleTimes(
  durationMs: number,
  everyMs: number,
  changes: { atMs: number; kind: "region" | "page" }[] = [],
  maxFrames = 400,
) {
  return samplePlan(durationMs, everyMs, changes, maxFrames).times;
}

const helper = fileURLToPath(new URL("../../native/desktop-helper", import.meta.url));

/** Runs the native OCR on PNG files, returning the lines found in each. */
export async function recognizeText(pngs: string[]): Promise<OcrLine[][]> {
  if (process.platform !== "darwin") throw new Error("Text recognition requires macOS.");
  await access(helper).catch(() => {
    throw new Error("Build the native helper with npm run build:native to read text in frames.");
  });
  const out: OcrLine[][] = pngs.map(() => []);
  for (let i = 0; i < pngs.length; i += 20) {
    const batch = pngs.slice(i, i + 20);
    // The first call loads Vision's models, which can take most of a minute.
    const { stdout } = await exec(helper, ["ocr", ...batch], {
      timeout: 60000 + batch.length * 10000,
      maxBuffer: 64 * 1024 * 1024,
    }).catch((e: any) => {
      throw new Error(`Text recognition failed: ${String(e?.stderr ?? e?.message ?? e).trim()}`);
    });
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const { image, ...rest } = JSON.parse(line);
      out[i + image]?.push(rest);
    }
  }
  return out;
}

/** Extracts frames at source times through `locate`, a few ffmpeg processes at a time. */
export async function extractFrames(
  times: number[],
  locate: (sourceMs: number) => { video: string; localMs: number },
  dir: string,
) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const files = times.map((t, i) => join(dir, `frame-${String(i).padStart(4, "0")}-${t}.png`));
  let next = 0;
  const worker = async () => {
    while (next < times.length) {
      const i = next++;
      const { video, localMs } = locate(times[i]);
      // Full resolution reads small text best; very large frames only slow OCR down.
      await frameAt(video, localMs / 1000, files[i], {
        vf: "scale='min(2560,iw)':-2",
        timeoutMs: 30000,
      }).catch((e: any) => {
        const reason = String(e?.stderr ?? e?.message ?? e)
          .trim()
          .split("\n")
          .at(-1);
        throw new Error(
          `Could not read the frame at ${(times[i] / 1000).toFixed(2)}s of the recording: ${reason}`,
        );
      });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return files;
}

/** What the preview draws on one frame. */
export interface PreviewFrame {
  file: string;
  atMs: number;
  /** Every box a blur covers at this moment, filled solid so no value shows. */
  fills: Rect[];
  /** Each finding on screen then, ringed and tagged with a masked label (never the value). */
  marks: { box: Rect; label: string }[];
}

/**
 * Up to `max` read frames that show findings, chosen so every finding is in
 * at least one: the frame showing the most findings not yet shown first,
 * earliest on a tie. Spare slots go to the last frame each finding was seen
 * in, so a box can be checked at both ends. Indices into `samples`, in time order.
 */
export function previewFrames(
  samples: Sample[],
  detections: Pick<Detection, "firstSeenMs" | "lastSeenMs">[],
  max = 6,
) {
  const showing = samples.map((s) =>
    s.findings.length
      ? detections.flatMap((d, k) => (d.firstSeenMs <= s.atMs && s.atMs <= d.lastSeenMs ? [k] : []))
      : [],
  );
  const picked: number[] = [];
  const shown = new Set<number>();
  while (picked.length < max) {
    let best = -1;
    let gain = 0;
    showing.forEach((ks, i) => {
      const g = picked.includes(i) ? 0 : ks.filter((k) => !shown.has(k)).length;
      if (g > gain) [best, gain] = [i, g];
    });
    if (best < 0) break;
    picked.push(best);
    for (const k of showing[best]) shown.add(k);
  }
  for (const d of detections) {
    if (picked.length >= max) break;
    const last = samples.findIndex((s, i) => s.atMs === d.lastSeenMs && showing[i].length);
    if (last >= 0 && !picked.includes(last)) picked.push(last);
  }
  return picked.sort((a, b) => samples[a].atMs - samples[b].atMs);
}

/**
 * The boxes for a preview frame at `atMs`. Filled: every new mask active then,
 * every blur mask already on the track (with the boxes an update gives it), and
 * every finding's blur span, so the preview never shows a found value or what a
 * hand-made blur hides. Ringed and labelled, by number in `detections` (from
 * 1), kind and masked preview: only the findings actually seen around then, so
 * a ring never sits on a spot where the finding is not shown. `unknown` counts
 * blur masks active then whose boxes are unknown, so they could not be filled.
 */
export function previewMarks(
  atMs: number,
  detections: Pick<
    Detection,
    "kind" | "preview" | "startMs" | "endMs" | "firstSeenMs" | "lastSeenMs" | "box"
  >[],
  ops: (MaskOp | MaskUpdate)[],
  existing: ExistingMask[] = [],
): Pick<PreviewFrame, "fills" | "marks"> & { unknown: number } {
  const blurred = detections.filter((d) => d.startMs <= atMs && atMs <= d.endMs);
  const seen = detections.flatMap((d, k) =>
    d.firstSeenMs <= atMs && atMs <= d.lastSeenMs ? [{ d, k }] : [],
  );
  let unknown = 0;
  const kept = existing.flatMap((m) => {
    if (m.disabled || (m.type && m.type !== "sensitive-data") || m.startMs > atMs || m.endMs < atMs)
      return [];
    const update = ops.find((o): o is MaskUpdate => o.op === "updateItem" && !!m.id && o.id === m.id);
    const rects = update?.fields.rects ?? m.rects;
    if (!rects?.length) unknown++;
    return rects ?? [];
  });
  return {
    fills: [
      ...ops.flatMap((o) => (o.op === "addMask" && o.startMs <= atMs && o.endMs >= atMs ? o.rects : [])),
      ...kept,
      ...blurred.map((d) => d.box),
    ],
    marks: seen.map(({ d, k }) => ({ box: d.box, label: `${k + 1} ${d.kind} ${d.preview}` })),
    unknown,
  };
}

const PREVIEW_BG = "0x1c1c1e";
/** Labels listed under a frame, at most; more show as "+N more". */
const SHEET_LABELS = 8;

/**
 * The filter graph for the preview sheet: each frame fitted to the cell's
 * width at its own aspect (`frameRatio`, 16:9 when unknown; portrait frames sit
 * three across), every blur filled red, every finding ringed in yellow on black
 * (thick, and wider than the text, so a box on a line of small text still shows
 * at a glance) and tagged with its number only, so nothing beside the ring is
 * covered. The time and each finding's full label (number, kind, masked value)
 * sit in a strip under the frame, never over it. Cells are laid out in rows
 * with a gutter between them.
 * Labels are read from files with expansion off, so they need no escaping; with
 * no font, boxes are drawn without labels or numbers.
 */
export function sheetFilter(
  frames: (Pick<PreviewFrame, "atMs" | "fills" | "marks"> & { labelFiles?: string[] })[],
  options: { cellWidth?: number; columns?: number; font?: string | null; frameRatio?: number } = {},
) {
  if (!frames.length) throw new Error("No frames to preview.");
  const ratio = options.frameRatio && options.frameRatio > 0 ? options.frameRatio : 16 / 9;
  const cw = Math.max(960, Math.round((options.cellWidth ?? 960) / 2) * 2);
  const ch = Math.max(2, Math.round(cw / ratio / 2) * 2);
  const cols = Math.min(options.columns ?? (ratio < 1 ? 3 : 2), frames.length);
  const rows = Math.ceil(frames.length / cols);
  const thick = Math.round(cw / 240);
  const gap = Math.round(cw / 160);
  const size = Math.max(14, Math.round(cw / 50));
  const font = options.font ? `fontfile='${filterPath(options.font)}':` : null;
  // The strip under each frame: the time, then one line per label, the same height in every cell.
  const lineH = Math.round(size * 1.6);
  const lines = font ? 1 + Math.min(SHEET_LABELS, Math.max(0, ...frames.map((f) => f.marks.length))) : 0;
  const strip = font ? Math.round((lines * lineH + size / 2) / 2) * 2 : 0;
  const cellH = ch + strip;
  // A box at least 2px each way: drawbox reads a 0 width or height as the whole frame.
  const at = (r: Rect, grow: number) => {
    const out = grow ? `-${grow}` : "";
    const wider = grow ? `+${2 * grow}` : "";
    return `x='${r3(r.x)}*iw${out}':y='${r3(r.y)}*ih${out}':w='max(2,${r3(r.width)}*iw)${wider}':h='max(2,${r3(r.height)}*ih)${wider}'`;
  };
  const outline = `borderw=${Math.max(2, Math.round(size / 8))}:bordercolor=black`;
  const cells = frames.map((f, i) => {
    const listed = f.marks.slice(0, SHEET_LABELS - (f.marks.length > SHEET_LABELS ? 1 : 0));
    const steps = [
      `scale=${cw}:${ch}:force_original_aspect_ratio=decrease`,
      "setsar=1",
      ...f.fills.map((r) => `drawbox=${at(r, 0)}:color=0xff3b30:t=fill`),
      ...f.marks.flatMap((m) => [
        `drawbox=${at(m.box, gap + 2)}:color=black:t=${thick + 4}`,
        `drawbox=${at(m.box, gap)}:color=0xffd60a:t=${thick}`,
      ]),
      // The number alone, outlined and with no fill box, just above the ring (below it at the top edge).
      ...(font
        ? f.marks.flatMap((m) => {
            const n = labelNumber(m.label);
            if (!n) return [];
            const above = `${r3(m.box.y)}*h-${gap + 4}-th`;
            const below = `${r3(m.box.y + m.box.height)}*h+${gap + 4}`;
            return `drawtext=${font}text='${n}':fontsize=${size}:fontcolor=0xffd60a:${outline}:x='max(2,min(w-tw-2,${r3(m.box.x)}*w-${gap}))':y='if(gte(${above},2),${above},min(h-th-2,${below}))'`;
          })
        : []),
      `pad=${cw}:${cellH}:(ow-iw)/2:(${ch}-ih)/2:color=${PREVIEW_BG}`,
      ...(font
        ? [
            `drawtext=${font}text='${(f.atMs / 1000).toFixed(1)}s':fontsize=${size}:fontcolor=white:x=${size}:y=${ch + Math.round(size / 2)}`,
            ...listed.flatMap((m, j) => {
              const file = f.labelFiles?.[j];
              if (!file) return [];
              return [
                `drawtext=${font}textfile='${filterPath(file)}':expansion=none:fontsize=${size}:fontcolor=0xffd60a:x=${size}:y=${ch + Math.round(size / 2) + (j + 1) * lineH}`,
              ];
            }),
            ...(f.marks.length > listed.length
              ? [
                  `drawtext=${font}text='+${f.marks.length - listed.length} more':fontsize=${size}:fontcolor=white:x=${size}:y=${ch + Math.round(size / 2) + (listed.length + 1) * lineH}`,
                ]
              : []),
          ]
        : []),
    ];
    return `[${i}:v]${steps.join(",")}[c${i}]`;
  });
  if (frames.length === 1)
    return { graph: cells[0], out: "[c0]", cols, rows, cellWidth: cw, cellHeight: cellH };
  // A gutter between cells, so two light frames side by side still read as two.
  const gutter = 8;
  const layout = frames
    .map((_, i) => `${(i % cols) * (cw + gutter)}_${Math.floor(i / cols) * (cellH + gutter)}`)
    .join("|");
  const inputs = frames.map((_, i) => `[c${i}]`).join("");
  return {
    graph: `${cells.join(";")};${inputs}xstack=inputs=${frames.length}:layout=${layout}:fill=${PREVIEW_BG}[sheet]`,
    out: "[sheet]",
    cols,
    rows,
    cellWidth: cw,
    cellHeight: cellH,
  };
}

/** The number a label starts with ("3 email ja…om" is 3): digits only, safe to inline in a filter. */
const labelNumber = (label: string) => /^\d+/.exec(label)?.[0] ?? "";

/**
 * Writes the preview sheet: up to six frames, each at least 960px wide, with
 * every blur filled and every finding ringed and labelled by its masked
 * preview, so the sheet shows what gets hidden without showing any value.
 * Label files go in `workDir`, which the caller removes.
 */
export async function contactSheet(
  frames: PreviewFrame[],
  out: string,
  options: { workDir: string; cellWidth?: number; columns?: number; frameRatio?: number },
) {
  const shown = frames.slice(0, 6);
  const font = (await hasFilter("drawtext")) ? await labelFont() : null;
  const labelled = await Promise.all(
    shown.map(async (f, i) => {
      if (!font) return f;
      const dir = join(options.workDir, "preview-labels");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const labelFiles = await Promise.all(
        f.marks.map(async (m, j) => {
          const file = join(dir, `${i}-${j}.txt`);
          await writeFile(file, m.label, { mode: 0o600 });
          return file;
        }),
      );
      return { ...f, labelFiles };
    }),
  );
  const sheet = sheetFilter(labelled, {
    cellWidth: options.cellWidth,
    columns: options.columns,
    font,
    frameRatio: options.frameRatio,
  });
  await ffmpeg(
    [
      "-y",
      ...shown.flatMap((f) => ["-i", f.file]),
      "-filter_complex",
      sheet.graph,
      "-map",
      sheet.out,
      "-frames:v",
      "1",
      out,
    ],
    { timeoutMs: 60000 },
  );
  return {
    out,
    cols: sheet.cols,
    rows: sheet.rows,
    frames: shown.length,
    labelled: !!font,
    cellWidth: sheet.cellWidth,
    cellHeight: sheet.cellHeight,
  };
}

/**
 * The scan's result with its preview drawn, or, when drawing fails, the result
 * on its own with a note saying why. Masks may already be applied by then, so
 * the caller must still get their ops, notes and checkpoint.
 */
export async function withPreview<T extends { notes: string[] }, R>(
  result: T,
  draw: () => Promise<R>,
): Promise<R | T> {
  try {
    return await draw();
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { ...result, notes: [...result.notes, `Preview could not be drawn: ${reason}`] };
  }
}

export const removeDir = (dir: string) => rm(dir, { recursive: true, force: true });

export interface ScanOptions {
  everyMs: number;
  extraTerms?: string[];
  ignore?: SensitiveKind[];
  maxFrames?: number;
}

/**
 * Reads the recording's frames and returns every finding followed across
 * time. `dir` holds the extracted frames until the caller removes it.
 */
export async function scanRecording(
  analysis: {
    sourceDurationMs: number;
    sessions: { startMs: number; endMs: number; video: string }[];
    screen: { changes: { atMs: number; kind: "region" | "page" }[] };
    typing: { startMs: number; endMs: number; y?: number }[];
  },
  dir: string,
  options: ScanOptions,
) {
  const extra = customDetectors(options.extraTerms);
  const { times, stepMs, capped } = samplePlan(
    analysis.sourceDurationMs,
    options.everyMs,
    analysis.screen.changes,
    options.maxFrames,
  );
  const locate = (t: number) => {
    const s = analysis.sessions.find((s) => t >= s.startMs && t < s.endMs) ?? analysis.sessions.at(-1)!;
    return { video: s.video, localMs: Math.max(0, Math.min(t, s.endMs - 1) - s.startMs) };
  };
  const files = await extractFrames(times, locate, dir);
  const lines = await recognizeText(files);
  const samples = times.map((atMs, i) => ({
    atMs,
    findings: frameFindings(lines[i], extra, options.ignore),
  }));
  const detections = trackFindings(samples, {
    durationMs: analysis.sourceDurationMs,
    typing: analysis.typing,
  }).sort((a, b) => a.startMs - b.startMs);
  return {
    times,
    stepMs,
    capped,
    files,
    samples,
    detections,
    textLines: lines.reduce((n, l) => n + l.length, 0),
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Plain-English reasons for what the scan found and proposes. */
export function scanNotes(input: {
  everyMs: number;
  /** The grid interval actually used, when the frame budget widened it. */
  stepMs?: number;
  frames: number;
  changes: number;
  textLines: number;
  detections: Detection[];
  ops: (MaskOp | MaskUpdate)[];
  skipped: (Span & { maskId?: string; reason?: "highlight" | "disabled" })[];
  /** true or "applied": all ops landed; "partial": some did; false or "none": nothing was changed. */
  applied: boolean | "applied" | "partial" | "none";
  /** With a partial apply: how many ops landed and the checkpoint to undo them. */
  landed?: number;
  checkpointId?: string;
  capped: boolean;
}) {
  const step = input.stepMs ?? input.everyMs;
  const notes = [
    `Read ${plural(input.frames, "frame")}: one every ${(step / 1000).toFixed(1)}s from start to end plus one just before and after ${plural(input.changes, "screen change")}, so a mask starts and stops close to when the screen changed.`,
  ];
  if (step > input.everyMs)
    notes.push(
      `The recording is too long for one frame every ${(input.everyMs / 1000).toFixed(1)}s within maxFrames, so frames were read every ${(step / 1000).toFixed(1)}s to cover all of it, ending included. Raise maxFrames to read more often.`,
    );
  if (input.capped)
    notes.push(
      "The frame limit was reached, so some screen changes were not read; raise maxFrames, or lower everyMs on a shorter stretch, if text flashes by.",
    );
  if (!input.textLines)
    notes.push(
      "No text was readable in any frame. Check the recording plays, or that it is not mostly video or images.",
    );
  if (!input.detections.length) {
    notes.push(
      "Nothing private-looking was found. This reads text only: still check faces, avatars, profile photos and pasted screenshots by eye before publishing.",
    );
    return notes;
  }
  const counts = new Map<string, number>();
  for (const d of input.detections) counts.set(d.label, (counts.get(d.label) ?? 0) + 1);
  notes.push(
    `Found ${plural(input.detections.length, "thing")} to hide: ${[...counts].map(([label, n]) => `${n} ${label}`).join(", ")}.`,
  );
  const added = input.ops.filter((o) => o.op === "addMask").length;
  const grown = input.ops.filter((o) => o.op === "updateItem").length;
  notes.push(
    `Proposed ${plural(added, "blur mask")}${grown ? ` and ${plural(grown, "existing blur")} grown to cover new findings` : ""}. Each blur runs from the last frame without the text to the first frame after it, so nothing shows between the frames that were read, and each box is padded beyond the text.`,
  );
  const typed = input.detections.filter((d) => d.reason.includes("typed"));
  if (typed.length)
    notes.push(
      `${plural(typed.length, "value")} ${typed.length === 1 ? "was" : "were"} typed on screen, so the blur starts at the first keystroke.`,
    );
  const low = input.detections.filter((d) => d.confidence < 0.5);
  if (low.length)
    notes.push(
      `${plural(low.length, "finding")} ${low.length === 1 ? "was" : "were"} read with low confidence; look at the preview to confirm.`,
    );
  for (const s of input.skipped) {
    const at = `${(s.startMs / 1000).toFixed(1)}-${(s.endMs / 1000).toFixed(1)}s`;
    const id = s.maskId ? ` (${s.maskId})` : "";
    notes.push(
      s.reason
        ? `${at} holds a ${s.reason === "disabled" ? "disabled mask" : "highlight mask"}${id}, which hides nothing, and masks cannot overlap, so a blur cannot go there until that mask is removed. The preview shows what would be exposed.`
        : `${at} already has a mask${id} whose boxes are unknown, and masks cannot overlap, so no new mask was added there. Check that mask covers the boxes shown, or remove it and run this again.`,
    );
  }
  const status = input.applied === true ? "applied" : input.applied === false ? "none" : input.applied;
  notes.push(
    status === "applied"
      ? "Masks were added in the open editor; Cmd+Z or screenstudio_editor_restore with the checkpoint undoes them."
      : status === "partial"
        ? `Stopped partway: ${input.landed !== undefined ? `the first ${plural(input.landed, "op")} landed` : "some ops landed"} in the open editor and nothing was saved. Undo them with screenstudio_editor_restore${input.checkpointId ? ` and checkpoint ${input.checkpointId}` : ""} before running again, or the same masks would be added twice.`
        : "Nothing was changed. Pass ops to screenstudio_editor_apply, or run again with apply: true.",
  );
  return notes;
}
