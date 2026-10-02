// Source time is the raw recording. Playback time is the edited video.
// Slices keep source ranges; timeScale 0.5 plays twice as fast.
export interface Slice {
  id?: string;
  sourceStartMs: number;
  sourceEndMs: number;
  timeScale: number;
}
export interface Zoom {
  id?: string;
  sourceStartMs: number;
  sourceEndMs: number;
  zoom: number;
  type?: string;
  presentation?: string;
  manualTargetPoint?: { x: number; y: number };
  isDisabled?: boolean;
  hasInstantAnimation?: boolean;
}
export interface Spring {
  stiffness: number;
  damping: number;
  mass: number;
  clamp?: boolean;
}
export interface MappedSlice extends Slice {
  speed: number;
  playbackStartMs: number;
  playbackEndMs: number;
}

export const round = (n: number) => Math.round(n);

export function mapSlices(slices: Slice[]): MappedSlice[] {
  let at = 0;
  return [...slices]
    .sort((a, b) => a.sourceStartMs - b.sourceStartMs)
    .map((s) => {
      const length = (s.sourceEndMs - s.sourceStartMs) * s.timeScale;
      const mapped = {
        ...s,
        speed: 1 / s.timeScale,
        playbackStartMs: at,
        playbackEndMs: at + length,
      };
      at += length;
      return mapped;
    });
}

export function playbackDuration(slices: Slice[]): number {
  return mapSlices(slices).at(-1)?.playbackEndMs ?? 0;
}

/** Playback time of a source moment, or null when that moment was cut. */
export function toPlayback(slices: Slice[], sourceMs: number): number | null {
  for (const s of mapSlices(slices))
    if (sourceMs >= s.sourceStartMs && sourceMs <= s.sourceEndMs)
      return s.playbackStartMs + (sourceMs - s.sourceStartMs) * s.timeScale;
  return null;
}

/** Playback time of a source moment, snapping a cut moment to the next kept frame. */
export function toPlaybackNearest(slices: Slice[], sourceMs: number): number {
  const mapped = mapSlices(slices);
  for (const s of mapped) {
    if (sourceMs < s.sourceStartMs) return s.playbackStartMs;
    if (sourceMs <= s.sourceEndMs) return s.playbackStartMs + (sourceMs - s.sourceStartMs) * s.timeScale;
  }
  return mapped.at(-1)?.playbackEndMs ?? 0;
}

export function toSource(slices: Slice[], playbackMs: number): number {
  const mapped = mapSlices(slices);
  for (const s of mapped)
    if (playbackMs <= s.playbackEndMs)
      return s.sourceStartMs + Math.max(0, playbackMs - s.playbackStartMs) / s.timeScale;
  return mapped.at(-1)?.sourceEndMs ?? 0;
}

/** Visible playback range and on-screen duration of a source interval. */
export function playbackRange(
  slices: Slice[],
  sourceStartMs: number,
  sourceEndMs: number,
): { startMs: number; endMs: number; visibleMs: number; maxSpeed: number } | null {
  let start: number | null = null;
  let end = 0;
  let visible = 0;
  let maxSpeed = 0;
  for (const s of mapSlices(slices)) {
    const a = Math.max(sourceStartMs, s.sourceStartMs);
    const b = Math.min(sourceEndMs, s.sourceEndMs);
    if (b <= a) continue;
    const pa = s.playbackStartMs + (a - s.sourceStartMs) * s.timeScale;
    const pb = s.playbackStartMs + (b - s.sourceStartMs) * s.timeScale;
    start ??= pa;
    end = pb;
    visible += pb - pa;
    maxSpeed = Math.max(maxSpeed, s.speed);
  }
  return start === null ? null : { startMs: start, endMs: end, visibleMs: visible, maxSpeed };
}

/**
 * Time for a Screen Studio spring to carry a zoom from wide to framed.
 * Clamped springs stop at the first crossing; others settle within 2%.
 */
export function springSettleMs(spring: Spring): number {
  const { stiffness: k, damping: c, mass: m } = spring;
  let x = 0;
  let v = 0;
  const dt = 1 / 600;
  for (let t = 0; t < 5; t += dt) {
    const a = (-k * (x - 1) - c * v) / m;
    v += a * dt;
    x += v * dt;
    const arrived = spring.clamp ? x >= 0.98 : Math.abs(x - 1) < 0.02;
    if (arrived && (spring.clamp || Math.abs(v) < 0.05)) return t * 1000;
  }
  return 5000;
}

export const SPRINGS = {
  // Screen Studio 4 presets, read from the app.
  screenSmooth: { stiffness: 170, damping: 50, mass: 3, clamp: true },
  screenFocused: { stiffness: 250, damping: 40, mass: 2.25, clamp: true },
  cursorSmooth: { stiffness: 470, damping: 70, mass: 3, clamp: true },
  cursorMedium: { stiffness: 340, damping: 60, mass: 3, clamp: true },
  schemaDefault: { stiffness: 125, damping: 12, mass: 1.5, clamp: true },
} as const;
