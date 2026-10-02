// Editing styles (pacing rules and matching settings), looks and output aspects.
// Rules follow Screen Studio 4's own auto-zoom and spring presets.
import { SPRINGS } from "./timeline.js";

export const STYLE_NAMES = ["calm", "balanced", "snappy"] as const;
export type Style = (typeof STYLE_NAMES)[number];
export const DEFAULT_STYLE: Style = "balanced";

export interface PacingRules {
  leadInMs: number; // kept before the first action of a beat
  holdAfterMs: number; // kept after an action so its result can be read
  resultWindowMs: number; // screen changes this soon after an action count as its result
  finalHoldMs: number; // the last result stays on screen
  openingHoldMs: number; // starting state shown before the first action
  minCutGapMs: number; // shorter pauses stay in; a cut must earn its jump
  maxPauseMs: number; // longest still moment left inside a beat
  typingSpeed: number;
  waitSpeed: number; // loading or other on-screen motion without input
  maxActionSpeed: number;
  zoomLeadMs: number;
  zoomHoldMs: number;
  zoomMinMs: number;
  zoomGroupGapMs: number;
  zoomWideGapMs: number;
  zoomsPerMinute: number;
  openingWideMs: number;
  closingWideMs: number;
  zoomLevels: number[];
  /** Cuts between scenes per 10s of playback: above cutsPer10s the edit is busy, above maxCutsPer10s too fast to follow. */
  cutsPer10s: number;
  maxCutsPer10s: number;
}

export const STYLES: Record<Style, PacingRules> = {
  calm: {
    leadInMs: 900,
    holdAfterMs: 1800,
    resultWindowMs: 4000,
    finalHoldMs: 3000,
    openingHoldMs: 1500,
    minCutGapMs: 1500,
    maxPauseMs: 1200,
    typingSpeed: 1.5,
    waitSpeed: 2,
    maxActionSpeed: 1,
    zoomLeadMs: 600,
    zoomHoldMs: 2000,
    zoomMinMs: 3000,
    zoomGroupGapMs: 5300,
    zoomWideGapMs: 3000,
    zoomsPerMinute: 2,
    openingWideMs: 2500,
    closingWideMs: 1500,
    zoomLevels: [1.6, 1.4, 1.25],
    cutsPer10s: 1.2,
    maxCutsPer10s: 2,
  },
  balanced: {
    leadInMs: 700,
    holdAfterMs: 1400,
    resultWindowMs: 3500,
    finalHoldMs: 2500,
    openingHoldMs: 1200,
    minCutGapMs: 1200,
    maxPauseMs: 900,
    typingSpeed: 2,
    waitSpeed: 3,
    maxActionSpeed: 1.25,
    zoomLeadMs: 500,
    zoomHoldMs: 1800,
    zoomMinMs: 2800,
    zoomGroupGapMs: 5300,
    zoomWideGapMs: 2500,
    zoomsPerMinute: 2.5,
    openingWideMs: 2500,
    closingWideMs: 1500,
    zoomLevels: [1.8, 1.5, 1.25],
    cutsPer10s: 1.2,
    maxCutsPer10s: 2,
  },
  snappy: {
    leadInMs: 500,
    holdAfterMs: 1100,
    resultWindowMs: 3000,
    finalHoldMs: 2000,
    openingHoldMs: 900,
    minCutGapMs: 900,
    maxPauseMs: 700,
    typingSpeed: 2.5,
    waitSpeed: 4,
    maxActionSpeed: 1.5,
    zoomLeadMs: 450,
    zoomHoldMs: 1500,
    zoomMinMs: 2500,
    zoomGroupGapMs: 4000,
    zoomWideGapMs: 2500,
    zoomsPerMinute: 3,
    openingWideMs: 2000,
    closingWideMs: 1000,
    zoomLevels: [1.8, 1.5, 1.25],
    // Social and launch edits cut on every beat, about one every 3s.
    cutsPer10s: 2.5,
    maxCutsPer10s: 4,
  },
};

export const STYLE_CONFIG: Record<Style, Record<string, unknown>> = {
  calm: {
    "animations.screenMovementSpring": { ...SPRINGS.screenSmooth, precision: 0.002 },
    "animations.mouseMovementSpring": { ...SPRINGS.cursorSmooth, precision: 0.002 },
    "cursor.hideNotMovingAfterMs": 1500,
    "cursor.stopMovementInLastPartMs": 800,
    "cursor.removeShakeTreshold": 500,
    "output.avoidEmptyZoomArea": false,
  },
  balanced: {
    "animations.screenMovementSpring": { ...SPRINGS.screenSmooth, precision: 0.002 },
    "animations.mouseMovementSpring": { ...SPRINGS.cursorMedium, precision: 0.002 },
    "cursor.hideNotMovingAfterMs": 1500,
    "cursor.stopMovementInLastPartMs": 800,
    "cursor.removeShakeTreshold": 500,
    "output.avoidEmptyZoomArea": false,
  },
  snappy: {
    "animations.screenMovementSpring": { ...SPRINGS.screenFocused, precision: 0.002 },
    "animations.mouseMovementSpring": { ...SPRINGS.cursorMedium, precision: 0.002 },
    "cursor.hideNotMovingAfterMs": 1200,
    "cursor.stopMovementInLastPartMs": 600,
    "cursor.removeShakeTreshold": 500,
    "output.avoidEmptyZoomArea": false,
  },
};

