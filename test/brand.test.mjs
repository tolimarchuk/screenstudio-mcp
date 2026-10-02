// Brand kits: compiling to validated config, caption contrast, cursor checks and storage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brandSlug,
  compileBrand,
  contrastRatio,
  darken,
  deleteBrand,
  listBrands,
  readBrand,
  readableCaptionBox,
  captionContrast,
  saveBrand,
} from "../dist/studio/brand.js";
import { validateConfigChange } from "../dist/studio/project.js";
import { configPartial } from "../dist/studio/editor/ops.js";

// A project config shaped like Screen Studio 4's, with the groups a brand touches.
const config = () => ({
  cursor: {
    size: 48,
    set: { id: "macos-tahoe", variants: {} },
    clickEffect: null,
    hideNotMovingAfterMs: 1500,
  },
  captions: {
    enableTranscript: true,
    font: "sans-serif",
    sizeRatio: 0.05,
    color: "#ffffff",
    backgroundColor: "#000000",
    position01: { x: 0.5, y: 1 },
  },
  audio: { clickSoundEffect: null, clickSoundEffectVolume: 0.25 },
  animations: { motionBlurAmount: 0.5 },
  output: { aspectRatio: "auto", paddingRatio01: 0.1, avoidEmptyZoomArea: true },
  styles: {
    screenBorderRadius: 16,
    screenInset: { size: 0, origin01: { x: 0, y: 0 }, alpha: 0.5, color: "#000000" },
    shadow: { intensity: 0.3, distance: 25, angle: 45, blur: 20, isDirectional: true },
    background: {
      type: "system",
      color: "#4776e6",
      gradient: {
        start: { x: 0, y: 0 },
        end: { x: 1, y: 1 },
        stops: [
          { color: "#4776e6", at: 0 },
          { color: "#8e54e9", at: 1 },
        ],
      },
      systemName: "macOS/san-francisco-dark.jpg",
      image: null,
      unsplash: null,
      blur: 0,
    },
  },
});

const northwind = {
  name: "Northwind",
  colors: { primary: "#1d4ed8", secondary: "#0f172a", text: "#ffffff" },
  captions: { font: "serif" },
  cursor: { set: "macos-tahoe", size: 56 },
  clickSound: "apple-magic-mouse",
  radius: 18,
  shadow: 0.5,
  padding: 0.07,
  voice: "en-US-BrianMultilingualNeural",
  music: "instrumental/corporate smile",
};

