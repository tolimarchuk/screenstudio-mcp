import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Context } from "../context.js";
import { DESTRUCTIVE, READ, WRITE, path, toolsOn } from "../tool.js";
import { APP_BUILD, capabilities } from "../../studio/compat.js";
import { dependencies } from "../../studio/doctor.js";
import { configFields } from "../../studio/project.js";
import { ASPECTS, LOOKS, STYLES } from "../../studio/styles.js";
import { MUSIC, VOICES } from "../../studio/narration.js";
import { catalog } from "../../studio/assets.js";
import { LAYOUT_TYPES, MASK_TYPES, editOp } from "../../studio/editor/ops.js";
import { recipeList } from "../../studio/recipes.js";
import { listBrands } from "../../studio/brand.js";

const ops = new Set<string>(editOp.options.map((o) => o.shape.op.value));

/** What this server can do, read from its own tools and ops so status never undersells it. */
export const features = {
  ...capabilities.features,
  maskEditing: ops.has("addMask"),
  layoutTimelineEditing: ops.has("addLayout"),
  narration: true,
  musicLibrary: true,
};

/** Every string in the presets listing, so an apply can only name a preset the app knows. */
export function presetPaths(listing: unknown, out = new Set<string>()): Set<string> {
  if (typeof listing === "string") out.add(listing);
  else if (listing && typeof listing === "object")
    for (const [k, v] of Object.entries(listing)) {
      if (!Array.isArray(listing)) out.add(k);
      presetPaths(v, out);
    }
  return out;
}

export function register(server: McpServer, { studio, editor }: Context) {
  const tool = toolsOn(server);

  tool(
    "screenstudio_status",
    "Start here. Connection, app version (and whether it is the tested build), open editor windows, recording state, ffmpeg / edge-tts / input helper and the Accessibility and Screen Recording permissions, supported features, the named recipes and the saved brand kits. Works when the app is closed.",
    {},
    READ,
    async () => {
      const out: any = {
        ...capabilities,
        features,
        knownSettings: Object.keys(configFields),
        styles: STYLES,
        looks: Object.keys(LOOKS),
        aspects: Object.keys(ASPECTS),
        music: MUSIC,
        recipes: recipeList(),
        brands: await listBrands(studio.stateDir).then(
          (list) => list.map((b) => b.slug),
          () => [],
        ),
        dependencies: await dependencies(),
      };
      try {
        out.version = await studio.requireVersion("read");
        out.tested = out.version === APP_BUILD;
        out.connected = true;
        out.port = await studio.port();
        out.editors = await editor.list();
        out.recording = await studio.state();
      } catch (e) {
        out.connected = false;
        out.connection = e instanceof Error ? e.message : String(e);
      }
      return out;
    },
  );

  tool(
    "screenstudio_launch",
    "Launch Screen Studio with a local automation connection (bound to 127.0.0.1). A running app is never killed or restarted.",
    {},
    WRITE,
    () => studio.launch(),
  );

  tool(
    "screenstudio_quit",
    "Quit Screen Studio like Cmd+Q when the work is done, which also closes the local automation connection. The app asks about unsaved changes itself; refuses while recording.",
    {},
    DESTRUCTIVE,
    () => studio.quit(),
  );

  tool(
    "screenstudio_presets",
    "List the person's saved Screen Studio presets, or apply one to a project file (the app's own preset apply). Apply to a project that is not open in the editor: an open editor keeps its old settings and its next save writes them back over the preset.",
    { action: z.enum(["list", "apply"]), presetPath: z.string().optional(), projectPath: path.optional() },
    DESTRUCTIVE,
    async (a) => {
      await studio.requireVersion();
      const listing = await studio.call("query", "presets.all");
      if (a.action === "list") return listing;
      if (!a.presetPath || !a.projectPath) throw new Error("apply needs presetPath and projectPath.");
      if (!presetPaths(listing).has(a.presetPath))
        throw new Error("Unknown preset. Use a presetPath from the presets list.");
      const projectPath = await studio.path(a.projectPath);
      const open = (await editor.list()).some((e) => e.projectPath === projectPath);
      const result = await studio.call("mutation", "presets.apply", {
        presetPath: a.presetPath,
        projectPath,
      });
      if (!open) return result;
      return {
        result,
        warning:
          "The project is open in the editor, which still shows its old settings. Its next save (screenstudio_editor_apply saves by default, screenstudio_editor_save) writes them back over the preset. Close that editor window, then screenstudio_editor_open the project to load the preset.",
      };
    },
  );

  tool(
    "screenstudio_catalog",
    "Everything Screen Studio ships that settings can point to: wallpapers (styles.background.systemName), cursor sets (cursor.set.id), device frames (device.frameKey), music tracks, narration voices, camera layout types, mask types, looks and output aspects.",
    {},
    READ,
    async () => ({
      ...(await catalog(studio.appPath)),
      voices: VOICES,
      layoutTypes: LAYOUT_TYPES,
      maskTypes: MASK_TYPES,
      looks: LOOKS,
      aspects: Object.keys(ASPECTS),
    }),
  );
}
