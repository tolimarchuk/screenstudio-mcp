// Named recipes: one word that sets a whole direction for a video. A recipe
// picks the pacing style, frame, aspect, plan options, captions, cursor, click
// sound, music, voice and export together, so they agree with each other.
// None is a default: choose the one that fits the content and where it will
// be watched, and nothing is applied unless a recipe is named.
import { z } from "zod";
import type { PlanOptions } from "./plan.js";
import type { Brand } from "./brand.js";
import { TARGET_NAMES, type TargetName } from "./deliver.js";
import { ASPECTS, LOOKS, STYLE_NAMES, type PacingRules, type Style } from "./styles.js";

export const RECIPE_NAMES = [
  "keynote",
  "social-vertical",
  "changelog",
  "founder-talking-head",
  "tutorial",
  "launch-teaser",
  "docs-walkthrough",
] as const;
export type RecipeName = (typeof RECIPE_NAMES)[number];

export type RecipePlan = Pick<
  PlanOptions,
  | "zoom"
  | "maxZooms"
  | "speedUps"
  | "tightenPausesMs"
  | "removeFillers"
  | "targetMs"
  | "structure"
  | "talkingHead"
  | "markers"
>;

export interface Recipe {
  name: RecipeName;
  /** When to reach for it, in a sentence. */
  useFor: string;
  style: Style;
  /** A starting frame from LOOKS, or null to keep the frame the recipe's config sets. */
  look: string | null;
  aspect: string;
  plan: RecipePlan;
  /** Pacing rule overrides on top of the style. */
  rules: Partial<PacingRules>;
  /** Dotted config keys, applied after the style and look; validated against the project at apply. */
  config: Record<string, unknown>;
  /** How the recipe treats the glass loupe when you add one by hand. */
  loupes: "prefer" | "allow" | "avoid";
  /** For screenstudio_music (or narrate's music): a library track, its volume, and how far it ducks under speech. */
  music: { track: string; volume: number; duckTo: number } | null;
  /** For screenstudio_narrate, when the video is voiced. */
  voice: { id: string; rate: number } | null;
  /**
   * For screenstudio_export_start, and for screenstudio_export_variants' targets in
   * the recipe's aspect. height is the short side of the frame, whatever the
   * aspect: 1080 means 1920x1080 at 16:9 and 1080x1920 at 9:16.
   */
  export: { height: number; fps: 24 | 30 | 60; format: "mp4" | "gif" };
  /** Where the video usually goes: screenstudio_export_variants targets, used when the call names none. */
  targets: TargetName[];
  /** A saved brand kit (screenstudio_brand) to apply on top, by name. Built-in recipes name none. */
  brand: string | null;
}

/** A diagonal gradient backdrop, top left to bottom right. */
const diagonal = (from: string, to: string) => ({
  start: { x: 0, y: 0 },
  end: { x: 1, y: 1 },
  stops: [
    { color: from, at: 0 },
    { color: to, at: 1 },
  ],
});

const captionsOff = { "captions.enableTranscript": false };
const lines = (sizeRatio: number, y: number, entrance: "appear" | "fade-in") => ({
  "captions.enableTranscript": true,
  "captions.wordsReveal": "line-by-line",
  "captions.wordEntrance": entrance,
  "captions.sizeRatio": sizeRatio,
  "captions.position01": { x: 0.5, y },
});

