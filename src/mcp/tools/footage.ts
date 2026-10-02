import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Context } from "../context.js";
import { READ, WRITE, image, path, toolsOn } from "../tool.js";
import { sessionAt } from "../../studio/recording.js";
import { frameAt } from "../../studio/media.js";

export function register(server: McpServer, ctx: Context) {
  const { studio } = ctx;
  const tool = toolsOn(server);

  tool(
    "screenstudio_project_duplicate",
    "Copy a project bundle to a fresh destination, to keep the original untouched.",
    { projectPath: path, destinationPath: path },
    WRITE,
    (a) => studio.duplicate(a.projectPath, a.destinationPath),
  );

  tool(
    "screenstudio_analyze",
    "Read what happens in the raw recording, in source ms: clicks and drags (0-1 frame coordinates), typing bursts, shortcuts, cursor travel, screen changes (page = whole view replaced), idle stretches, recording markers (one per beat when recorded with markers, mapped to source ms; a marker dropped while paused lands where recording resumed) and, with a microphone, the audio valley between each pair of sentences (where the plan may cut when the transcript shows no pause). Typed text is omitted unless includeText is true.",
    { projectPath: path, includeText: z.boolean().default(false) },
    READ,
    async (a) => {
      const r = await ctx.analysisFor(a.projectPath, a.includeText);
      return {
        ...r,
        sessions: r.sessions.map(({ video: _v, ...s }) => s),
        totals: {
          clicks: r.clicks.length,
          typingBursts: r.typing.length,
          shortcuts: r.shortcuts.length,
          pageChanges: r.screen.changes.filter((c) => c.kind === "page").length,
          idleMs: r.idle.reduce((n, i) => n + i.endMs - i.startMs, 0),
          markers: r.markers?.length ?? 0,
        },
      };
    },
  );

  tool(
    "screenstudio_source_frames",
    "See raw recording moments (source ms) before deciding what to keep or where to zoom. Up to 8 frames; clicks within 400ms are marked with a red box.",
    {
      projectPath: path,
      sourceMs: z.array(z.number().min(0)).min(1).max(8),
      width: z.number().int().min(320).max(1600).default(960),
    },
    READ,
    async (a) => {
      const r = await ctx.analysisFor(a.projectPath);
      const images = [];
      for (const t of a.sourceMs) {
        const { video, localMs } = sessionAt(r, t);
        const marks = r.clicks.filter((c) => Math.abs(c.atMs - t) <= 400);
        const vf = [
          `scale=${a.width}:-2`,
          ...marks.map((m) => `drawbox=x=${m.x}*iw-16:y=${m.y}*ih-16:w=32:h=32:color=red@0.9:t=4`),
        ].join(",");
        const out = await studio.statePath(`source-${randomUUID().slice(0, 8)}-${Math.round(t)}.png`);
        await frameAt(video, localMs / 1000, out, { vf, timeoutMs: 30000 });
        const clicks = marks.length ? ` — click at ${marks.map((m) => `(${m.x}, ${m.y})`).join(", ")}` : "";
        images.push(image(await readFile(out), `Source ${(t / 1000).toFixed(2)}s${clicks}`));
      }
      return { images };
    },
  );
}
