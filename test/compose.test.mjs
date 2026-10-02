// How a plan's config is put together from a style, the camera director, a
// recipe, a look, a brand and an aspect, and how the notes describe it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RECIPES, composeConfig, recipeNotes, resolveRecipe } from "../dist/studio/recipes.js";
import { compileBrand } from "../dist/studio/brand.js";
import { LOOKS } from "../dist/studio/styles.js";

test("a look named over a recipe sets the frame, and keep leaves the project's", () => {
  const keynote = RECIPES.keynote;
  const light = composeConfig({
    recipe: resolveRecipe("keynote", { look: "light" }),
    baseLook: keynote.look,
  });
  assert.equal(light.changes["styles.background.type"], LOOKS.light["styles.background.type"]);
  assert.equal(light.changes["output.paddingRatio01"], LOOKS.light["output.paddingRatio01"]);
  // The recipe's non-frame choices still stand.
  assert.equal(light.changes["cursor.clickEffect"], null);
  const explicit = composeConfig({ recipe: keynote, baseLook: keynote.look, look: "light" });
  assert.equal(explicit.changes["styles.background.type"], "system");
  const kept = composeConfig({ recipe: keynote, baseLook: keynote.look, look: "keep" });
  assert.ok(!Object.keys(kept.changes).some((k) => k.startsWith("styles.background.")));
  assert.equal(kept.changes["output.paddingRatio01"], undefined);
  assert.match(kept.notes[0], /Kept the project's own frame/);
  const docs = composeConfig({
    recipe: resolveRecipe("docs-walkthrough", { look: "dark" }),
    baseLook: RECIPES["docs-walkthrough"].look,
  });
  assert.equal(docs.changes["styles.background.systemName"], LOOKS.dark["styles.background.systemName"]);
  assert.equal(docs.changes["styles.background.color"], undefined);
  // Without any look change, the recipe's own frame is applied.
  const plain = composeConfig({ recipe: keynote, baseLook: keynote.look });
  assert.equal(plain.changes["styles.background.type"], "gradient");
});

test("a brand's starting look never overrides a recipe's cursor, clicks or frame", () => {
  const brand = { name: "acme", from: "gradient", backdrop: "gradient", colors: { primary: "#1d4ed8" } };
  const own = compileBrand(brand, { ownOnly: true });
  for (const k of [
    "cursor.clickEffect",
    "audio.clickSoundEffect",
    "cursor.size",
    "animations.motionBlurAmount",
  ])
    assert.ok(!(k in own.changes), k);
  const keynote = composeConfig({
    recipe: RECIPES.keynote,
    baseLook: "dark",
    brand: own.changes,
    brandName: "acme",
  });
  assert.equal(keynote.changes["cursor.clickEffect"], null);
  assert.equal(keynote.changes["audio.clickSoundEffect"], null);
  assert.equal(keynote.changes["output.paddingRatio01"], 0.1);
  const social = composeConfig({
    recipe: RECIPES["social-vertical"],
    baseLook: "social",
    brand: own.changes,
  });
  assert.equal(social.changes["cursor.size"], 64);
  // The brand's colours do land.
  assert.equal(keynote.changes["styles.background.gradient"].stops[0].color, "#1d4ed8");
  // On its own, a brand still starts from its look.
  assert.equal(compileBrand(brand).changes["cursor.clickEffect"].type, "ripple");
});

test("the camera director never moves captions a recipe or brand placed", () => {
  const camera = { "captions.position01": { x: 0.5, y: 0.93 }, "defaultLayout.type": "cutout-camera" };
  const tiktok = resolveRecipe("social-vertical", { plan: { talkingHead: true } });
  const out = composeConfig({ recipe: tiktok, baseLook: "social", camera });
  assert.deepEqual(out.changes["captions.position01"], { x: 0.5, y: 0.68 });
  assert.equal(out.changes["defaultLayout.type"], "cutout-camera");
  assert.ok(out.notes.some((n) => /Captions stay where the social-vertical recipe puts them/.test(n)));
  assert.deepEqual(composeConfig({ camera }).changes["captions.position01"], { x: 0.5, y: 0.93 });
});

test("rule overrides are checked per rule", () => {
  assert.throws(
    () => resolveRecipe("keynote", { rules: { zoomLevels: 1.5 } }),
    /recipeOverrides: rules\.zoomLevels/,
  );
  assert.throws(
    () => resolveRecipe("keynote", { rules: { leadInMs: [2] } }),
    /recipeOverrides: rules\.leadInMs/,
  );
  assert.throws(
    () => resolveRecipe("keynote", { rules: { zoomLevels: [] } }),
    /recipeOverrides: rules\.zoomLevels/,
  );
  assert.throws(
    () => resolveRecipe("keynote", { rules: { leadInMs: 1e9 } }),
    /recipeOverrides: rules\.leadInMs/,
  );
  assert.throws(
    () => resolveRecipe("keynote", { rules: { typingSpeed: 0.5 } }),
    /recipeOverrides: rules\.typingSpeed/,
  );
  assert.deepEqual(resolveRecipe("keynote", { rules: { zoomLevels: [1.3] } }).rules.zoomLevels, [1.3]);
});

test("notes describe what the plan applies, and who replaced the recipe's choice", () => {
  const notes = recipeNotes(RECIPES.keynote, {
    style: "snappy",
    look: "light",
    aspect: "9:16",
    config: { ...RECIPES.keynote.config, "audio.clickSoundEffect": "apple-magic-mouse" },
    replacedBy: { style: "you", look: "you", aspect: "you", config: "brand acme" },
  });
  assert.match(notes[0], /snappy pacing \(you chose it over the recipe's calm\)/);
  assert.match(notes[0], /light frame \(you chose it over the recipe's dark\)/);
  assert.match(notes[0], /9:16 \(you chose it over the recipe's 16:9\)/);
  assert.match(notes[0], /click sounds \(from brand acme\)/);
  assert.ok(notes.some((n) => /1080p 60fps mp4, 1080 being the short side of the 9:16 frame/.test(n)));
  assert.match(recipeNotes(RECIPES.keynote, { look: "keep" })[0], /the project's own frame/);
});

test("every recipe's export height is the short side", () => {
  for (const r of Object.values(RECIPES)) assert.ok(r.export.height <= 1080, `${r.name}: ${r.export.height}`);
  assert.equal(RECIPES["social-vertical"].export.height, 1080);
});
