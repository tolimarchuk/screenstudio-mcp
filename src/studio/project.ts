import { z } from "zod";
import { num as n, rect01, unit } from "./schemas.js";
const color = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
const point = z.object({ x: n, y: n }).strict();
const point01 = z.object({ x: unit, y: unit }).strict();
const gradient = z
  .object({
    start: point01,
    end: point01,
    stops: z
      .array(z.object({ color, at: unit }).strict())
      .min(2)
      .max(8)
      .refine((stops) => stops.every((s, i) => i === 0 || s.at >= stops[i - 1].at), {
        message: "Gradient stops must be in order of at.",
      }),
  })
  .strict();
const spring = z
  .object({
    stiffness: n.min(5).max(600),
    damping: n.min(5).max(200),
    mass: n.min(0.1).max(15),
    clamp: z.boolean().default(true),
    precision: n.min(0.0001).max(0.1).default(0.002),
  })
  .strict();

/**
 * Exact rules for settings whose values have known ranges or choices (from the
 * app's own schema). Any other field that exists in the project config can be
 * set too, as long as the value keeps the field's type. Fields inside a ruled
 * object (e.g. styles.background.gradient.stops) are checked by its rule.
 */
export const configFields: Record<string, z.ZodType> = {
  "crop.rect01": rect01,
  "cursor.size": n.min(8).max(256),
  "cursor.hide": z.boolean(),
  "cursor.set": z
    .object({ id: z.string().min(1), variants: z.record(z.string(), z.unknown()).default({}) })
    .strict(),
  "cursor.rotationMode": z.enum(["velocity", "directional"]),
  "cursor.hideNotMovingAfterMs": n.min(0).max(10000).nullable(),
  "cursor.stopMovementInLastPartMs": n.min(0).max(5000),
  "cursor.removeShakeTreshold": n.min(0).max(2000),
  "cursor.loopPositionBeforeEndMs": n.min(0).max(5000).nullable(),
  "cursor.clickEffect": z.union([
    z.null(),
    z.object({ type: z.literal("circle") }).strict(),
    z.object({ type: z.literal("ripple"), pullSize01: unit.optional() }).strict(),
  ]),
  "captions.enableTranscript": z.boolean(),
  "captions.enableShortcuts": z.boolean(),
  "captions.showShortcutsWithSingleLetters": z.boolean(),
  "captions.shortcutsSizeRatio": n.min(0.02).max(0.3),
  "captions.showSoundLabels": z.boolean(),
  "captions.font": z.enum(["serif", "sans-serif", "mono"]),
  "captions.sizeRatio": n.min(0.01).max(0.25),
  "captions.color": color,
  "captions.backgroundColor": color,
  "captions.position01": point,
  "captions.hiddenShortcuts": z.record(z.string().min(1).max(100), z.boolean()),
  "captions.wordsReveal": z.enum(["line-by-line", "word-by-word"]),
  "captions.lineGrowth": z.enum(["entire-line", "left-anchored", "centered"]),
  "captions.wordEntrance": z.enum(["appear", "fade-in", "slide-in"]),
  "audio.volume": n.min(0).max(2),
  "audio.muteMicrophone": z.boolean(),
  "audio.microphoneAudioPreset": z.enum(["voice", "noise-reduction", "podcast"]),
  "audio.muteSystemAudio": z.boolean(),
  "audio.backgroundAudioVolume": unit,
  "audio.muteBackgroundAudio": z.boolean(),
  "audio.clickSoundEffect": z.enum(["apple-magic-mouse", "logitech-mx-master"]).nullable(),
  "audio.clickSoundEffectVolume": unit,
  "camera.hide": z.boolean(),
  "camera.mirror": z.boolean(),
  "camera.aspectRatio": n.min(0.2).max(5),
  "camera.enableFaceTracking": z.boolean(),
  "camera.hideDuringSilenceMs": n.min(0).max(60000).nullable(),
  "camera.lut": z.string().min(1).nullable(),
  "camera.lutIntensity": unit,
  "camera.grain": unit,
  "camera.sharpen01": unit,
  "camera.crop01": rect01,
  "camera.background.blurAmount01": unit,
  "camera.background.edgeFalloff01": unit,
  "processing.improveRecordingQuality01": unit,
  "zooms.startAnimationEarly": z.boolean(),
  "animations.motionBlurAmount": n.min(0).max(2),
  "animations.screenMovementSpring": spring,
  "animations.mouseMovementSpring": spring,
  "defaultLayout.type": z.enum(["camera-overlay", "split-screen", "cutout-camera"]),
  "defaultLayout.cameraOverlay.overlayCameraPosition01": point,
  "defaultLayout.cameraOverlay.overlayCameraSizeRatio01": unit,
  "defaultLayout.cameraOverlay.overlayCameraPaddingRatio01": unit,
  "defaultLayout.cameraOverlay.overlayCameraAspectRatio": n.min(0.2).max(5),
  "defaultLayout.cameraOverlay.overlayZoomedCameraScale": unit,
  "defaultLayout.splitScreen.splitDirection": z.enum(["auto", "horizontal", "vertical"]),
  "defaultLayout.splitScreen.splitFlip": z.boolean(),
  "defaultLayout.splitScreen.splitScreenRatio01": unit.nullable(),
  "defaultLayout.splitScreen.enablePadding": z.boolean(),
  "defaultLayout.cutoutCamera.cutoutCameraPositionX01": unit,
  "defaultLayout.cutoutCamera.cutoutCameraSizeRatio01": n.min(0.1).max(1.5),
  "defaultLayout.cutoutCamera.cutoutCameraZoomedScale": unit,
  "defaultLayout.cutoutCamera.cutoutCameraAspectRatio": n.min(0.2).max(5).nullable(),
  "styles.screenBorderRadius": n.min(0).max(200),
  "styles.cameraBorderRadiusRatio01": unit,
  "styles.screenInset.size": n.min(0).max(100),
  "styles.screenInset.color": color,
  "styles.screenInset.alpha": unit,
  "styles.screenInset.origin01": point01,
  "styles.background.type": z.enum(["color", "gradient", "system", "image", "unsplash"]),
  "styles.background.color": color,
  "styles.background.gradient": gradient,
  "styles.background.systemName": z.string().regex(/^[\w .&-]+\/[\w .&-]+\.(jpg|jpeg|png|heic)$/),
  "styles.background.blur": n.min(0).max(100),
  "styles.shadow.intensity": unit,
  "styles.shadow.distance": n.min(0).max(200),
  "styles.shadow.angle": n.min(0).max(360),
  "styles.shadow.blur": n.min(0).max(200),
  "styles.shadow.isDirectional": z.boolean(),
  "device.enableMockup": z.boolean(),
  "device.frameKey": z.string().min(1).nullable(),
  "output.paddingRatio01": n.min(0).max(0.4),
  "output.aspectRatio": z.union([z.literal("auto"), n.min(0.2).max(5)]),
  "output.avoidEmptyZoomArea": z.boolean(),
};

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const unknownField = (key: string) =>
  new Error(`Unknown config field: ${key}. Read the editor state for the project's config.`);

