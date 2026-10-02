// Named recipes: each one is a complete, valid direction that passes its own
// checks, and none of them is a hidden default.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RECIPES, RECIPE_NAMES, recipeList, recipeNotes, resolveRecipe } from "../dist/studio/recipes.js";
import { ASPECTS, LOOKS, STYLE_CONFIG, STYLES } from "../dist/studio/styles.js";
import { MUSIC, VOICES } from "../dist/studio/narration.js";
import { configPartial } from "../dist/studio/editor/ops.js";
import { checkStyle } from "../dist/studio/pacing.js";
import { planEdit } from "../dist/studio/plan.js";

/** A project config as Screen Studio 4.0.1 saves it. */
const fixture = JSON.parse(
  await readFile(new URL("./fixtures/project-config.json", import.meta.url), "utf8"),
);

/** The config a recipe leaves behind, applied the way screenstudio_plan_edit's config op is. */
function applied(recipe) {
  const changes = {
    ...STYLE_CONFIG[recipe.style],
    ...(recipe.look ? LOOKS[recipe.look] : {}),
    ...recipe.config,
    "output.aspectRatio": ASPECTS[recipe.aspect],
  };
  const config = structuredClone(fixture);
  for (const [group, fields] of Object.entries(configPartial(config, changes)))
    config[group] = { ...config[group], ...fields };
  return config;
}

const click = (atMs, x, y) => ({ atMs, endMs: atMs + 80, x, y, drag: false, button: "left" });
const recording = () => ({
  projectPath: "/x.screenstudio",
  sourceDurationMs: 60000,
  capture: { kind: "window", widthPt: 1440, heightPt: 900 },
  sessions: [{ startMs: 0, endMs: 60000, video: "" }],
  clicks: [click(5000, 0.2, 0.3), click(7000, 0.25, 0.32), click(24000, 0.7, 0.6), click(45000, 0.5, 0.8)],
  typing: [{ startMs: 25000, endMs: 30000, chars: 60, x: 0.7, y: 0.6 }],
  shortcuts: [],
  movement: [],
  screen: {
    changes: [{ atMs: 45300, score: 0.6, kind: "page" }],
    active: [{ startMs: 45200, endMs: 50500 }],
  },
  idle: [
    { startMs: 0, endMs: 4800 },
    { startMs: 9000, endMs: 23800 },
    { startMs: 31000, endMs: 44800 },
    { startMs: 50600, endMs: 59500 },
  ],
});

test("a varied set of recipes, none of them a default", () => {
  assert.ok(RECIPE_NAMES.length >= 6);
  const recipes = Object.values(RECIPES);
  assert.ok(new Set(recipes.map((r) => r.look)).size >= 5, "looks vary");
  assert.equal(new Set(recipes.map((r) => r.style)).size, 3, "every style is used");
  assert.ok(new Set(recipes.map((r) => r.aspect)).size >= 2, "aspects vary");
  assert.deepEqual(
    recipeList().map((r) => r.name),
    [...RECIPE_NAMES],
  );
  for (const r of recipeList()) assert.ok(r.useFor.length > 40, r.name);
});

test("every recipe is a complete direction that names only real presets", () => {
  const voices = new Set(VOICES.map((v) => v.id));
  const tracks = new Set(Object.entries(MUSIC).flatMap(([genre, list]) => list.map((t) => `${genre}/${t}`)));
  for (const r of Object.values(RECIPES)) {
    assert.ok(Object.hasOwn(STYLES, r.style), r.name);
    assert.ok(r.look === null || Object.hasOwn(LOOKS, r.look), r.name);
    assert.ok(Object.hasOwn(ASPECTS, r.aspect), r.name);
    for (const key of [
      "captions.enableTranscript",
      "cursor.size",
      "cursor.clickEffect",
      "audio.clickSoundEffect",
      "audio.clickSoundEffectVolume",
    ])
      assert.ok(Object.hasOwn(r.config, key), `${r.name} sets ${key}`);
    if (r.config["captions.enableTranscript"]) assert.ok(r.config["captions.wordsReveal"], r.name);
    if (r.music) assert.ok(tracks.has(r.music.track), `${r.name}: ${r.music.track}`);
    if (r.voice) assert.ok(voices.has(r.voice.id), `${r.name}: ${r.voice.id}`);
    for (const k of Object.keys(r.rules))
      assert.ok(Object.hasOwn(STYLES.balanced, k), `${r.name}: rule ${k}`);
    assert.ok([24, 30, 60].includes(r.export.fps));
  }
});

test("every recipe's config is valid against a real project and never crops the frame", () => {
  for (const r of Object.values(RECIPES)) {
    const config = applied(r);
    assert.equal(config.output.avoidEmptyZoomArea, false, r.name);
    assert.ok(r.config["output.avoidEmptyZoomArea"] !== true, r.name);
    // Judged against itself, a recipe has nothing to complain about.
    const issues = checkStyle(config, [], { widthPt: 1440, heightPt: 900 }, r).filter(
      (i) => i.severity !== "info",
    );
    assert.deepEqual(issues, [], `${r.name}: ${JSON.stringify(issues)}`);
  }
});

