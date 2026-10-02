import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pacingFor, type Context } from "../context.js";
import { READ, WRITE, image, path, toolsOn } from "../tool.js";
import { describeScene } from "../../studio/editor/describe.js";
import { SELECTABLE_TRACKS, editOp } from "../../studio/editor/ops.js";
import { RECIPE_NAMES } from "../../studio/recipes.js";
import { DEFAULT_STYLE, STYLE_NAMES } from "../../studio/styles.js";
import { recipeForCheck } from "./plan.js";

export function register(server: McpServer, ctx: Context) {
  const { editor } = ctx;
  const tool = toolsOn(server);

  tool("screenstudio_editor_list", "List projects open in Screen Studio editor windows.", {}, READ, () =>
    editor.list(),
  );

  tool(
    "screenstudio_editor_open",
    "Open a project in a Screen Studio editor window (or find it if already open) and return its timeline. The person can watch every edit happen there.",
    { projectPath: path },
    WRITE,
    (a) => editor.open(a.projectPath),
  );

  tool(
    "screenstudio_editor_state",
    "The open editor's live timeline (slices, zooms, camera layouts, masks in source and playback ms), playhead, undo state, a style summary and, with includeConfig, every project setting (crop, cursor, captions, audio, camera, animations, zooms, defaultLayout, styles, device, output). Any setting shown can be changed with a config op.",
    { projectPath: path, includeConfig: z.boolean().default(false) },
    READ,
    async (a) => {
      const st = await editor.state(a.projectPath);
      return a.includeConfig ? { ...st, config: (await editor.raw(a.projectPath)).config } : st;
    },
  );

  tool(
    "screenstudio_editor_apply",
    "Edit the open project live in the editor window. Ops run in order, all times in source ms: setSlices (full ordered list of kept ranges with speed, optional per-clip volume, hideCursor, disableSmoothMouseMovement), addZoom (manual by default: target x/y 0-1 in the cropped frame is required and Screen Studio places it at the middle of the area the camera leaves free, so check the frame; follow:true only when the pointer itself is the subject, like a drag; to move between spots add back-to-back zooms, the next starting where the last ends, never re-aim one; presentation 'loupe' for the glass loupe with optional loupe radius/bevel/chromaticAberration/glassOptics), updateZoom, removeZoom, clearZooms, addLayout (camera layout for a stretch: camera-overlay, cutout-camera, split-screen, fullscreen-camera, screen-only, with options), addMask (sensitive-data blur or highlight, rects 0-1), updateItem/removeItem/clearTrack (layouts, masks, zooms; updateItem on a mask takes fields.rects 0-1 like addMask, or fields.bounds in capture points as editor_state shows them), config (any dotted setting from editor_state includeConfig, e.g. crop.rect01, captions.position01, defaultLayout.type, camera.background.edgeFalloff01, styles.background.systemName, device.frameKey). Timeline ops also include splitAt, cutRange (split both ends and delete the middle), removeSlice, mergeSlices, updateSlice (speed, volume up to 1, system/device audio, hideCursor, disableSmoothMouseMovement), resetCuts, restoreAutoZooms (Screen Studio's own click zooms), duplicateItem, setTrackDisabled, and clearTrack/removeItem for voiceOvers. With show (default) every step plays out in the editor window wherever it is, without taking focus: the playhead jumps to each edit, the timeline is split and pieces deleted one by one, new zooms, layouts and masks drop in selected, and each setting changes with its sidebar panel open (stepMs per step, 350 by default; show:false applies instantly). Returns a checkpoint, the new timeline and a pacing and visual-settings check. Cmd+Z in the app also works. Saves after each apply unless save:false. If an op fails, the result has partial:true, failedAt and error; the ops before it stay applied, nothing is saved, and screenstudio_editor_restore with the checkpointId undoes the batch.",
    {
      projectPath: path,
      sceneId: z.string().optional(),
      ops: z.array(editOp).min(1).max(100),
      style: z.enum(STYLE_NAMES).optional().describe(`Default ${DEFAULT_STYLE}, or the recipe's.`),
      recipe: z
        .enum(RECIPE_NAMES)
        .optional()
        .describe("The recipe the plan followed, so the pacing check judges by its rules and look."),
      recipeOverrides: z.record(z.string(), z.unknown()).optional(),
      brand: z.string().min(1).max(40).optional(),
      show: z.boolean().default(true),
      stepMs: z.number().int().min(80).max(2000).default(350),
      save: z.boolean().default(true),
    },
    WRITE,
    async (a, extra) => {
      // Resolved before applying, so a wrong recipe or brand changes nothing.
      const { recipe } = await recipeForCheck(ctx, a);
      const applied = await editor.apply(
        a.projectPath,
        a.sceneId,
        a.ops,
        a.show ? { stepMs: a.stepMs } : undefined,
        { save: a.save, signal: extra.signal },
      );
      const partial = "partial" in applied;
      const t = await ctx.timeline(a.projectPath, a.sceneId);
      const style = a.style ?? recipe?.style ?? DEFAULT_STYLE;
      const pacing = pacingFor(
        t,
        ctx.cachedAnalysis(t.projectPath),
        style,
        recipe ? { rules: recipe.rules, recipe } : undefined,
      );
      const errors = pacing.issues.filter((i) => i.severity === "error");
      return {
        ...applied,
        pacing,
        timeline: describeScene(t.scene),
        notes: [
          partial
            ? "Stopped partway: the ops before the failure are live in the editor and nothing was saved. Fix the failing op and apply the rest, or undo the batch with screenstudio_editor_restore and the checkpointId."
            : `Applied ${a.ops.length} op${a.ops.length > 1 ? "s" : ""}${a.save ? " and saved" : "; not saved"}.`,
          `Pacing judged as ${style}${recipe ? ` with recipe ${recipe.name}'s rules and look` : ""}: ${pacing.verdict}${errors.length ? ` (${errors.map((i) => i.code).join(", ")})` : ""}.`,
        ],
      };
    },
  );

  tool(
    "screenstudio_editor_restore",
    "Put the editor back to the timeline and settings saved in an apply checkpoint.",
    { checkpointId: z.string().uuid() },
    WRITE,
    async (a) => editor.state(await editor.restore(a.checkpointId)),
  );

  tool(
    "screenstudio_editor_history",
    "Step the editor's own undo/redo history, like pressing Cmd+Z.",
    {
      projectPath: path,
      action: z.enum(["undo", "redo"]),
      steps: z.number().int().min(1).max(200).default(1),
    },
    WRITE,
    (a) => editor.history(a.projectPath, a.action, a.steps),
  );

  tool(
    "screenstudio_editor_view",
    "Drive the editor interface: open a sidebar panel (background, cursor, captions, transcript, shortcuts, audio, animation), select a timeline item (zooms, masks, layouts, slices by id), set the visible timeline span in ms, show or hide the sidebar and timeline, or switch to preview-only. Changes nothing in the project.",
    {
      projectPath: path,
      panel: z
        .enum(["background", "cursor", "captions", "transcript", "shortcuts", "audio", "animation"])
        .optional(),
      select: z
        .object({ track: z.enum(SELECTABLE_TRACKS), id: z.string().min(1) })
        .strict()
        .optional(),
      close: z.boolean().optional().describe("Close the selected item's sidebar panel."),
      timelineMs: z.number().min(1000).max(3600000).optional(),
      sidebar: z.boolean().optional(),
      timeline: z.boolean().optional(),
      previewOnly: z.boolean().optional(),
    },
    WRITE,
    (a) => editor.view(a.projectPath, a),
  );

  tool(
    "screenstudio_editor_save",
    "Save the open project exactly like Cmd+S in the editor.",
    { projectPath: path },
    WRITE,
    (a) => editor.save(a.projectPath),
  );

  tool(
    "screenstudio_editor_frame",
    "Capture the editor's rendered preview at playback times (up to 6) to check framing, zoom targets and legibility without exporting. The editor window must be on screen.",
    { projectPath: path, playbackMs: z.array(z.number().min(0)).min(1).max(6) },
    READ,
    async (a) => {
      const images = [];
      for (const f of await editor.frames(a.projectPath, a.playbackMs))
        images.push(image(f.data, `Editor preview at ${(f.playheadMs / 1000).toFixed(2)}s`));
      return { images };
    },
  );

  tool(
    "screenstudio_editor_seek",
    "Move the editor playhead to a playback or source time.",
    { projectPath: path, playbackMs: z.number().min(0).optional(), sourceMs: z.number().min(0).optional() },
    WRITE,
    (a) => {
      if ((a.playbackMs === undefined) === (a.sourceMs === undefined))
        throw new Error("Give exactly one of playbackMs or sourceMs.");
      return editor.seek(a.projectPath, a);
    },
  );

  tool(
    "screenstudio_editor_play",
    "Play a range in the editor window so the person can watch it.",
    { projectPath: path, fromMs: z.number().min(0).default(0), toMs: z.number().min(0).optional() },
    WRITE,
    (a) => editor.play(a.projectPath, a.fromMs, a.toMs),
  );
}
