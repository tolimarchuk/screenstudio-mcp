import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pacingFor, type Context } from "../context.js";
import { READ, path, span, toolsOn } from "../tool.js";
import { describeScene } from "../../studio/editor/describe.js";
import { planEdit } from "../../studio/plan.js";
import { checkLayouts } from "../../studio/pacing.js";
import { planLayouts } from "../../studio/camera.js";
import {
  RECIPES,
  RECIPE_NAMES,
  composeConfig,
  recipeList,
  recipeNotes,
  resolveRecipe,
  withBrand,
  type Recipe,
} from "../../studio/recipes.js";
import { compileBrand, readBrand, type Brand } from "../../studio/brand.js";
import { catalog } from "../../studio/assets.js";
import { ASPECTS, DEFAULT_STYLE, LOOKS, STYLE_NAMES } from "../../studio/styles.js";

const names = (o: object) => Object.keys(o) as [string, ...string[]];
const recipeName = z.enum(RECIPE_NAMES);
const overrides = z
  .record(z.string(), z.unknown())
  .describe(
    "Change parts of the recipe: style, look, aspect, loupes, plan {...}, rules {...}, config {dotted keys}, music, voice, export. Fields merge into the recipe's.",
  );

/** A saved brand compiled for this plan: only its own fields when a recipe or look sets the rest. */
async function brandFor(ctx: Context, name: string, o: { ownOnly: boolean; config?: any }) {
  const brand = await readBrand(ctx.studio.stateDir, name);
  const compiled = compileBrand(brand, {
    cursorSets: await catalog(ctx.studio.appPath).then(
      (c) => c.cursorSets,
      () => undefined,
    ),
    config: o.config,
    ownOnly: o.ownOnly,
  });
  return { brand, ...compiled };
}

/**
 * The recipe a check judges against, as plan_edit applied it: overrides merged
 * and the brand's own settings laid over its config, so choices made on purpose
 * are not flagged as off-recipe.
 */
export async function recipeForCheck(
  ctx: Context,
  o: { recipe?: string; recipeOverrides?: unknown; brand?: string },
): Promise<{ recipe?: Recipe; brand?: Brand }> {
  if (!o.recipe) {
    if (o.recipeOverrides) throw new Error("recipeOverrides needs a recipe.");
    if (o.brand) throw new Error("brand needs a recipe.");
    return {};
  }
  let recipe = resolveRecipe(o.recipe, o.recipeOverrides);
  const name = o.brand ?? recipe.brand ?? undefined;
  if (!name) return { recipe };
  const b = await brandFor(ctx, name, { ownOnly: true });
  recipe = withBrand(recipe, b.brand).recipe;
  recipe.config = { ...recipe.config, ...b.changes };
  return { recipe, brand: b.brand };
}

