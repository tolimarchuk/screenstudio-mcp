// Brand kits: a client's colours, caption look, cursor and sound saved once and
// compiled to the same dotted config a look or style uses, so applying one is a
// single config op in the editor (live, undoable). Brands live in the private
// state directory, one JSON file per brand.
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { configFields } from "./project.js";
import { LOOKS } from "./styles.js";
import { MUSIC, resolveMusic } from "./narration.js";
import { unit } from "./schemas.js";
import { privateDir } from "./util.js";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a 6-digit hex colour like #1d4ed8.");
const hexAlpha = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, "Use a hex colour like #111827 or #111827cc.");
const lookNames = Object.keys(LOOKS) as [string, ...string[]];

export const brandInput = z
  .object({
    name: z.string().min(1).max(40),
    from: z.enum(lookNames).optional().describe("A look to start from; the brand's own fields win."),
    colors: z.object({ primary: hex, secondary: hex.optional(), text: hex.optional() }).strict(),
    backdrop: z
      .enum(["gradient", "color", "look"])
      .optional()
      .describe(
        "gradient: primary to secondary; color: flat primary; look: keep the from look's backdrop. Default look when from is set, else gradient. Image backdrops are not supported yet.",
      ),
    captions: z
      .object({
        color: hexAlpha.optional(),
        backgroundColor: hexAlpha.optional(),
        font: z.enum(["serif", "sans-serif", "mono"]).optional(),
      })
      .strict()
      .optional(),
    cursor: z
      .object({ set: z.string().min(1).max(60).optional(), size: z.number().min(8).max(256).optional() })
      .strict()
      .optional(),
    clickSound: z.enum(["apple-magic-mouse", "logitech-mx-master"]).nullable().optional(),
    music: z.string().max(80).nullable().optional(),
    voice: z
      .string()
      .regex(/^[A-Za-z0-9-]+$/)
      .optional(),
    radius: z.number().min(0).max(200).optional(),
    shadow: unit.optional(),
    padding: z.number().min(0).max(0.4).optional(),
  })
  .strict()
  .refine((b) => b.backdrop !== "look" || b.from, {
    message: "backdrop 'look' keeps the backdrop of the from look; set from too.",
  });
export type Brand = z.infer<typeof brandInput>;

/** File name for a brand: lower case letters, digits and hyphens. Anything else is refused, never rewritten. */
export function brandSlug(name: string) {
  const slug = name.trim().toLowerCase().replace(/\s+/g, "-");
  if (!/^[a-z0-9-]{1,40}$/.test(slug))
    throw new Error("Brand names use letters, digits, spaces and hyphens only (up to 40).");
  return slug;
}

