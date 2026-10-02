import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Context } from "../context.js";
import { DESTRUCTIVE, path, toolsOn } from "../tool.js";
import { configPartial } from "../../studio/editor/ops.js";
import { applyPartial } from "../../studio/deliver.js";
import { catalog } from "../../studio/assets.js";
import {
  brandInput,
  brandSlug,
  compileBrand,
  deleteBrand,
  listBrands,
  readBrand,
  saveBrand,
  type Brand,
} from "../../studio/brand.js";

/** The config groups a Screen Studio preset carries. */
const PRESET_GROUPS = [
  "cursor",
  "captions",
  "audio",
  "camera",
  "animations",
  "processing",
  "zooms",
  "defaultLayout",
  "device",
  "output",
  "styles",
];

export function register(server: McpServer, ctx: Context) {
  const { studio, editor } = ctx;
  const tool = toolsOn(server);
  const cursorSets = () =>
    catalog(studio.appPath).then(
      (c) => c.cursorSets,
      () => undefined,
    );
  /** What the brand carries that a config op cannot: the voice and music for narration. */
  const audioNote = (b: Brand) =>
    b.voice || b.music
      ? [
          `For narration in this brand, pass ${[b.voice && `voice ${b.voice}`, b.music && `music ${b.music}`].filter(Boolean).join(" and ")} to screenstudio_narrate.`,
        ]
      : [];

  tool(
    "screenstudio_brand",
    "Save a client's brand once and apply it to any project as one live, undoable config op. A brand holds colours (primary, optional secondary and text), a backdrop (gradient from primary to secondary, flat colour, or the backdrop of a starting look), caption colours and font, cursor set and size, click sound, corner radius, shadow, padding, and the narration voice and music. Applying checks caption contrast (WCAG 4.5:1) and picks a readable caption box when the brand's is not, and checks the cursor set against the app. Actions: save (brand; replaces a saved brand of the same name and says so), list (unreadable brands are listed with their error), show (name), delete (name; removes it for good, even when it no longer reads), apply (name, projectPath; shows each setting changing in the open editor unless show is false), toPreset (name, projectPath; asks the app to save the project's settings with the brand laid over them as a Screen Studio preset, and says so when this build cannot). Image backdrops are not supported yet. Returns the settings it changed and why.",
    {
      action: z.enum(["save", "list", "show", "delete", "apply", "toPreset"]),
      name: z.string().min(1).max(40).optional(),
      brand: brandInput.optional(),
      projectPath: path.optional(),
      show: z.boolean().default(true),
      stepMs: z.number().int().min(80).max(2000).default(350),
      save: z.boolean().default(true),
    },
    DESTRUCTIVE,
    async (a) => {
      if (a.action === "list") return { brands: await listBrands(studio.stateDir) };
      if (a.action === "save") {
        if (!a.brand) throw new Error("save needs brand.");
        if (a.name && brandSlug(a.name) !== brandSlug(a.brand.name))
          throw new Error(
            `name ${a.name} and brand.name ${a.brand.name} differ; a brand is saved under brand.name. Pass one name.`,
          );
        const compiled = compileBrand(a.brand, { cursorSets: await cursorSets() });
        const saved = await saveBrand(studio.stateDir, a.brand);
        return {
          saved: saved.slug,
          replaced: saved.replaced,
          brand: saved.brand,
          settings: compiled.changes,
          notes: [
            ...(saved.replaced ? [`Replaced the brand saved as ${saved.slug}.`] : []),
            ...compiled.notes,
          ],
        };
      }
      if (!a.name) throw new Error(`${a.action} needs name.`);
      if (a.action === "delete") return deleteBrand(studio.stateDir, a.name);
      const brand = await readBrand(studio.stateDir, a.name);
      if (a.action === "show") {
        const compiled = compileBrand(brand, { cursorSets: await cursorSets() });
        return { brand, settings: compiled.changes, notes: [...compiled.notes, ...audioNote(brand)] };
      }
      if (!a.projectPath) throw new Error(`${a.action} needs projectPath.`);
      if (a.action === "toPreset") {
        const t = await ctx.timeline(a.projectPath);
        const { changes, notes } = compileBrand(brand, {
          cursorSets: await cursorSets(),
          config: t.project.config,
        });
        const config = applyPartial(
          structuredClone(t.project.config),
          configPartial(t.project.config, changes),
        );
        const presetConfig = Object.fromEntries(
          PRESET_GROUPS.filter((g) => g in config).map((g) => [g, config[g]]),
        );
        try {
          const result = await studio.call("mutation", "presets.createFromConfig", {
            name: brand.name,
            config: presetConfig,
          });
          return {
            preset: brand.name,
            result,
            notes: [
              ...notes,
              `Saved as the Screen Studio preset ${brand.name}; screenstudio_presets lists it.`,
            ],
          };
        } catch (e) {
          // Only a missing procedure means this build cannot save presets; anything else is a real error.
          if (!/no (such )?(procedure|mutation)|not found/i.test(e instanceof Error ? e.message : String(e)))
            throw e;
          return {
            preset: null,
            notes: [
              ...notes,
              `Saving a preset is not available in this build (${e instanceof Error ? e.message : String(e)}). Use apply instead; it sets the same settings as one undoable step.`,
            ],
          };
        }
      }
      const t = await ctx.timeline(a.projectPath);
      const { changes, notes } = compileBrand(brand, {
        cursorSets: await cursorSets(),
        config: t.project.config,
      });
      const applied = await editor.apply(
        t.projectPath,
        undefined,
        [{ op: "config", changes }],
        a.show ? { stepMs: a.stepMs } : undefined,
        { save: a.save },
      );
      const partial = "partial" in applied;
      return {
        brand: brand.name,
        changed: Object.keys(changes),
        checkpointId: applied.checkpointId,
        ...(partial ? { partial: true, error: applied.error } : {}),
        notes: [
          ...notes,
          ...audioNote(brand),
          "Undo in the app (Cmd+Z), screenstudio_editor_history, or screenstudio_editor_restore with the checkpointId.",
        ],
      };
    },
  );
}