test("every recipe's plan passes its own pacing check", () => {
  for (const r of Object.values(RECIPES)) {
    const plan = planEdit(recording(), { style: r.style, rules: r.rules, ...r.plan });
    const errors = plan.pacing.issues.filter((i) => i.severity === "error");
    assert.deepEqual(errors, [], r.name);
    assert.notEqual(plan.pacing.verdict, "too fast", `${r.name}: ${JSON.stringify(plan.pacing.issues)}`);
    if (r.plan.targetMs) assert.ok(plan.fit.fitted, `${r.name}: ${plan.summary}`);
    assert.ok(plan.notes.length > 3, r.name);
  }
});

test("off-recipe settings are flagged", () => {
  const keynote = RECIPES.keynote;
  const config = applied(keynote);
  config.cursor.clickEffect = { type: "ripple" };
  config.audio.clickSoundEffect = "apple-magic-mouse";
  config.captions.wordsReveal = "word-by-word";
  const off = checkStyle(config, [], undefined, keynote).filter((i) => i.code === "off-recipe");
  assert.equal(off.length, 3);
  assert.ok(off.every((i) => i.severity === "warn"));
  // social-vertical reveals whole lines too: word-by-word shows one word at a time in Screen Studio 4.
  assert.equal(RECIPES["social-vertical"].config["captions.wordsReveal"], "line-by-line");
  assert.equal(RECIPES["social-vertical"].config["captions.wordEntrance"], "fade-in");
  const vertical = applied(RECIPES["social-vertical"]);
  vertical.captions.wordsReveal = "word-by-word";
  const flagged = checkStyle(vertical, [], undefined, RECIPES["social-vertical"]);
  assert.deepEqual(
    flagged.filter((i) => i.code === "off-recipe").map((i) => i.severity),
    ["warn"],
  );
  // A recipe that asks for word by word only notes a line-by-line reveal.
  const wordy = {
    ...RECIPES["social-vertical"],
    config: { ...RECIPES["social-vertical"].config, "captions.wordsReveal": "word-by-word" },
  };
  vertical.captions.wordsReveal = "line-by-line";
  assert.deepEqual(
    checkStyle(vertical, [], undefined, wordy)
      .filter((i) => i.code === "off-recipe")
      .map((i) => i.severity),
    ["info"],
  );
  // Without a recipe the same settings are a matter of preference, not an issue.
  assert.ok(!checkStyle(config).some((i) => i.code === "off-recipe"));
});

test("overrides merge field by field and unknown fields are refused", () => {
  const r = resolveRecipe("changelog", {
    style: "snappy",
    plan: { targetMs: 20000 },
    config: { "captions.enableTranscript": true, "captions.wordsReveal": "line-by-line" },
    music: { volume: 0.04 },
    voice: { id: "en-US-BrianMultilingualNeural" },
  });
  assert.equal(r.style, "snappy");
  assert.equal(r.plan.maxZooms, 2);
  assert.equal(r.plan.targetMs, 20000);
  assert.equal(r.config["cursor.clickEffect"], null);
  assert.equal(r.config["captions.enableTranscript"], true);
  assert.deepEqual(r.music, { track: "lo-fi/Cozy Chillhop", volume: 0.04, duckTo: 0.35 });
  assert.deepEqual(r.voice, { id: "en-US-BrianMultilingualNeural", rate: 0 });
  assert.equal(RECIPES.changelog.style, "balanced", "the recipe itself is untouched");
  assert.equal(resolveRecipe("keynote", { music: null }).music, null);
  assert.throws(() => resolveRecipe("keynote", { colour: "red" }), /recipeOverrides/);
  assert.throws(() => resolveRecipe("keynote", { plan: { zoomz: 1 } }), /recipeOverrides/);
  assert.throws(() => resolveRecipe("keynote", { rules: { leadIn: 3 } }), /recipeOverrides/);
  assert.throws(() => resolveRecipe("docs-walkthrough", { music: { volume: 0.1 } }), /needs a track/);
  assert.throws(() => resolveRecipe("nope"), /Unknown recipe nope/);
  const notes = recipeNotes(RECIPES.keynote).join(" ");
  for (const want of ["calm pacing", "Noble Documentary", "AndrewMultilingual", "1080p 60fps", "Loupes"])
    assert.ok(notes.includes(want), want);
});

test("the recipes tool lists every recipe and resolves one with overrides", async () => {
  const client = new Client({ name: "recipes", version: "1" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: ["dist/mcp/main.js"], stderr: "pipe" }),
  );
  try {
    const { tools } = await client.listTools();
    for (const name of ["screenstudio_recipes", "screenstudio_plan_layouts"])
      assert.ok(
        tools.some((t) => t.name === name),
        name,
      );
    const plan = tools.find((t) => t.name === "screenstudio_plan_edit").inputSchema.properties;
    for (const p of ["recipe", "recipeOverrides", "targetMs", "structure", "markers", "talkingHead"])
      assert.ok(plan[p], p);
    const list = await client.callTool({ name: "screenstudio_recipes", arguments: {} });
    assert.equal(JSON.parse(list.content[0].text).recipes.length, RECIPE_NAMES.length);
    const one = await client.callTool({
      name: "screenstudio_recipes",
      arguments: { name: "tutorial", overrides: { export: { fps: 60 } } },
    });
    const { recipe, notes } = JSON.parse(one.content[0].text);
    assert.equal(recipe.export.fps, 60);
    assert.ok(notes.length >= 4);
    const bad = await client.callTool({
      name: "screenstudio_recipes",
      arguments: { name: "tutorial", overrides: { exports: {} } },
    });
    assert.equal(bad.isError, true);
  } finally {
    await client.close();
  }
});