const rgb = (color: string) => {
  const m = /^#?([0-9a-f]{6})/i.exec(color.trim());
  if (!m) throw new Error(`Not a hex colour: ${color}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
};
const toHex = (channels: number[]) =>
  `#${channels
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

/** Mixes a colour toward black by `amount` (0-1). */
export function darken(color: string, amount: number) {
  return toHex(rgb(color).map((c) => c * (1 - amount)));
}

/** Opacity of a #rrggbbaa colour, 1 for #rrggbb. */
export const alpha = (color: string) => {
  const m = /^#?[0-9a-f]{6}([0-9a-f]{2})$/i.exec(color.trim());
  return m ? parseInt(m[1], 16) / 255 : 1;
};

/** A colour with its alpha laid over an opaque backdrop, as the viewer sees it. */
export function over(color: string, backdrop: string) {
  const a = alpha(color);
  const top = rgb(color);
  return toHex(rgb(backdrop).map((c, i) => top[i] * a + c * (1 - a)));
}

/** WCAG relative luminance of the colour's 6-digit part. */
export function luminance(color: string) {
  const [r, g, b] = rgb(color).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrastRatio(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Caption boxes used when the brand's own would be hard to read. */
export const READABLE_BOXES = ["#000000b3", "#ffffffd9"] as const;
const READABLE_TEXT = ["#ffffff", "#111111"] as const;
const MIN_CONTRAST = 4.5;
/** The footage a caption can sit on, at its extremes. */
const FRAMES = ["#000000", "#ffffff"] as const;

/** Rounded down, so a ratio under 4.5:1 never prints as 4.5:1. */
const ratio = (n: number) => `${Math.floor(n * 10) / 10}:1`;

/**
 * Caption contrast as the viewer sees it at worst: the box composited over black
 * and over white footage, the text composited over that box, and the lower ratio.
 */
export function captionContrast(text: string, box: string) {
  return Math.min(
    ...FRAMES.map((frame) => {
      const behind = over(box, frame);
      return contrastRatio(over(text, behind), behind);
    }),
  );
}

/**
 * Keeps the caption box when text on it reaches 4.5:1 (WCAG AA) over any
 * footage; otherwise picks the dark or light box that reads better, and when
 * neither does (see-through or mid-grey text), the text colour too. Says why.
 */
export function readableCaptionBox(text: string, background: string) {
  const contrast = captionContrast(text, background);
  if (contrast >= MIN_CONTRAST) return { backgroundColor: background, color: text, contrast, note: null };
  let color = text;
  let pick: string = [...READABLE_BOXES].sort(
    (a, b) => captionContrast(text, b) - captionContrast(text, a),
  )[0];
  if (captionContrast(text, pick) < MIN_CONTRAST) {
    const pairs = READABLE_TEXT.flatMap((t) =>
      READABLE_BOXES.map((b) => ({ t, b, c: captionContrast(t, b) })),
    );
    const top = pairs.sort((x, y) => y.c - x.c)[0];
    [color, pick] = [top.t, top.b];
  }
  // Readable on the box's own colour, so the box's transparency is what fails.
  const seeThrough = contrastRatio(text, background) >= MIN_CONTRAST && alpha(text) >= 0.9;
  const why = seeThrough
    ? `the caption box ${background} is so transparent that over some footage the text drops to ${ratio(contrast)}`
    : `caption text ${text} on ${background} is ${ratio(contrast)} at worst over the footage, under the 4.5:1 captions need`;
  const after = captionContrast(color, pick);
  return {
    backgroundColor: pick,
    color,
    contrast: after,
    note: `Changed the caption box to ${pick}${color !== text ? ` and the text to ${color}` : ""} (${ratio(after)} at worst): ${why}.`,
  };
}

/**
 * The project settings a brand sets, as dotted config keys for one config op,
 * with the reasons for each derived choice. `cursorSets` (from the app's
 * catalog) checks the cursor set; `config` (the project's) recolours a screen
 * inset only when the project uses one.
 */
export function compileBrand(
  input: Brand,
  options: { cursorSets?: string[]; config?: any; ownOnly?: boolean } = {},
) {
  const brand = brandInput.parse(input);
  const { primary } = brand.colors;
  const backdrop = brand.backdrop ?? (brand.from ? "look" : "gradient");
  const notes: string[] = [];
  const changes: Record<string, unknown> = {};
  if (brand.from && options.ownOnly) {
    // A recipe or a look chosen for this plan sets the cursor, sound, motion and
    // frame; the brand keeps only its own fields (and its from look's backdrop).
    if (backdrop === "look")
      for (const [k, v] of Object.entries(LOOKS[brand.from]))
        if (k.startsWith("styles.background.")) changes[k] = v;
    notes.push(
      `Only the brand's own settings apply over the recipe or look you chose${backdrop === "look" ? `, with the ${brand.from} look's backdrop` : ""}; the rest of the ${brand.from} look is left out.`,
    );
  } else if (brand.from) {
    Object.assign(changes, LOOKS[brand.from]);
    notes.push(`Started from the ${brand.from} look; the brand's own settings replace its colours.`);
  }
  if (backdrop === "gradient") {
    const secondary = brand.colors.secondary ?? darken(primary, 0.35);
    if (!brand.colors.secondary)
      notes.push(`No secondary colour, so the backdrop fades from ${primary} to a darker ${secondary}.`);
    changes["styles.background.type"] = "gradient";
    changes["styles.background.gradient"] = {
      start: { x: 0, y: 0 },
      end: { x: 1, y: 1 },
      stops: [
        { color: primary, at: 0 },
        { color: secondary, at: 1 },
      ],
    };
  } else if (backdrop === "color") {
    changes["styles.background.type"] = "color";
    changes["styles.background.color"] = primary;
  }

  // The text is chosen against the box it will sit on, not the primary colour.
  const box = brand.captions?.backgroundColor ?? `${primary}e6`;
  const text =
    brand.captions?.color ??
    brand.colors.text ??
    (captionContrast("#ffffff", box) >= captionContrast("#111111", box) ? "#ffffff" : "#111111");
  const readable = readableCaptionBox(text, box);
  if (readable.note) notes.push(readable.note);
  else if (!brand.captions?.backgroundColor)
    notes.push(
      `Captions sit on a ${primary} box (${ratio(readable.contrast)} contrast with ${text} at worst).`,
    );
  changes["captions.color"] = readable.color;
  changes["captions.backgroundColor"] = readable.backgroundColor;
  if (brand.captions?.font) changes["captions.font"] = brand.captions.font;

  if (brand.cursor?.set) {
    if (options.cursorSets && !options.cursorSets.includes(brand.cursor.set))
      throw new Error(
        `Unknown cursor set ${brand.cursor.set}. Choose one of: ${options.cursorSets.join(", ")}`,
      );
    if (!options.cursorSets)
      notes.push(`Could not read the app's cursor sets, so ${brand.cursor.set} was not checked.`);
    changes["cursor.set"] = { id: brand.cursor.set, variants: {} };
  }
  if (brand.cursor?.size !== undefined) changes["cursor.size"] = brand.cursor.size;
  if (brand.clickSound !== undefined) changes["audio.clickSoundEffect"] = brand.clickSound;
  if (brand.radius !== undefined) changes["styles.screenBorderRadius"] = brand.radius;
  if (brand.shadow !== undefined) changes["styles.shadow.intensity"] = brand.shadow;
  if (brand.padding !== undefined) changes["output.paddingRatio01"] = brand.padding;
  if ((options.config?.styles?.screenInset?.size ?? 0) > 0) {
    changes["styles.screenInset.color"] = primary;
    notes.push(`The project has a screen inset, so it takes the primary colour ${primary}.`);
  }
  for (const [key, value] of Object.entries(changes))
    if (Object.hasOwn(configFields, key)) changes[key] = configFields[key].parse(value);
  return { changes, notes };
}

const dir = (stateDir: string) => privateDir(join(stateDir, "brands"));

/** Writes through a temp file and a rename, so a brand file is never left half written. */
async function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, data, { mode: 0o600, flag: "wx" });
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** Checks a brand and stores it; saving under an existing name replaces that brand and says so. */
export async function saveBrand(stateDir: string, input: unknown) {
  const brand = brandInput.parse(input);
  if (brand.music) brand.music = resolveMusic(MUSIC, brand.music);
  const slug = brandSlug(brand.name);
  const file = join(await dir(stateDir), `${slug}.json`);
  const replaced = await readFile(file).then(
    () => true,
    () => false,
  );
  await writeAtomic(file, JSON.stringify(brand, null, 2));
  return { slug, brand, replaced };
}

export async function readBrand(stateDir: string, name: string): Promise<Brand> {
  const slug = brandSlug(name);
  try {
    return brandInput.parse(JSON.parse(await readFile(join(stateDir, "brands", `${slug}.json`), "utf8")));
  } catch (error: any) {
    if (error?.code === "ENOENT")
      throw new Error(`No brand named ${slug}. List brands to see the saved ones.`);
    throw new Error(
      `Brand ${slug} could not be read (save it again, or delete it): ${error instanceof Error ? error.message : error}`,
    );
  }
}

/** Every saved brand; one that no longer reads is listed with its error, so it can be saved again or deleted. */
export async function listBrands(stateDir: string) {
  const files = (await readdir(join(stateDir, "brands")).catch(() => [] as string[])).filter((f) =>
    /^[a-z0-9-]{1,40}\.json$/.test(f),
  );
  const out: { slug: string; name?: string; primary?: string; error?: string }[] = [];
  for (const f of files.sort()) {
    const slug = f.slice(0, -5);
    try {
      const brand = await readBrand(stateDir, slug);
      out.push({ slug, name: brand.name, primary: brand.colors.primary });
    } catch (e) {
      out.push({ slug, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** Deletes a brand file, even one that no longer reads. */
export async function deleteBrand(stateDir: string, name: string) {
  const slug = brandSlug(name);
  try {
    await rm(join(stateDir, "brands", `${slug}.json`));
  } catch (error: any) {
    if (error?.code === "ENOENT")
      throw new Error(`No brand named ${slug}. List brands to see the saved ones.`);
    throw error;
  }
  return { deleted: slug };
}
