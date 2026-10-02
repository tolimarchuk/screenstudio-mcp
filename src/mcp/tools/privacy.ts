import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Context } from "../context.js";
import { WRITE, image, path, toolsOn } from "../tool.js";
import {
  SENSITIVE_KINDS,
  contactSheet,
  maskOps,
  maskRects,
  previewFrames,
  previewMarks,
  removeDir,
  scanNotes,
  scanRecording,
  withPreview,
} from "../../studio/redact.js";

export function register(server: McpServer, ctx: Context) {
  const { studio, editor } = ctx;
  const tool = toolsOn(server);

  tool(
    "screenstudio_find_sensitive",
    `Find private text in the footage before publishing and propose blur masks for it. Reads frames (every everyMs plus just before and after each screen change) with macOS text recognition and looks for emails, phone numbers (including +E.164 and labelled digits), API keys and tokens (sk-, ghp_, xox, AKIA, AWS secret keys, Stripe, Google, private key headers), JSON web tokens, hex keys and hashes (32+ hex digits with letters; digit-only IDs such as post IDs in links, and IDs run into hex at either end, are not flagged), long random strings, card numbers (Luhn checked), IP addresses, links carrying tokens (with or without https://), passwords and secrets in settings, .env lines and connection strings, and any extraTerms (plain words, or /regex/flags; a term inside a longer secret widens the blur to the whole secret). Long recordings are read end to end: the frame grid widens to fit maxFrames. Each finding is followed across frames into one span with a padded box (0-1 of the capture). Returns detections with a masked preview (never the full value), a preview sheet of up to six frames that show the findings (each at least 960px wide, every blur filled red, existing blur masks included, every finding seen there ringed in yellow and numbered, with its kind and masked value listed under the frame), notes explaining the choices, and addMask sensitive-data ops for screenstudio_editor_apply. With apply: true the masks are added live in the open editor (undoable, then saved). An existing blur mask grows to cover new findings; a highlight or disabled mask blocks a blur, and the notes say where. ignore drops kinds that are expected on screen (${SENSITIVE_KINDS.join(", ")}).`,
    {
      projectPath: path,
      everyMs: z.number().int().min(250).max(10000).default(1000),
      extraTerms: z.array(z.string().min(1).max(200)).max(50).optional(),
      ignore: z.array(z.enum(SENSITIVE_KINDS)).max(SENSITIVE_KINDS.length).optional(),
      maxFrames: z.number().int().min(10).max(1000).default(400),
      apply: z.boolean().default(false),
    },
    WRITE,
    async (a) => {
      const analysis = await ctx.analysisFor(a.projectPath);
      const dir = await studio.statePath(`redact-${randomUUID()}`);
      try {
        const scan = await scanRecording(analysis, dir, {
          everyMs: a.everyMs,
          extraTerms: a.extraTerms,
          ignore: a.ignore,
          maxFrames: a.maxFrames,
        });
        // Mask items cannot overlap, so time an existing mask holds is left to it.
        const current = await ctx.timeline(a.projectPath).catch(() => null);
        const existing = (current?.scene.masks ?? []).map((m: any) => ({
          id: m.id,
          startMs: m.sourceStartMs,
          endMs: m.sourceEndMs,
          type: typeof m.type === "string" ? m.type : undefined,
          disabled: !!m.isDisabled,
          rects: maskRects(m.bounds, analysis.capture),
        }));
        const { ops, skipped } = maskOps(scan.detections, { existing });

        let applied:
          { partial?: boolean; failedAt?: number; checkpointId?: string; error?: string } | undefined;
        if (a.apply && ops.length) {
          // A finished scan is never thrown away because the masks could not be applied.
          applied = (await editor
            .apply(a.projectPath, undefined, ops, { stepMs: 350 }, { save: true })
            .catch((e) => ({
              partial: true,
              error: e instanceof Error ? e.message : String(e),
            }))) as typeof applied;
        }
        const notes = scanNotes({
          everyMs: a.everyMs,
          stepMs: scan.stepMs,
          frames: scan.times.length,
          changes: analysis.screen.changes.length,
          textLines: scan.textLines,
          detections: scan.detections,
          ops,
          skipped,
          applied: !applied ? "none" : applied.partial ? "partial" : "applied",
          landed: applied?.partial && typeof applied.failedAt === "number" ? applied.failedAt : undefined,
          checkpointId: applied?.checkpointId,
          capped: scan.capped,
        });
        const result = { detections: scan.detections, ops, notes, ...(applied ? { applied } : {}) };
        if (!scan.detections.length) return result;

        // Up to six frames that between them show every finding, each blur filled and each finding ringed and numbered.
        // The masks are already in the editor by now: a preview that fails must not lose that result.
        return await withPreview(result, async () => {
          const shown = previewFrames(scan.samples, scan.detections, 6);
          if (!shown.length) return result;
          const out = await studio.statePath(`sensitive-${randomUUID().slice(0, 8)}.png`);
          const frames = shown.map((i) => ({
            file: scan.files[i],
            atMs: scan.times[i],
            ...previewMarks(scan.times[i], scan.detections, ops, existing),
          }));
          const capture = analysis.capture;
          const sheet = await contactSheet(frames, out, {
            workDir: dir,
            frameRatio: capture?.widthPt && capture.heightPt ? capture.widthPt / capture.heightPt : undefined,
          });
          const times = shown.map((i) => scan.times[i]);
          const unseen = scan.detections.filter(
            (d) => !times.some((t) => d.firstSeenMs <= t && t <= d.lastSeenMs),
          ).length;
          const unknown = Math.max(0, ...frames.map((f) => f.unknown));
          const label = `Proposed blurs filled red${sheet.labelled ? ", each finding ringed in yellow and tagged with its number in detections; the time and each finding's kind and masked value are listed under its frame" : " and ringed in yellow"}, at ${times.map((t) => `${(t / 1000).toFixed(1)}s`).join(", ")} (left to right, top to bottom)${unseen ? `; ${unseen} more ${unseen === 1 ? "finding is" : "findings are"} listed in detections only` : ""}${unknown ? `; ${unknown === 1 ? "a blur mask already on the track has" : `${unknown} blur masks already on the track have`} no known area, so ${unknown === 1 ? "it is" : "they are"} not shown filled: check ${unknown === 1 ? "it" : "them"} in the editor` : ""}.`;
          return { images: [image(await readFile(out), label)], text: result };
        });
      } finally {
        await removeDir(dir);
      }
    },
  );
}