export const RECIPES: Record<RecipeName, Recipe> = {
  keynote: {
    name: "keynote",
    useFor:
      "A product moment shown on a big screen or a launch page: unhurried, dark and premium, a few shallow zooms and the loupe for detail.",
    style: "calm",
    look: "dark",
    aspect: "16:9",
    plan: { maxZooms: 3 },
    rules: { zoomLevels: [1.4, 1.25] },
    config: {
      "styles.background.type": "gradient",
      "styles.background.gradient": diagonal("#0b0b12", "#1a1b2e"),
      "output.paddingRatio01": 0.1,
      "styles.screenBorderRadius": 18,
      "styles.shadow.intensity": 0.6,
      "cursor.size": 48,
      "cursor.clickEffect": null,
      "audio.clickSoundEffect": null,
      "audio.clickSoundEffectVolume": 0.25,
      ...lines(0.045, 0.92, "fade-in"),
    },
    loupes: "prefer",
    music: { track: "instrumental/Noble Documentary", volume: 0.06, duckTo: 0.3 },
    voice: { id: "en-US-AndrewMultilingualNeural", rate: 0 },
    export: { height: 1080, fps: 60, format: "mp4" },
    targets: ["landing", "x"],
    brand: null,
  },
  "social-vertical": {
    name: "social-vertical",
    useFor:
      "A phone-first clip for a vertical feed: 9:16, under 30 seconds, big cursor, captions that fade in line by line above the app's own controls.",
    style: "snappy",
    look: "social",
    aspect: "9:16",
    plan: { targetMs: 30000, structure: "hook-demo-payoff" },
    rules: {},
    config: {
      "cursor.size": 64,
      "cursor.clickEffect": { type: "ripple" },
      "audio.clickSoundEffect": "apple-magic-mouse",
      "audio.clickSoundEffectVolume": 0.25,
      "captions.enableTranscript": true,
      "captions.wordsReveal": "line-by-line",
      "captions.wordEntrance": "fade-in",
      "captions.sizeRatio": 0.06,
      "captions.position01": { x: 0.5, y: 0.68 },
    },
    loupes: "avoid",
    music: { track: "electronic/Electro Pop", volume: 0.1, duckTo: 0.35 },
    voice: { id: "en-US-EmmaMultilingualNeural", rate: 5 },
    export: { height: 1080, fps: 60, format: "mp4" },
    targets: ["shorts", "portrait"],
    brand: null,
  },
  changelog: {
    name: "changelog",
    useFor:
      "One shipped feature in under 45 seconds for a release note or a post: quiet frame, no captions, one or two zooms on exactly what changed. For a looping GIF, cut one with screenstudio_loop.",
    style: "balanced",
    look: "minimal",
    aspect: "16:9",
    plan: { maxZooms: 2, targetMs: 45000 },
    rules: {},
    config: {
      "cursor.size": 48,
      "cursor.clickEffect": null,
      "audio.clickSoundEffect": null,
      "audio.clickSoundEffectVolume": 0.25,
      ...captionsOff,
    },
    loupes: "prefer",
    music: { track: "lo-fi/Cozy Chillhop", volume: 0.06, duckTo: 0.35 },
    voice: null,
    export: { height: 1080, fps: 60, format: "mp4" },
    targets: ["x", "linkedin"],
    brand: null,
  },
  "founder-talking-head": {
    name: "founder-talking-head",
    useFor:
      "Someone on camera talking through their product: cutout camera beside the screen, full screen for the opening line and sign-off, pauses and fillers trimmed, never sped up.",
    style: "balanced",
    look: "wallpaper",
    aspect: "16:9",
    plan: { tightenPausesMs: 350, removeFillers: true, speedUps: false, talkingHead: true },
    rules: {},
    config: {
      "defaultLayout.type": "cutout-camera",
      "defaultLayout.cutoutCamera.cutoutCameraSizeRatio01": 0.6,
      "defaultLayout.cutoutCamera.cutoutCameraZoomedScale": 0.5,
      "camera.enableFaceTracking": true,
      "camera.background.edgeFalloff01": 0.4,
      "cursor.size": 48,
      "cursor.clickEffect": { type: "ripple" },
      "audio.clickSoundEffect": null,
      "audio.clickSoundEffectVolume": 0.25,
      ...lines(0.045, 0.93, "appear"),
    },
    loupes: "allow",
    music: { track: "lo-fi/Bright Lounge", volume: 0.06, duckTo: 0.3 },
    voice: null,
    export: { height: 1080, fps: 30, format: "mp4" },
    targets: ["x", "linkedin"],
    brand: null,
  },
  tutorial: {
    name: "tutorial",
    useFor:
      "Teaching a task step by step: calm holds so each result can be read, shortcuts shown on screen, a chapter per marker, a friendly narrator.",
    style: "calm",
    look: "light",
    aspect: "16:9",
    plan: { removeFillers: true, tightenPausesMs: 400, markers: "chapters" },
    rules: {},
    config: {
      "cursor.size": 56,
      "cursor.clickEffect": { type: "ripple" },
      "audio.clickSoundEffect": null,
      "audio.clickSoundEffectVolume": 0.25,
      "captions.enableShortcuts": true,
      "captions.showShortcutsWithSingleLetters": false,
      ...lines(0.045, 0.93, "appear"),
    },
    loupes: "allow",
    music: null,
    voice: { id: "en-US-AvaMultilingualNeural", rate: 0 },
    export: { height: 1080, fps: 30, format: "mp4" },
    targets: ["docs"],
    brand: null,
  },
  "launch-teaser": {
    name: "launch-teaser",
    useFor:
      "A 20-second teaser before a launch: only the best beats, the payoff saved for last and offered as a cold open, a bright gradient, music with lift.",
    style: "snappy",
    look: "gradient",
    aspect: "16:9",
    plan: { targetMs: 20000, structure: "hook-demo-payoff" },
    rules: { finalHoldMs: 3000 },
    config: {
      "styles.background.gradient": diagonal("#ff6a3d", "#7b2ff7"),
      "cursor.size": 56,
      "cursor.clickEffect": { type: "ripple" },
      "audio.clickSoundEffect": "apple-magic-mouse",
      "audio.clickSoundEffectVolume": 0.3,
      ...captionsOff,
    },
    loupes: "avoid",
    music: { track: "commercial/Product Uplift", volume: 0.12, duckTo: 0.4 },
    voice: { id: "en-US-EmmaMultilingualNeural", rate: 0 },
    export: { height: 1080, fps: 60, format: "mp4" },
    targets: ["x", "shorts", "portrait"],
    brand: null,
  },
  "docs-walkthrough": {
    name: "docs-walkthrough",
    useFor:
      "A silent clip embedded in documentation: a plain light frame that sits on the page, typing slow enough to copy, every shortcut shown, no music or voice. For a looping GIF, cut one with screenstudio_loop.",
    style: "balanced",
    look: null,
    aspect: "16:9",
    plan: { maxZooms: 3 },
    rules: { typingSpeed: 1.5 },
    config: {
      "styles.background.type": "color",
      "styles.background.color": "#f4f5f7",
      "styles.screenBorderRadius": 10,
      "styles.shadow.intensity": 0.15,
      "output.paddingRatio01": 0.04,
      "output.avoidEmptyZoomArea": false,
      "animations.motionBlurAmount": 0.3,
      "cursor.size": 48,
      "cursor.clickEffect": null,
      "audio.clickSoundEffect": null,
      "audio.clickSoundEffectVolume": 0.25,
      "captions.enableShortcuts": true,
      "captions.showShortcutsWithSingleLetters": true,
      ...captionsOff,
    },
    loupes: "prefer",
    music: null,
    voice: null,
    export: { height: 1080, fps: 30, format: "mp4" },
    targets: ["docs"],
    brand: null,
  },
};

