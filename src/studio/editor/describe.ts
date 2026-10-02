import { mapSlices, playbackRange, round, type Slice, type Zoom } from "../timeline.js";

/** Adds playback times and on-screen durations to a scene's timeline. */
export function describeScene(scene: { slices: Slice[]; zooms: Zoom[]; layouts?: any[]; masks?: any[] }) {
  const span = (x: any) => {
    const r = playbackRange(scene.slices, x.sourceStartMs, x.sourceEndMs);
    return {
      sourceStartMs: round(x.sourceStartMs),
      sourceEndMs: round(x.sourceEndMs),
      playbackStartMs: r ? round(r.startMs) : null,
      playbackEndMs: r ? round(r.endMs) : null,
    };
  };
  return {
    layouts: (scene.layouts ?? []).map((l) => ({
      id: l.id,
      type: l.type,
      ...span(l),
      disabled: l.isDisabled || undefined,
      cutoutCamera: l.cutoutCamera,
      cameraOverlay: l.cameraOverlay,
    })),
    masks: (scene.masks ?? []).map((m) => ({
      id: m.id,
      type: m.type,
      ...span(m),
      bounds: m.bounds,
      blur: m.blur,
      highlightMaskOpacity: m.highlightMaskOpacity,
    })),
    slices: mapSlices(scene.slices).map((s) => ({
      id: s.id,
      sourceStartMs: round(s.sourceStartMs),
      sourceEndMs: round(s.sourceEndMs),
      speed: Math.round(s.speed * 100) / 100,
      playbackStartMs: round(s.playbackStartMs),
      playbackEndMs: round(s.playbackEndMs),
    })),
    zooms: scene.zooms.map((z) => {
      const r = playbackRange(scene.slices, z.sourceStartMs, z.sourceEndMs);
      return {
        id: z.id,
        sourceStartMs: round(z.sourceStartMs),
        sourceEndMs: round(z.sourceEndMs),
        playbackStartMs: r ? round(r.startMs) : null,
        playbackEndMs: r ? round(r.endMs) : null,
        onScreenMs: r ? round(r.visibleMs) : 0,
        zoom: z.zoom,
        follow: z.type !== "manual",
        target: z.type === "manual" ? z.manualTargetPoint : undefined,
        presentation: z.presentation ?? "screen",
        loupe: z.presentation === "loupe" ? (z as any).loupeOptions : undefined,
        disabled: z.isDisabled || undefined,
      };
    }),
  };
}
