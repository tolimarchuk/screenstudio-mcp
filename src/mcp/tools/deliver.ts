import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pacingFor, type Context } from "../context.js";
import { READ, WRITE, image, path, progressOf, style, toolsOn } from "../tool.js";
import { describeScene } from "../../studio/editor/describe.js";
import { TARGETS, TARGET_NAMES, exportVariants, makeLoop, targetsForSpec } from "../../studio/deliver.js";
import { RECIPE_NAMES, resolveRecipe } from "../../studio/recipes.js";
import { DEFAULT_STYLE, STYLE_NAMES } from "../../studio/styles.js";
import { contactSheet, contactSheetFromJobs, keyMoments, type Moment } from "../../studio/sheet.js";
import { readTranscript } from "../../studio/transcript.js";

const targetList = Object.entries(TARGETS)
  .map(([name, t]) => `${name} (${t.aspect} ${t.height}p${t.fps}${t.format === "gif" ? " GIF" : ""})`)
  .join(", ");

export function register(server: McpServer, ctx: Context) {
  const { studio, editor } = ctx;
  const tool = toolsOn(server);

  tool(
    "screenstudio_export_variants",
    `Render one edit for every place it goes, in one call: ${targetList}. Each target renders its own copy of the live project (aspect, padding, caption size and position, camera cutout size; vertical targets get fixed zooms on the main actions so they stay readable, and portrait targets keep the screen zoomed between zooms, about 1.8x in 9:16, so it fills the frame's width instead of a thin band), one after another, named <baseName>-<target>.<ext> in outputDir, never overwriting. The editor is not changed. A copy whose frame would crop every wide shot has avoid-empty-zoom-area turned off, and says so. Narration captioned for burn-in is burned into a <baseName>-<target>-captioned.mp4 beside each video. The kit (default on) adds a poster PNG per aspect at the payoff moment, .srt and .vtt captions when there is a transcript or narration, a chapters list (yours are put in order, the first at 0:00, at least 10s apart), a manifest with each file's duration, size and limit checks, and a contact sheet of every variant. With recipe, targets default to the recipe's and its export settings apply (frame rate on every video, resolution on its own aspect). Returns files, warnings and notes explaining each choice. Takes minutes; renders run in Screen Studio one at a time, with a progress notification per target, and a render past renderTimeoutMs (default 20 minutes) is cancelled before the next starts. A second call for the same project and outputDir is refused while one runs.`,
    {
      projectPath: path,
      targets: z
        .array(z.enum(TARGET_NAMES))
        .min(1)
        .max(TARGET_NAMES.length)
        .optional()
        .describe("Required unless recipe names them."),
      outputDir: path,
      baseName: z.string().min(1).max(80).optional(),
      kit: z.boolean().default(true),
      chapters: z
        .array(
          z
            .object({
              playbackMs: z.number().min(0),
              label: z
                .string()
                .min(1)
                .max(80)
                .regex(/^[^\r\n]+$/, "One line per chapter label."),
            })
            .strict(),
        )
        .max(50)
        .optional(),
      renderTimeoutMs: z
        .number()
        .int()
        .min(60000)
        .max(2 * 3600000)
        .optional()
        .describe("Per target; default 20 minutes. A render past it is cancelled."),
      style: z.enum(STYLE_NAMES).optional().describe(`Default ${DEFAULT_STYLE}, or the recipe's.`),
      recipe: z.enum(RECIPE_NAMES).optional(),
      recipeOverrides: z.record(z.string(), z.unknown()).optional(),
    },
    WRITE,
    async (a, extra) => {
      if (a.recipeOverrides && !a.recipe) throw new Error("recipeOverrides needs a recipe.");
      const recipe = a.recipe ? resolveRecipe(a.recipe, a.recipeOverrides) : undefined;
      const targets = a.targets ?? recipe?.targets;
      if (!targets) throw new Error("Pass targets, or a recipe whose targets to render.");
      const spec = recipe && targetsForSpec(targets, { aspect: recipe.aspect, ...recipe.export });
      const projectPath = await studio.path(a.projectPath);
      const analysis = await ctx.analysisFor(projectPath).catch(() => undefined);
      const words = await readTranscript(studio, projectPath)
        .then((t) => t.words)
        .catch(() => []);
      const { sheet, ...result } = await exportVariants(
        studio,
        editor,
        projectPath,
        {
          targets,
          outputDir: a.outputDir,
          baseName: a.baseName,
          kit: a.kit,
          chapters: a.chapters,
          specs: spec?.targets,
        },
        {
          analysis,
          words,
          style: a.style ?? recipe?.style,
          renderTimeoutMs: a.renderTimeoutMs,
          progress: progressOf(extra),
          signal: extra.signal,
        },
      );
      if (recipe)
        result.notes.unshift(
          `Recipe ${recipe.name}: ${a.targets ? "your targets" : `its targets (${targets.join(", ")})`}, ${a.style ?? recipe.style} pacing for the vertical zooms.`,
          ...spec!.notes,
        );
      if (!analysis)
        result.notes.push(
          "The footage could not be analysed, so vertical zooms, chapters and the poster moment fell back.",
        );
      return sheet
        ? { images: [image(sheet.data, "Every variant at its opening, midpoint and ending")], text: result }
        : result;
    },
  );

  tool(
    "screenstudio_loop",
    "Make a seamless loop for a landing page hero or a README: finds a stretch of the recording (targetMs, 4-15s) whose last frame matches its first (beat edge to beat edge, or a window inside one long beat cut at sentence breaks and still screens), applies it to a copy of the project (<name> Loop.screenstudio, opened in the editor) so the main edit stays intact, mutes sound, brings the cursor back to its start and ends zooms before the restart, then renders MP4 (1080p60), a silent WebM and a GIF under maxGifBytes, plus a poster. Returns the files, the source range, the similarity score (SSIM), an embed snippet, notes, and the first and last frames side by side to judge the join. apply:false only plans and shows the join from the raw recording.",
    {
      projectPath: path,
      targetMs: z.number().int().min(4000).max(15000).default(8000),
      outputDir: path,
      baseName: z.string().min(1).max(80).optional(),
      formats: z
        .array(z.enum(["mp4", "webm", "gif"]))
        .min(1)
        .default(["mp4", "webm", "gif"]),
      maxGifBytes: z.number().int().min(500_000).max(50_000_000).default(8_000_000),
      apply: z.boolean().default(true),
      show: z.boolean().default(true),
    },
    WRITE,
    async (a) => {
      const projectPath = await studio.path(a.projectPath);
      const analysis = await ctx.analysisFor(projectPath);
      const { seam, ...result } = await makeLoop(studio, editor, projectPath, analysis, {
        ...a,
        formats: [...new Set(a.formats)],
      });
      if (!seam) return result;
      return {
        images: [image(seam.data, "First and last frame of the loop: they should look the same")],
        text: result,
      };
    },
  );

  tool(
    "screenstudio_contact_sheet",
    "Review a whole edit in one image: a labelled grid of the open editor's preview at the moments that matter (opening, each cut and the frame before it, each zoom's midpoint, layouts, masks, pacing issues, the ending), or at playbackMs you choose (up to 24). Each tile reads 'n · m:ss.s what'. With jobIds instead, one row per finished export at its opening, midpoint and ending. Use it before editor_frame, which is for a close look at one moment. The editor window must be on screen.",
    {
      projectPath: path.optional(),
      playbackMs: z.array(z.number().min(0)).min(1).max(24).optional(),
      jobIds: z.array(z.string().uuid()).min(1).max(8).optional(),
      columns: z.number().int().min(1).max(6).default(4),
      width: z.number().int().min(240).max(960).default(480),
      style,
    },
    READ,
    async (a) => {
      if (a.jobIds) {
        const s = await contactSheetFromJobs(studio, a.jobIds, { width: Math.min(a.width, 480) });
        return {
          images: [image(s.data, "Each export at its opening, midpoint and ending")],
          text: { path: s.path, tiles: s.tiles, notes: s.notes },
        };
      }
      if (!a.projectPath)
        throw new Error("Pass projectPath for the editor's preview, or jobIds for finished exports.");
      const t = await ctx.timeline(a.projectPath);
      if (!t.live)
        throw new Error("The project is not open in the editor. Call screenstudio_editor_open first.");
      const moments: Moment[] = a.playbackMs
        ? [...a.playbackMs].sort((x, y) => x - y).map((ms) => ({ playbackMs: ms, kind: "pick", label: "" }))
        : keyMoments(describeScene(t.scene), {
            issues: pacingFor(t, ctx.cachedAnalysis(t.projectPath), a.style).issues,
          });
      const s = await contactSheet(studio, editor, t.projectPath, moments, {
        columns: a.columns,
        width: a.width,
      });
      return {
        images: [image(s.data, `${s.tiles.length} moments of the edit`)],
        text: {
          path: s.path,
          tiles: s.tiles,
          notes: [
            a.playbackMs
              ? "Tiles at the times you asked for."
              : "Tiles at the opening, cuts (with the frame before each), zoom midpoints, layout and mask starts, pacing issues and the ending.",
            ...s.notes,
          ],
        },
      };
    },
  );
}
