import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Context } from "../context.js";
import { DESTRUCTIVE, READ, WRITE, id, toolsOn } from "../tool.js";

export function register(server: McpServer, { studio }: Context) {
  const tool = toolsOn(server);

  tool(
    "screenstudio_sources",
    "List capturable windows, display IDs, microphones and cameras.",
    {},
    READ,
    () => studio.sources(),
  );

  tool("screenstudio_record_state", "Inspect the current recording session. Null means idle.", {}, READ, () =>
    studio.state(),
  );

  tool(
    "screenstudio_record_start",
    "Start recording one exact window, a display, or an area of a display (displayId plus area in display points). Audio and camera default off. Rehearse first; record each beat with screenstudio_desktop_perform.",
    {
      windowId: id.optional(),
      displayId: id.optional(),
      area: z
        .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
        .strict()
        .optional(),
      name: z.string().min(1).max(100),
      microphoneDeviceId: z.string().optional(),
      cameraDeviceId: z.string().optional(),
      systemAudio: z.boolean().optional(),
    },
    WRITE,
    (a) => {
      if (a.area && a.windowId !== undefined)
        throw new Error("area needs displayId: it is a region of a display, not of a window.");
      return studio.start(a);
    },
  );

  tool(
    "screenstudio_record_control",
    "Pause, resume, add a marker, restart (discard and record again), cancel (discard), or finish and return the saved project. Idle time between beats is cut later by the edit plan, so pausing for short thinking is unnecessary.",
    { action: z.enum(["pause", "resume", "addMarker", "finish", "restart", "cancel"]) },
    DESTRUCTIVE,
    (a) => studio.recordingAction(a.action),
  );
}