/** Each pacing rule's own shape and a sane range, so a wrong-shaped override is refused, not coerced. */
const ms = (max: number) => z.number().min(0).max(max);
const speed = z.number().min(1).max(4);
const ruleSchema = z
  .object({
    leadInMs: ms(10000),
    holdAfterMs: ms(10000),
    resultWindowMs: ms(15000),
    finalHoldMs: ms(15000),
    openingHoldMs: ms(10000),
    minCutGapMs: ms(10000),
    maxPauseMs: ms(10000),
    typingSpeed: speed,
    waitSpeed: speed,
    maxActionSpeed: speed,
    zoomLeadMs: ms(5000),
    zoomHoldMs: ms(10000),
    zoomMinMs: ms(15000),
    zoomGroupGapMs: ms(30000),
    zoomWideGapMs: ms(15000),
    zoomsPerMinute: z.number().min(0).max(30),
    openingWideMs: ms(15000),
    closingWideMs: ms(15000),
    zoomLevels: z.array(z.number().min(1).max(4)).min(1).max(6),
    cutsPer10s: z.number().min(0.2).max(6),
    maxCutsPer10s: z.number().min(0.2).max(8),
  } satisfies Record<keyof PacingRules, z.ZodType>)
  .partial()
  .strict();

/** What a caller may change in a recipe; anything else is an error, not silently ignored. */
export const recipeOverrides = z
  .object({
    style: z.enum(STYLE_NAMES),
    look: z.enum(Object.keys(LOOKS) as [string, ...string[]]).nullable(),
    aspect: z.enum(Object.keys(ASPECTS) as [string, ...string[]]),
    plan: z
      .object({
        zoom: z.enum(["auto", "none"]),
        maxZooms: z.number().int().min(0).max(30),
        speedUps: z.boolean(),
        tightenPausesMs: z.number().int().min(150).max(1500),
        removeFillers: z.boolean(),
        targetMs: z.number().int().min(3000).max(3600000),
        structure: z.enum(["linear", "hook-demo-payoff"]),
        talkingHead: z.boolean(),
        markers: z.enum(["ignore", "keep", "retake", "chapters"]),
      })
      .partial()
      .strict(),
    rules: ruleSchema,
    config: z.record(z.string().includes("."), z.unknown()),
    loupes: z.enum(["prefer", "allow", "avoid"]),
    music: z
      .object({
        track: z.string().max(80),
        volume: z.number().min(0).max(1),
        duckTo: z.number().min(0).max(1),
      })
      .partial()
      .strict()
      .nullable(),
    voice: z
      .object({ id: z.string().regex(/^[A-Za-z0-9-]+$/), rate: z.number().int().min(-50).max(50) })
      .partial()
      .strict()
      .nullable(),
    export: z
      .object({
        height: z.number().int().min(240).max(2160),
        fps: z.union([z.literal(24), z.literal(30), z.literal(60)]),
        format: z.enum(["mp4", "gif"]),
      })
      .partial()
      .strict(),
    targets: z.array(z.enum(TARGET_NAMES)).min(1).max(TARGET_NAMES.length),
    brand: z.string().min(1).max(40).nullable(),
  })
  .partial()
  .strict();

