// How the lanes connect: recipes name export targets and brand kits, export
// variants take a recipe's export settings, and status lists every tool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RECIPES, RECIPE_NAMES, recipeNotes, resolveRecipe, withBrand } from "../dist/studio/recipes.js";
import { TARGETS, TARGET_NAMES, limitChecks, targetsForSpec } from "../dist/studio/deliver.js";
import { capabilities } from "../dist/studio/compat.js";

test("every recipe names real export targets and no brand", () => {
  for (const name of RECIPE_NAMES) {
    const r = RECIPES[name];
    assert.ok(r.targets.length > 0, name);
    for (const t of r.targets) assert.ok(TARGET_NAMES.includes(t), `${name}: ${t}`);
    assert.equal(r.brand, null, `${name} must not apply a brand unless asked`);
  }
  assert.ok(
    recipeNotes(RECIPES.changelog).some((n) => n.includes("screenstudio_export_variants: x, linkedin.")),
  );
});

test("recipe overrides set targets and a brand by name, and refuse unknown targets", () => {
  const r = resolveRecipe("keynote", { targets: ["x", "x", "gif"], brand: "Acme Blue" });
  assert.deepEqual(r.targets, ["x", "gif"]);
  assert.equal(r.brand, "Acme Blue");
  assert.ok(recipeNotes(r).some((n) => n.startsWith("Brand: Acme Blue")));
  assert.throws(() => resolveRecipe("keynote", { targets: ["tiktok"] }), /targets/);
  assert.throws(() => resolveRecipe("keynote", { targets: [] }), /targets/);
  assert.equal(RECIPES.keynote.brand, null, "overrides never change the built-in recipe");
});

test("a brand's voice and music replace the recipe's, keeping its rate and ducking", () => {
  const { recipe, notes } = withBrand(RECIPES["social-vertical"], {
    name: "Acme",
    voice: "en-US-AvaMultilingualNeural",
    music: "lo-fi/Cozy Chillhop",
  });
  assert.deepEqual(recipe.voice, {
    id: "en-US-AvaMultilingualNeural",
    rate: RECIPES["social-vertical"].voice.rate,
  });
  assert.equal(recipe.music.track, "lo-fi/Cozy Chillhop");
  assert.equal(recipe.music.duckTo, RECIPES["social-vertical"].music.duckTo);
  assert.equal(recipe.brand, "Acme");
  assert.equal(notes.length, 2);
  assert.equal(
    RECIPES["social-vertical"].voice.id,
    "en-US-EmmaMultilingualNeural",
    "the recipe is not changed",
  );

  const silent = withBrand(RECIPES.keynote, { name: "Quiet", music: null });
  assert.equal(silent.recipe.music, null);
  assert.deepEqual(silent.recipe.voice, RECIPES.keynote.voice);
  assert.match(silent.notes[0], /no music/);

  const plain = withBrand(RECIPES.tutorial, { name: "Plain" });
  assert.deepEqual(plain.notes, []);
  // A recipe that leaves out voice or music on purpose keeps them out; the brand's are only offered.
  const voiced = withBrand(RECIPES.changelog, { name: "Voiced", voice: "en-US-AndrewMultilingualNeural" });
  assert.equal(voiced.recipe.voice, null);
  assert.match(voiced.notes[0], /available if you decide to narrate/);
  const docs = withBrand(RECIPES["docs-walkthrough"], { name: "Loud", music: "lo-fi/Cozy Chillhop" });
  assert.equal(docs.recipe.music, null);
  assert.match(docs.notes[0], /available if you decide to add music/);
});

test("a recipe's export spec sets frame rate on video targets and resolution on its own aspect", () => {
  const talking = resolveRecipe("founder-talking-head");
  const { targets, notes } = targetsForSpec(["x", "shorts", "gif"], {
    aspect: talking.aspect,
    ...talking.export,
  });
  assert.equal(targets.x.fps, 30);
  assert.equal(targets.x.height, 1080);
  assert.equal(targets.shorts.fps, 30);
  assert.equal(targets.shorts.height, TARGETS.shorts.height, "other aspects keep their resolution");
  assert.equal(targets.gif, undefined, "GIFs keep their own budget");
  assert.ok(notes.some((n) => n.startsWith("x: 30fps instead of 60")));

  // Recipe heights are the short side too, so a vertical recipe matches the shorts target.
  const vertical = resolveRecipe("social-vertical");
  const v = targetsForSpec(["shorts"], { aspect: vertical.aspect, ...vertical.export });
  assert.equal(v.targets.shorts.height, 1080);
  assert.deepEqual(v.notes, []);

  const draft = targetsForSpec(["landing"], { aspect: "16:9", height: 720, fps: 60, format: "gif" });
  assert.equal(draft.targets.landing.height, 720);
  assert.ok(draft.notes.some((n) => n.includes("add the gif target")));
  // The resolution check follows the target's own height.
  const ok = limitChecks("landing", draft.targets.landing, {
    durationMs: 1000,
    width: 1280,
    height: 720,
    fps: 60,
    bytes: 1,
  });
  assert.equal(ok.filter((c) => !c.ok).length, 0);
});

test("the server registers every tool status lists, with the cross-lane params", async () => {
  const client = new Client({ name: "integration", version: "1" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: ["dist/mcp/main.js"], stderr: "pipe" }),
  );
  try {
    const { tools } = await client.listTools();
    for (const name of capabilities.tools)
      assert.ok(
        tools.some((t) => t.name === name),
        name,
      );
    const props = (name) => tools.find((t) => t.name === name).inputSchema.properties;
    assert.ok(props("screenstudio_plan_edit").brand);
    for (const p of ["recipe", "recipeOverrides", "targets"])
      assert.ok(props("screenstudio_export_variants")[p], p);
    assert.ok(
      !tools.find((t) => t.name === "screenstudio_export_variants").inputSchema.required?.includes("targets"),
    );

    const none = await client.callTool({
      name: "screenstudio_export_variants",
      arguments: { projectPath: "/tmp/x.screenstudio", outputDir: "/tmp" },
    });
    assert.equal(none.isError, true);
    assert.match(none.content[0].text, /Pass targets, or a recipe/);
    const stray = await client.callTool({
      name: "screenstudio_export_variants",
      arguments: {
        projectPath: "/tmp/x.screenstudio",
        outputDir: "/tmp",
        recipeOverrides: { targets: ["x"] },
      },
    });
    assert.match(stray.content[0].text, /recipeOverrides needs a recipe/);
  } finally {
    await client.close();
  }
});