export function register(server: McpServer, ctx: Context) {
  const tool = toolsOn(server);

  tool(
    "screenstudio_plan_edit",
    `Propose an edit from the footage (read the craft resource first): keep each beat with lead-in and a readable hold, cut dead air, speed up only typing and waiting, and add few long zooms grouped like Screen Studio's auto-zoom (clicks under 5.3s apart share one zoom that pans). Returns ops ready for screenstudio_editor_apply, its pacing check, scored beats and director's notes (each decision at its playback time with the rule behind it). Styles: ${DEFAULT_STYLE} (default, product demos), calm (docs and tutorials), snappy (short social clips). keep/drop take source-ms spans to override (keep also protects narrated stretches). Speech from the transcript is never cut or sped up; tightenPausesMs (250-400 for talking videos) trims silences between phrases, removeFillers drops um/uh. speedUps:false for narrated videos. look applies a starting frame (wallpaper, gradient, dark, light, minimal, social; none is a default, choose for the content; keep leaves the project's own frame, even under a recipe); aspect sets the output frame. targetMs fits the edit to a length by dropping the lowest-value beats (never the payoff), listed in droppedBeats; structure hook-demo-payoff also suggests a coldOpen. markers (keep by default when the recording has markers): keep starts a beat at each marker and protects it, retake drops the take before a repeated line, chapters numbers the beats. markerBeatsMs (one length per marker, a narration line's beatMs) keeps [marker, marker + ms] so a hold stretched for a voiced line survives. talkingHead plans camera layouts too (skipped when the recording has no camera). recipe (${RECIPE_NAMES.join(", ")}; see screenstudio_recipes) sets style, look, aspect, plan options, captions, cursor and click sound in one word, and returns its music, voice and export settings; explicit arguments win over the recipe, and the notes say what replaced what. No recipe is applied unless named. brand (a kit saved with screenstudio_brand, or the recipe's brand) lays its own colours, captions, cursor and sound over the plan's config (under a recipe or look, its starting look is left out), and its voice and music replace the recipe's where the recipe has them.`,
    {
      projectPath: path,
      style: z.enum(STYLE_NAMES).optional(),
      keep: z.array(span).max(50).optional(),
      drop: z.array(span).max(50).optional(),
      zoom: z.enum(["auto", "none"]).optional().describe("Default auto."),
      maxZooms: z.number().int().min(0).max(30).optional(),
      speedUps: z.boolean().optional().describe("Default true."),
      applyStyleConfig: z.boolean().default(true),
      look: z
        .enum(["keep", ...names(LOOKS)])
        .optional()
        .describe("Default keep."),
      tightenPausesMs: z.number().int().min(150).max(1500).optional(),
      removeFillers: z.boolean().optional().describe("Default false."),
      aspect: z.enum(names(ASPECTS)).optional(),
      targetMs: z.number().int().min(3000).max(3600000).optional(),
      structure: z.enum(["linear", "hook-demo-payoff"]).optional(),
      markers: z.enum(["ignore", "keep", "retake", "chapters"]).optional(),
      markerBeatsMs: z
        .array(z.number().int().min(0).max(120000))
        .max(200)
        .optional()
        .describe("Voiced beats: one length per marker, in marker order."),
      talkingHead: z.boolean().optional(),
      recipe: recipeName.optional(),
      recipeOverrides: overrides.optional(),
      brand: z.string().min(1).max(40).optional(),
    },
    READ,
    async (a) => {
      if (a.recipeOverrides && !a.recipe) throw new Error("recipeOverrides needs a recipe.");
      let recipe = a.recipe ? resolveRecipe(a.recipe, a.recipeOverrides) : undefined;
      const rp = recipe?.plan ?? {};
      const style = a.style ?? recipe?.style ?? DEFAULT_STYLE;
      const aspect = a.aspect ?? recipe?.aspect;
      const r = await ctx.analysisFor(a.projectPath);
      const current = await ctx.timeline(a.projectPath).catch(() => null);
      const config = current?.project.config;
      const extraNotes: string[] = [];

      // A brand kit, named here or by the recipe. Under a recipe or a look it adds
      // only its own fields; its starting look would undo the choices made here.
      const brandName = a.brand ?? recipe?.brand ?? undefined;
      const branded = brandName
        ? await brandFor(ctx, brandName, { ownOnly: !!recipe || a.look !== undefined, config })
        : undefined;
      const brand = branded?.brand;
      if (brand && recipe) {
        const b = withBrand(recipe, brand);
        recipe = b.recipe;
        extraNotes.push(...b.notes);
      }
      if (brand)
        extraNotes.unshift(
          `Brand ${brand.name}: its colours, captions, cursor and sound go over ${recipe ? "the recipe's" : "the style's"} settings.`,
          ...branded!.notes,
        );

      // No camera: a recipe's talking-head plan and camera settings have nothing to show.
      let talkingHead = a.talkingHead ?? rp.talkingHead;
      if (r.hasCamera === false && recipe && rp.talkingHead && a.talkingHead === undefined) {
        talkingHead = false;
        const cameraKeys = Object.keys(recipe.config).filter(
          (k) => k.startsWith("defaultLayout.") || k.startsWith("camera."),
        );
        recipe = {
          ...recipe,
          config: Object.fromEntries(Object.entries(recipe.config).filter(([k]) => !cameraKeys.includes(k))),
        };
        extraNotes.push(
          `This recording has no camera, so ${recipe.name}'s camera layouts and settings (${cameraKeys.join(", ") || "none"}) were left out.`,
        );
      }
      // Captions will be on after the apply when the recipe or brand turns them on.
      const want = { ...recipe?.config, ...branded?.changes };
      const captionsOn =
        typeof want["captions.enableTranscript"] === "boolean"
          ? (want["captions.enableTranscript"] as boolean)
          : undefined;

      const plan = planEdit(r, {
        style,
        keep: a.keep,
        drop: a.drop,
        zoom: a.zoom ?? rp.zoom ?? "auto",
        maxZooms: a.maxZooms ?? rp.maxZooms,
        speedUps: a.speedUps ?? rp.speedUps ?? true,
        tightenPausesMs: a.tightenPausesMs ?? rp.tightenPausesMs,
        removeFillers: a.removeFillers ?? rp.removeFillers ?? false,
        targetMs: a.targetMs ?? rp.targetMs,
        structure: a.structure ?? rp.structure,
        markers: a.markers ?? rp.markers,
        markerBeatsMs: a.markerBeatsMs,
        talkingHead,
        rules: recipe?.rules,
        camera: { config, captionsOn },
      });
      const composed = composeConfig({
        styleConfig: a.applyStyleConfig ? plan.config : undefined,
        camera: plan.layouts?.config,
        recipe,
        baseLook: a.recipe ? RECIPES[a.recipe].look : undefined,
        look: a.look,
        brand: branded?.changes,
        brandName: brand?.name,
        aspect: aspect ? ASPECTS[aspect] : undefined,
      });
      const changes = composed.changes;
      const notes = [
        ...(recipe
          ? recipeNotes(recipe, {
              style,
              look: a.look ?? recipe.look,
              aspect,
              config: changes,
              replacedBy: {
                style: a.style && "you",
                look: a.look && "you",
                aspect: a.aspect && "you",
                config: brand && `brand ${brand.name}`,
              },
            })
          : []),
        ...extraNotes,
        ...composed.notes,
        ...plan.notes,
      ];
      return {
        summary: plan.summary,
        notes,
        pacing: plan.pacing,
        currentPacing: current
          ? pacingFor(
              current,
              r,
              style,
              recipe
                ? {
                    rules: recipe.rules,
                    recipe: { ...recipe, config: { ...recipe.config, ...branded?.changes } },
                  }
                : undefined,
            )
          : undefined,
        fit: plan.fit,
        beats: plan.beats,
        droppedBeats: plan.droppedBeats,
        coldOpen: plan.coldOpen,
        slices: plan.slices,
        zooms: plan.zooms,
        layouts: plan.layouts?.stretches,
        recipe: recipe && {
          name: recipe.name,
          useFor: recipe.useFor,
          style,
          aspect: aspect ?? recipe.aspect,
          music: recipe.music,
          voice: recipe.voice,
          export: recipe.export,
          loupes: recipe.loupes,
          targets: recipe.targets,
        },
        brand: brand && { name: brand.name, voice: brand.voice, music: brand.music },
        ops: [
          { op: "setSlices", slices: plan.slices.map(({ reason: _r, ...s }) => s) },
          { op: "clearZooms" },
          ...plan.zooms.map((z) => ({
            op: "addZoom",
            startMs: z.sourceStartMs,
            endMs: z.sourceEndMs,
            zoom: z.zoom,
            follow: z.follow,
            ...(z.follow ? {} : { target: z.target }),
          })),
          ...(plan.layouts ? plan.layouts.ops.filter((o) => o.op !== "config") : []),
          ...(Object.keys(changes).length ? [{ op: "config", changes }] : []),
        ],
      };
    },
  );

  tool(
    "screenstudio_recipes",
    "Named recipes: one word for a whole direction (pacing style, frame, aspect, plan options, captions, cursor, click sound, music, voice, export). Without a name, lists each with when to use it; with a name, returns the full recipe with any overrides merged and what it sets in plain words; with brand (or overrides.brand), the saved kit's own settings, voice and music laid over it. None is a default: pick the one that fits the content and where it will be watched, then pass it as recipe to screenstudio_plan_edit.",
    {
      name: recipeName.optional(),
      overrides: overrides.optional(),
      brand: z.string().min(1).max(40).optional(),
    },
    READ,
    async (a) => {
      if (!a.name) {
        if (a.overrides || a.brand) throw new Error("overrides and brand need a recipe name.");
        return { recipes: recipeList() };
      }
      let recipe = resolveRecipe(a.name, a.overrides);
      const brandName = a.brand ?? recipe.brand ?? undefined;
      if (!brandName) return { recipe, notes: recipeNotes(recipe) };
      // An unknown brand is an error here, not a note that promises it.
      const b = await brandFor(ctx, brandName, { ownOnly: true });
      const withKit = withBrand(recipe, b.brand);
      recipe = withKit.recipe;
      const config = { ...recipe.config, ...b.changes };
      return {
        recipe: { ...recipe, config },
        notes: [
          ...recipeNotes(recipe, { config, replacedBy: { config: `brand ${b.brand.name}` } }),
          ...withKit.notes,
          ...b.notes,
        ],
      };
    },
  );

  tool(
    "screenstudio_plan_layouts",
    "Camera director for talking-head recordings: plans camera layouts from the speech, clicks and zooms. The cutout camera is the default layout, on the side away from the clicks; you full screen for the opening line and the sign-off; screen only while a zoom asks the viewer to read; split screen under long talk with nothing clicked. Every change lands in a pause between sentences, at least 5s apart (minStretchMs when longer). from timeline (default) plans over the open editor's current cut; from plan plans over a fresh screenstudio_plan_edit plan, so pass the same recipe and plan options you applied it with. Returns ops for screenstudio_editor_apply (clears the layouts track first), the stretches, a layout check and notes saying why. A recording with no camera gets no layouts.",
    {
      projectPath: path,
      from: z.enum(["timeline", "plan"]).default("timeline"),
      style: z.enum(STYLE_NAMES).optional().describe(`Default ${DEFAULT_STYLE}, or the recipe's.`),
      recipe: recipeName.optional(),
      recipeOverrides: overrides.optional(),
      keep: z.array(span).max(50).optional(),
      drop: z.array(span).max(50).optional(),
      zoom: z.enum(["auto", "none"]).optional().describe("Default auto, or the recipe's."),
      maxZooms: z.number().int().min(0).max(30).optional(),
      speedUps: z.boolean().optional(),
      tightenPausesMs: z.number().int().min(150).max(1500).optional(),
      removeFillers: z.boolean().optional(),
      targetMs: z.number().int().min(3000).max(3600000).optional(),
      structure: z.enum(["linear", "hook-demo-payoff"]).optional(),
      markers: z.enum(["ignore", "keep", "retake", "chapters"]).optional(),
      markerBeatsMs: z.array(z.number().int().min(0).max(120000)).max(200).optional(),
      side: z
        .union([z.literal("auto"), z.literal(0), z.literal(1)])
        .default("auto")
        .describe("Cutout camera side: 0 left, 1 right, auto away from the clicks."),
      bookends: z.boolean().default(true),
      splitScreen: z.boolean().default(true),
      loupesScreenOnly: z.boolean().default(false),
      minStretchMs: z.number().int().min(2000).max(30000).default(6000),
    },
    READ,
    async (a) => {
      const r = await ctx.analysisFor(a.projectPath);
      const current = await ctx.timeline(a.projectPath).catch(() => null);
      let edit;
      if (a.from === "timeline") {
        if (!current) throw new Error("No timeline to plan over. Open the project, or pass from: plan.");
        edit = { slices: current.scene.slices, zooms: current.scene.zooms };
      } else {
        if (a.recipeOverrides && !a.recipe) throw new Error("recipeOverrides needs a recipe.");
        const recipe = a.recipe ? resolveRecipe(a.recipe, a.recipeOverrides) : undefined;
        const rp = recipe?.plan ?? {};
        // The same plan the edit was applied with, so layouts fit the cut the editor has.
        const plan = planEdit(r, {
          style: a.style ?? recipe?.style ?? DEFAULT_STYLE,
          keep: a.keep,
          drop: a.drop,
          zoom: a.zoom ?? rp.zoom ?? "auto",
          maxZooms: a.maxZooms ?? rp.maxZooms,
          speedUps: a.speedUps ?? rp.speedUps ?? true,
          tightenPausesMs: a.tightenPausesMs ?? rp.tightenPausesMs,
          removeFillers: a.removeFillers ?? rp.removeFillers ?? false,
          targetMs: a.targetMs ?? rp.targetMs,
          structure: a.structure ?? rp.structure,
          markers: a.markers ?? rp.markers,
          markerBeatsMs: a.markerBeatsMs,
          rules: recipe?.rules,
        });
        edit = {
          slices: plan.slices.map((s) => ({
            sourceStartMs: s.startMs,
            sourceEndMs: s.endMs,
            timeScale: 1 / s.speed,
          })),
          zooms: plan.zooms,
        };
      }
      const layouts = planLayouts(r, edit, {
        side: a.side,
        bookends: a.bookends,
        splitScreen: a.splitScreen,
        loupesScreenOnly: a.loupesScreenOnly,
        minStretchMs: a.minStretchMs,
        config: current?.project.config,
      });
      return {
        ops: layouts.ops,
        stretches: layouts.stretches,
        side: layouts.side,
        issues: checkLayouts(layouts.stretches, edit.slices, r.sentences ?? r.speech),
        notes: layouts.notes,
      };
    },
  );

  tool(
    "screenstudio_check_pacing",
    "Judge a timeline the way a viewer feels it, in playback time: short or back-to-back zooms, zoom rate, choppy cuts, speed ramps, sped-up clicks, snappy springs, abrupt endings, camera layouts changing too often or mid-sentence, plus visual-settings checks (frame cropping, cursor flicker, loupe depth and overuse, loud click sounds, heavy blur). With recipe (plus the recipeOverrides and brand you planned with), also flags settings that work against it (off-recipe). Uses the open editor's live state when available.",
    {
      projectPath: path,
      sceneId: z.string().optional(),
      style: z.enum(STYLE_NAMES).optional().describe(`Default ${DEFAULT_STYLE}, or the recipe's.`),
      recipe: recipeName.optional(),
      recipeOverrides: overrides.optional(),
      brand: z.string().min(1).max(40).optional(),
    },
    READ,
    async (a) => {
      const { recipe } = await recipeForCheck(ctx, a);
      const t = await ctx.timeline(a.projectPath, a.sceneId);
      const r = await ctx.analysisFor(a.projectPath).catch(() => undefined);
      return {
        live: t.live,
        ...pacingFor(
          t,
          r,
          a.style ?? recipe?.style ?? DEFAULT_STYLE,
          recipe ? { rules: recipe.rules, recipe } : undefined,
        ),
        timeline: describeScene(t.scene),
      };
    },
  );
}