/** A recipe with the caller's overrides merged in: plan, rules, config and export field by field. */
export function resolveRecipe(name: string, overrides?: unknown): Recipe {
  const base = RECIPES[name as RecipeName];
  if (!base) throw new Error(`Unknown recipe ${name}. Recipes: ${RECIPE_NAMES.join(", ")}.`);
  const parsed = recipeOverrides.safeParse(overrides ?? {});
  if (!parsed.success)
    throw new Error(
      `recipeOverrides: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`,
    );
  const o = parsed.data;
  const recipe: Recipe = structuredClone(base);
  if (o.style) recipe.style = o.style;
  if (o.look !== undefined) recipe.look = o.look;
  if (o.aspect) recipe.aspect = o.aspect;
  if (o.loupes) recipe.loupes = o.loupes;
  recipe.plan = { ...recipe.plan, ...o.plan };
  recipe.rules = { ...recipe.rules, ...o.rules };
  recipe.config = { ...recipe.config, ...o.config };
  recipe.export = { ...recipe.export, ...o.export };
  if (o.targets) recipe.targets = [...new Set(o.targets)];
  if (o.brand !== undefined) recipe.brand = o.brand;
  if (o.music !== undefined)
    recipe.music = o.music && { track: "", volume: 0.08, duckTo: 0.35, ...recipe.music, ...o.music };
  if (o.voice !== undefined) recipe.voice = o.voice && { id: "", rate: 0, ...recipe.voice, ...o.voice };
  if (recipe.music && !recipe.music.track) throw new Error("recipeOverrides.music needs a track.");
  if (recipe.voice && !recipe.voice.id) throw new Error("recipeOverrides.voice needs an id.");
  return recipe;
}

/** One line per recipe, for listings. */
export const recipeList = () => RECIPE_NAMES.map((name) => ({ name, useFor: RECIPES[name].useFor }));

// ---------------------------------------------------------------- frame

