import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Context } from "../context.js";
import { READ, WRITE, image, path, progressOf, toolsOn } from "../tool.js";
import { exportFrame } from "../../studio/deliver.js";

export function register(server: McpServer, ctx: Context) {
  const { studio, editor } = ctx;
  const tool = toolsOn(server);

  tool(
    "screenstudio_export_start",
    "Render what the editor shows (including unsaved edits) to a local MP4 or GIF without a save dialog. height is the frame's short side, like every target and recipe: 1080 renders 1920x1080 at 16:9, 1080x1920 at 9:16 and 1080x1350 at 4:5 (a portrait frame asks Screen Studio for its full height). Waits for the render and returns the delivered file (wait:false returns the job right away to poll with screenstudio_export_status). Results say whether the render came from the live editor or the saved project (source live/disk). Existing files are never overwritten: a taken or unwritable output ends with status delivery_failed and the renderedPath. keepRender keeps the app's temporary QA copy.",
    {
      projectPath: path,
      outputPath: path,
      height: z
        .number()
        .int()
        .min(240)
        .max(2160)
        .default(1080)
        .describe("The frame's short side: 1080 is 1920x1080 at 16:9 and 1080x1920 at 9:16."),
      fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).default(60),
      format: z.enum(["mp4", "gif"]).default("mp4"),
      quality: z.enum(["studio"]).default("studio"),
      keepRender: z.boolean().default(false),
      wait: z.boolean().default(true),
    },
    WRITE,
    async (a, extra) => {
      // Screen Studio reads its export height as the frame's real height, so a portrait frame asks for its long side.
      const t = await ctx.timeline(a.projectPath);
      const { height, frame, note } = await exportFrame(
        t.projectPath,
        t.project.config,
        a.height,
        ctx.cachedAnalysis(t.projectPath)?.capture,
      );
      const started = await studio.exportStart(a.projectPath, a.outputPath, { ...a, height }, (p) =>
        editor.liveProject(p),
      );
      // Waiting here means an agent never ends its turn with the file still undelivered.
      const progress = progressOf(extra);
      let n = 0;
      const job = a.wait
        ? await studio.waitForExport(started.jobId, {
            timeoutMs: 30 * 60000,
            signal: extra.signal,
            onPoll: () => progress(++n, 0, "Rendering in Screen Studio"),
          })
        : started;
      return note ? { ...job, ...(frame ? { frame } : {}), note } : job;
    },
  );

  tool(
    "screenstudio_export_status",
    "Inspect an export job; when complete, returns the delivered file with encoded media properties.",
    { jobId: z.string().uuid() },
    WRITE,
    (a) => studio.exportStatus(a.jobId),
  );

  tool(
    "screenstudio_export_cancel",
    "Cancel a known export job without deleting the source project.",
    { jobId: z.string().uuid() },
    WRITE,
    (a) => studio.exportCancel(a.jobId),
  );

  tool(
    "screenstudio_export_frame",
    "A frame of the completed render at playback milliseconds.",
    { jobId: z.string().uuid(), timeMs: z.number().finite().min(0) },
    READ,
    async (a) => {
      const v = await studio.preview(a.jobId, a.timeMs);
      return {
        images: [image(v.data, `Render at ${(a.timeMs / 1000).toFixed(2)}s`)],
        text: { path: v.path },
      };
    },
  );
}