test("a compiled brand is one valid config op on a real project config", () => {
  const { changes, notes } = compileBrand(northwind, { cursorSets: ["macos-tahoe", "minimal"] });
  for (const [key, value] of Object.entries(changes)) validateConfigChange(config(), key, value);
  configPartial(config(), changes);
  assert.equal(changes["styles.background.type"], "gradient");
  assert.deepEqual(
    changes["styles.background.gradient"].stops.map((s) => s.color),
    ["#1d4ed8", "#0f172a"],
  );
  assert.deepEqual(changes["cursor.set"], { id: "macos-tahoe", variants: {} });
  assert.equal(changes["captions.font"], "serif");
  assert.equal(changes["captions.backgroundColor"], "#1d4ed8e6");
  assert.equal(changes["audio.clickSoundEffect"], "apple-magic-mouse");
  assert.equal(changes["output.paddingRatio01"], 0.07);
  assert.ok(notes.some((n) => /Captions sit on a #1d4ed8 box/.test(n)));
  assert.ok(!("styles.screenInset.color" in changes));
});

test("a brand starting from a look keeps the look's motion and replaces its colours", () => {
  const { changes, notes } = compileBrand({
    name: "x",
    from: "dark",
    backdrop: "gradient",
    colors: { primary: "#7c3aed" },
  });
  assert.equal(changes["animations.motionBlurAmount"], 0.5);
  assert.equal(changes["styles.background.type"], "gradient");
  assert.equal(changes["styles.background.gradient"].stops[1].color, darken("#7c3aed", 0.35));
  assert.ok(notes.some((n) => /Started from the dark look/.test(n)));
  assert.ok(notes.some((n) => /No secondary colour/.test(n)));
  const kept = compileBrand({ name: "x", from: "dark", backdrop: "look", colors: { primary: "#7c3aed" } });
  assert.equal(kept.changes["styles.background.type"], "system");
  // A starting look keeps its own backdrop unless the brand asks for another.
  const fromOnly = compileBrand({ name: "x", from: "wallpaper", colors: { primary: "#7c3aed" } });
  assert.equal(fromOnly.changes["styles.background.type"], "system");
  assert.throws(
    () => compileBrand({ name: "x", backdrop: "look", colors: { primary: "#7c3aed" } }),
    /set from/,
  );
  const flat = compileBrand({ name: "x", backdrop: "color", colors: { primary: "#7c3aed" } }).changes;
  assert.equal(flat["styles.background.color"], "#7c3aed");
});

test("white captions on a light brand box flip to a dark box, with the reason", () => {
  const { changes, notes } = compileBrand({
    name: "Paper",
    colors: { primary: "#f5f5f4" },
    captions: { color: "#ffffff" },
  });
  assert.equal(changes["captions.backgroundColor"], "#000000b3");
  assert.ok(notes.some((n) => /Changed the caption box to #000000b3 .*under the 4.5:1/.test(n)));
  assert.ok(contrastRatio("#ffffff", "#000000b3") >= 4.5);
  // Dark text picks the light box; a see-through box is replaced even when its colour contrasts.
  assert.equal(readableCaptionBox("#111111", "#222222").backgroundColor, "#ffffffd9");
  assert.match(readableCaptionBox("#ffffff", "#00000033").note, /transparent/);
  assert.equal(readableCaptionBox("#ffffff", "#000000cc").note, null);
  // Without a text colour the brand picks the one that reads on its primary.
  assert.equal(
    compileBrand({ name: "y", colors: { primary: "#fde047" } }).changes["captions.color"],
    "#111111",
  );
});

test("contrast follows WCAG", () => {
  assert.equal(Math.round(contrastRatio("#ffffff", "#000000")), 21);
  assert.equal(contrastRatio("#777777", "#777777"), 1);
  assert.equal(darken("#ff8040", 0.5), "#804020");
});

test("an unknown cursor set is refused against the app catalog, and inset colour follows the project", () => {
  assert.throws(
    () =>
      compileBrand(
        { name: "x", colors: { primary: "#000000" }, cursor: { set: "comic" } },
        { cursorSets: ["macos-tahoe"] },
      ),
    /Unknown cursor set comic\. Choose one of: macos-tahoe/,
  );
  const unchecked = compileBrand({ name: "x", colors: { primary: "#000000" }, cursor: { set: "comic" } });
  assert.ok(unchecked.notes.some((n) => /was not checked/.test(n)));
  const c = config();
  c.styles.screenInset.size = 4;
  assert.equal(compileBrand(northwind, { config: c }).changes["styles.screenInset.color"], "#1d4ed8");
});

test("brand names are slugs; path characters are refused, not rewritten", () => {
  assert.equal(brandSlug("  Acme Blue "), "acme-blue");
  for (const bad of ["../etc/passwd", "a/b", "a\\b", ".hidden", "", "x".repeat(41), "naïve"])
    assert.throws(() => brandSlug(bad), /letters, digits/, bad);
});

test("brands save privately, list, show and delete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ssmcp-brand-"));
  try {
    const saved = await saveBrand(dir, northwind);
    assert.equal(saved.slug, "northwind");
    assert.equal(saved.brand.music, "instrumental/Corporate Smile");
    assert.equal((await stat(join(dir, "brands", "northwind.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "brands"))).mode & 0o777, 0o700);
    await writeFile(join(dir, "brands", "broken.json"), "{");
    // A brand that no longer reads is listed with its error, and can still be deleted.
    const listed = await listBrands(dir);
    assert.deepEqual(listed[1], { slug: "northwind", name: "Northwind", primary: "#1d4ed8" });
    assert.equal(listed[0].slug, "broken");
    assert.match(listed[0].error, /could not be read/);
    assert.deepEqual(await deleteBrand(dir, "broken"), { deleted: "broken" });
    await assert.rejects(deleteBrand(dir, "broken"), /No brand named broken/);
    assert.equal((await saveBrand(dir, northwind)).replaced, true);
    assert.equal((await readBrand(dir, "Northwind")).colors.secondary, "#0f172a");
    await assert.rejects(saveBrand(dir, { ...northwind, music: "polka/Nope" }), /Unknown music track/);
    await assert.rejects(saveBrand(dir, { ...northwind, name: "../x" }), /letters, digits/);
    await assert.rejects(readBrand(dir, "missing"), /No brand named missing/);
    assert.deepEqual(await deleteBrand(dir, "northwind"), { deleted: "northwind" });
    assert.deepEqual(await listBrands(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("caption contrast counts see-through text and boxes over any footage", () => {
  // 12% opaque white text is not readable, whatever the box.
  assert.ok(captionContrast("#ffffff20", "#000000") < 4.5);
  assert.notEqual(readableCaptionBox("#ffffff20", "#000000").color, "#ffffff20");
  // A 60% grey box over white footage is far lighter than its colour suggests.
  assert.ok(captionContrast("#ffffff", "#33333399") < 4.5);
  assert.notEqual(readableCaptionBox("#ffffff", "#33333399").backgroundColor, "#33333399");
  // Mid-grey text reads on neither fallback box over every frame, so the text changes too.
  const grey = readableCaptionBox("#777777", "#777777");
  assert.ok(captionContrast(grey.color, grey.backgroundColor) >= 4.5, JSON.stringify(grey));
  assert.match(grey.note, /and the text to/);
  // The note never rounds a failing ratio up to 4.5:1.
  assert.ok(!/is 4\.5:1, under/.test(readableCaptionBox("#ffffff", "#767676").note ?? ""));
});

test("the automatic text colour is chosen against the caption box, not the primary", () => {
  const { changes, notes } = compileBrand({
    name: "x",
    colors: { primary: "#1d4ed8" },
    captions: { backgroundColor: "#ffffff" },
  });
  assert.equal(changes["captions.backgroundColor"], "#ffffff");
  assert.equal(changes["captions.color"], "#111111");
  assert.ok(!notes.some((n) => /Changed the caption box/.test(n)));
});