/** Settings that make up the frame around the recording: backdrop, padding, corners, shadow, inset. */
export const isFrameKey = (key: string) =>
  key.startsWith("styles.background.") ||
  key.startsWith("styles.shadow.") ||
  key.startsWith("styles.screenInset.") ||
  key === "styles.screenBorderRadius" ||
  key === "output.paddingRatio01";

/** A config without its frame keys, for when another look (or the project's own frame) replaces the recipe's. */
export const withoutFrame = (config: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(config).filter(([k]) => !isFrameKey(k)));

/** What a plan applies, as the recipe notes describe it: the choices actually in force. */
export interface Applied {
  style?: Style;
  /** The look applied: a LOOKS name, "keep" for the project's own frame, or null for the recipe's frame. */
  look?: string | null;
  aspect?: string;
  /** The final merged config the plan applies. */
  config?: Record<string, unknown>;
  /** Who replaced the recipe's frame or sound settings, for the notes ("you", "brand acme"). */
  replacedBy?: { style?: string; look?: string; aspect?: string; config?: string };
}

/**
 * The plan's config, merged in one order so every choice lands where it should:
 * the style's settings, the camera director's, the look (the recipe's, or one
 * named instead), the recipe's own settings (without its frame when another look
 * or the project's frame replaces it), an explicit look, the brand's own fields,
 * then the aspect. Returns the merged changes and notes on what replaced what.
 */
export function composeConfig(o: {
  styleConfig?: Record<string, unknown>;
  camera?: Record<string, unknown>;
  recipe?: Recipe;
  /** The recipe's look before overrides, to tell when recipeOverrides.look replaced it. */
  baseLook?: string | null;
  /** An explicit look argument: a LOOKS name or "keep". */
  look?: string;
  brand?: Record<string, unknown>;
  brandName?: string;
  aspect?: number | "auto";
}) {
  const { recipe } = o;
  const notes: string[] = [];
  const lookFromRecipe = recipe && o.look === undefined ? recipe.look : null;
  // The recipe's frame stands unless a different look (or keep) was asked for.
  const frameReplaced =
    !!recipe && (o.look !== undefined || (o.baseLook !== undefined && recipe.look !== o.baseLook));
  const recipeConfig = recipe ? (frameReplaced ? withoutFrame(recipe.config) : recipe.config) : {};
  if (recipe && frameReplaced && Object.keys(recipe.config).some(isFrameKey))
    notes.push(
      o.look === "keep"
        ? `Kept the project's own frame instead of ${recipe.name}'s backdrop, padding, corners and shadow.`
        : `The ${o.look ?? recipe.look} look sets the frame instead of ${recipe.name}'s own backdrop, padding, corners and shadow.`,
    );
  const camera = { ...o.camera };
  // The recipe's or brand's caption position wins over the camera director's lift.
  const placed = (k: string) => Object.hasOwn(recipeConfig, k) || Object.hasOwn(o.brand ?? {}, k);
  for (const k of Object.keys(camera))
    if (placed(k)) {
      delete camera[k];
      if (k === "captions.position01")
        notes.push(
          `Captions stay where ${o.brand && Object.hasOwn(o.brand, k) ? `brand ${o.brandName ?? ""}`.trim() : `the ${recipe!.name} recipe`} puts them; the camera director did not move them.`,
        );
    }
  const changes: Record<string, unknown> = {
    ...o.styleConfig,
    ...camera,
    ...(lookFromRecipe ? LOOKS[lookFromRecipe] : {}),
    ...recipeConfig,
    ...(o.look && o.look !== "keep" ? LOOKS[o.look] : {}),
    ...o.brand,
    ...(o.aspect !== undefined ? { "output.aspectRatio": o.aspect } : {}),
  };
  return { changes, notes };
}