function currentValue(config: any, parts: string[], key: string) {
  let target = config;
  for (const part of parts) {
    if (!target || typeof target !== "object" || !Object.hasOwn(target, part)) throw unknownField(key);
    target = target[part];
  }
  return target;
}

/**
 * Validates one dotted config change against the live project config and
 * returns the value to write at that key.
 * - Known fields use exact rules, and a field inside a ruled object (a spring's
 *   stiffness, a gradient's stops) is checked as part of that whole object.
 * - A group of fields (styles.shadow) is merged field by field, so every nested
 *   rule still applies and no field can be added or dropped.
 * - Any other existing field must keep its type. A field that is currently null
 *   and has no rule accepts only plain values, since its object shape is unknown.
 */
export function validateConfigChange(config: any, key: string, value: unknown): unknown {
  const parts = key.split(".");
  if (parts.some((p) => !p || FORBIDDEN.has(p))) throw new Error(`Invalid config key: ${key}`);
  if (parts.length < 2) {
    const example =
      Object.keys(configFields).find((k) => k.startsWith(`${key}.`)) ?? "styles.background.color";
    throw new Error(`Set one field inside the ${key} group, like ${example}, not the whole group.`);
  }
  const current = currentValue(config, parts, key);
  if (Object.hasOwn(configFields, key)) return configFields[key].parse(value);
  for (let i = parts.length - 1; i >= 2; i--) {
    const owner = parts.slice(0, i).join(".");
    if (!Object.hasOwn(configFields, owner)) continue;
    const whole = structuredClone(currentValue(config, parts.slice(0, i), owner));
    let node = whole;
    for (const part of parts.slice(i, -1)) node = node[part];
    node[parts.at(-1)!] = value;
    let parsed: any = configFields[owner].parse(whole);
    for (const part of parts.slice(i)) parsed = parsed[part];
    return parsed;
  }
  if (kind(current) === "object") {
    if (kind(value) !== "object") throw new Error(`${key} expects object, got ${kind(value)}.`);
    const merged = structuredClone(current);
    for (const [field, v] of Object.entries(value as object)) {
      if (field.includes(".")) throw new Error(`Invalid config key: ${key}.${field}`);
      merged[field] = validateConfigChange(config, `${key}.${field}`, v);
    }
    return merged;
  }
  if (current === null && value !== null && typeof value === "object")
    throw new Error(`${key} has no known shape to check an object against. Set it in the app.`);
  if (current !== null && value !== null && kind(current) !== kind(value))
    throw new Error(`${key} expects ${kind(current)}, got ${kind(value)}.`);
  return JSON.parse(JSON.stringify(value));
}