/** A diagonal gradient backdrop, top left to bottom right. */
const diagonal = (from: string, to: string) => ({
  start: { x: 0, y: 0 },
  end: { x: 1, y: 1 },
  stops: [
    { color: from, at: 0 },
    { color: to, at: 1 },
  ],
});

/**
 * Starting points for the frame around the recording. None is a default:
 * pick one that suits the content and brand, then adjust. Every look sets the
 * same cursor, click and motion settings, so a look never inherits them from the
 * one applied before; only the backdrop field its background type reads differs.
 * Every look keeps avoid-empty-zoom-area off so wide shots are never cropped.
 */
export const LOOKS: Record<string, Record<string, unknown>> = {
  wallpaper: {
    "styles.background.type": "system",
    "styles.background.systemName": "macOS/sonoma-horizon.jpg",
    "styles.screenBorderRadius": 16,
    "styles.shadow.intensity": 0.4,
    "output.paddingRatio01": 0.08,
    "cursor.size": 48,
    "cursor.clickEffect": { type: "ripple" },
    "audio.clickSoundEffect": null,
    "audio.clickSoundEffectVolume": 0.3,
    "animations.motionBlurAmount": 0.5,
    "output.avoidEmptyZoomArea": false,
  },
  gradient: {
    "styles.background.type": "gradient",
    "styles.background.gradient": diagonal("#4776e6", "#8e54e9"),
    "styles.screenBorderRadius": 18,
    "styles.shadow.intensity": 0.5,
    "output.paddingRatio01": 0.07,
    "cursor.size": 48,
    "cursor.clickEffect": { type: "ripple" },
    "audio.clickSoundEffect": "apple-magic-mouse",
    "audio.clickSoundEffectVolume": 0.3,
    "animations.motionBlurAmount": 0.6,
    "output.avoidEmptyZoomArea": false,
  },
  dark: {
    "styles.background.type": "system",
    "styles.background.systemName": "Midnight/midnight-8.jpg",
    "styles.screenBorderRadius": 14,
    "styles.shadow.intensity": 0.6,
    "output.paddingRatio01": 0.06,
    "cursor.size": 48,
    "cursor.clickEffect": { type: "circle" },
    "audio.clickSoundEffect": null,
    "audio.clickSoundEffectVolume": 0.3,
    "animations.motionBlurAmount": 0.5,
    "output.avoidEmptyZoomArea": false,
  },
  light: {
    "styles.background.type": "system",
    "styles.background.systemName": "macOS/sonoma-light.jpg",
    "styles.screenBorderRadius": 16,
    "styles.shadow.intensity": 0.25,
    "output.paddingRatio01": 0.08,
    "cursor.size": 48,
    "cursor.clickEffect": { type: "ripple" },
    "audio.clickSoundEffect": null,
    "audio.clickSoundEffectVolume": 0.3,
    "animations.motionBlurAmount": 0.4,
    "output.avoidEmptyZoomArea": false,
  },
  minimal: {
    "styles.background.type": "color",
    "styles.background.color": "#0e0f12",
    "styles.screenBorderRadius": 12,
    "styles.shadow.intensity": 0.3,
    "output.paddingRatio01": 0.04,
    "cursor.size": 48,
    "cursor.clickEffect": null,
    "audio.clickSoundEffect": null,
    "audio.clickSoundEffectVolume": 0.3,
    "animations.motionBlurAmount": 0.3,
    "output.avoidEmptyZoomArea": false,
  },
  social: {
    "styles.background.type": "gradient",
    "styles.background.gradient": diagonal("#ff5f6d", "#ffc371"),
    "styles.screenBorderRadius": 20,
    "styles.shadow.intensity": 0.5,
    "output.paddingRatio01": 0.04,
    "cursor.size": 64,
    "cursor.clickEffect": { type: "ripple" },
    "audio.clickSoundEffect": "apple-magic-mouse",
    "audio.clickSoundEffectVolume": 0.3,
    "animations.motionBlurAmount": 0.6,
    "output.avoidEmptyZoomArea": false,
  },
};
export const ASPECTS: Record<string, number | "auto"> = {
  "16:9": 16 / 9,
  "1:1": 1,
  "4:5": 0.8,
  "9:16": 9 / 16,
  auto: "auto",
};