/** What a recipe set, in plain words, for the plan's notes; with `applied`, what the plan really applies. */
export function recipeNotes(r: Recipe, applied: Applied = {}): string[] {
  const config = { ...r.config, ...applied.config };
  const by = applied.replacedBy ?? {};
  const style = applied.style ?? r.style;
  const look = applied.look === undefined ? r.look : applied.look;
  const aspect = applied.aspect ?? r.aspect;
  const instead = (what: string, mine: string, theirs: string, who?: string) =>
    mine === theirs ? what : `${what} (${who ?? "you"} chose it over the recipe's ${theirs})`;
  const lookWords = look === "keep" ? "the project's own frame" : `${look ?? "its own"} frame`;
  const captions = config["captions.enableTranscript"]
    ? `captions ${String(config["captions.wordsReveal"] ?? "on").replace(/-/g, " ")}`
    : "no captions";
  const soundBy = by.config ? ` (from ${by.config})` : "";
  const recipeClick = r.config["audio.clickSoundEffect"] ? "click sounds" : "silent clicks";
  const click = config["audio.clickSoundEffect"] ? "click sounds" : "silent clicks";
  const recipeEffect = r.config["cursor.clickEffect"] ? "a click ripple" : "no click effect";
  const effect = config["cursor.clickEffect"] ? "a click ripple" : "no click effect";
  return [
    `Recipe ${r.name}: ${instead(`${style} pacing`, style, r.style, by.style)}, ${instead(lookWords, String(look), String(r.look ?? "its own"), by.look)}, ${instead(aspect, aspect, r.aspect, by.aspect)}, ${captions}, ${effect}${effect !== recipeEffect ? soundBy : ""}, ${click}${click !== recipeClick ? soundBy : ""}. ${r.useFor}`,
    r.music
      ? `Music: ${r.music.track} at ${r.music.volume}, ducking to ${r.music.duckTo} under speech (pass to screenstudio_music, or as music to screenstudio_narrate when voicing).`
      : "Music: none; this recipe lets the product's own sound carry it.",
    r.voice
      ? `Voice, if you narrate: ${r.voice.id} at rate ${r.voice.rate}.`
      : "Voice: none; the recording's own voice, or none at all.",
    `Export ${r.export.height}p ${r.export.fps}fps ${r.export.format}, ${r.export.height} being the short side of the ${aspect} frame (screenstudio_export_start), or every place it goes with screenstudio_export_variants: ${r.targets.join(", ")}.`,
    ...(r.brand ? [`Brand: ${r.brand}, applied over the recipe's colours, captions, cursor and sound.`] : []),
    r.loupes === "prefer"
      ? "Loupes: prefer the glass loupe for tables, lists and small values; it keeps the viewer oriented."
      : r.loupes === "avoid"
        ? "Loupes: avoid; on a phone the loupe's detail is too small to read, a camera zoom works better."
        : "Loupes: use one where a detail needs its context.",
  ];
}

/**
 * A recipe with a brand kit's voice and music in place of its own, so narration
 * sounds like the brand. The recipe keeps its music volume, ducking and voice
 * rate. A recipe that leaves voice or music out on purpose keeps them out: the
 * brand's are only mentioned in a note.
 */
export function withBrand(r: Recipe, brand: Pick<Brand, "name" | "voice" | "music">) {
  const recipe: Recipe = structuredClone(r);
  const notes: string[] = [];
  if (brand.voice && brand.voice !== recipe.voice?.id) {
    if (recipe.voice) {
      notes.push(
        `Voice: ${brand.name}'s ${brand.voice} instead of the recipe's ${recipe.voice.id}, at the recipe's rate.`,
      );
      recipe.voice = { id: brand.voice, rate: recipe.voice.rate };
    } else
      notes.push(
        `Voice: ${recipe.name} has no narrator on purpose; ${brand.name}'s voice ${brand.voice} is available if you decide to narrate.`,
      );
  }
  if (brand.music === null && recipe.music) {
    notes.push(`Music: none, because ${brand.name} uses no music.`);
    recipe.music = null;
  } else if (brand.music && brand.music !== recipe.music?.track) {
    if (recipe.music) {
      notes.push(`Music: ${brand.name}'s ${brand.music}, at the recipe's volume and ducking.`);
      recipe.music = { ...recipe.music, track: brand.music };
    } else
      notes.push(
        `Music: ${recipe.name} has no music on purpose; ${brand.name}'s ${brand.music} is available if you decide to add music.`,
      );
  }
  recipe.brand = brand.name;
  return { recipe, notes };
}
