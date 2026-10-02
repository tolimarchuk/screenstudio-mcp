import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Context } from "../context.js";
import { DESKTOP_INPUT, READ, id, image, toolsOn } from "../tool.js";
import { HOLD, TOKEN_TTL_MS, desktopAction } from "../../studio/desktop.js";

const holds = (["click", "type", "key", "scroll"] as const).map((k) => `${k} ${HOLD[k] / 1000}s`).join(", ");

export function register(server: McpServer, { studio, desktop }: Context) {
  const tool = toolsOn(server);

  tool(
    "screenstudio_desktop_inspect",
    `Inspect an exact native window and get a ${TOKEN_TTL_MS / 1000}-second, single-use observation token.`,
    { windowId: id },
    READ,
    (a) => desktop.inspect(a.windowId),
  );

  tool(
    "screenstudio_desktop_screenshot",
    "Screenshot the target native window before deciding where to act. Scaled to width points wide (default 1280) so large windows stay readable and small.",
    { windowId: id, width: z.number().int().min(320).max(2560).default(1280) },
    READ,
    async (a) => {
      const v = await desktop.screenshot(a.windowId, studio.stateDir, a.width);
      return { images: [image(v.data, `Window ${a.windowId}`)], text: { path: v.path } };
    },
  );

  tool(
    "screenstudio_desktop_action",
    "One visible native step on an observed window: focus, move, click, doubleClick, drag, taps (a burst of count taps every intervalMs at one point), hold (press for ms, then release), type, key (with modifiers, e.g. {key:'k',modifiers:['command']}; keys follow the person's keyboard layout) or scroll (optional x/y to scroll there; otherwise the pointer stays if it is over the window or moves to its middle). Coordinates are window-local points including the title bar. Pointer glides at a human pace and settles before clicking. Input stops if the window loses focus, another window covers the point or the pointer is moved. Some apps (terminals, password managers, System Settings) are excluded unless SCREENSTUDIO_ALLOW_APPS names them. System shortcuts (command+space, command+tab, command+q) are not sent.",
    {
      observationToken: z.string().uuid(),
      action: desktopAction,
      pace: z.number().min(0.5).max(3).default(1),
    },
    DESKTOP_INPUT,
    (a, extra) => desktop.action(a.observationToken, a.action, a.pace, extra.signal),
  );

  tool(
    "screenstudio_desktop_perform",
    `Perform a whole beat in one take while recording: up to 12 steps, each followed by a hold so its result is visible (defaults: ${holds}). One continuous take gives natural pacing; pace 1.3 is calmer. markers:true adds a recording marker before the first step, so screenstudio_analyze and screenstudio_narrate (pinToMarkers) know where the beat starts. minDurationMs stretches the last hold so the beat lasts at least that long (a narration line's durationMs from screenstudio_voice_lines plus about 400ms).`,
    {
      observationToken: z.string().uuid(),
      steps: z
        .array(
          z.object({ action: desktopAction, holdMs: z.number().int().min(0).max(8000).optional() }).strict(),
        )
        .min(1)
        .max(12),
      pace: z.number().min(0.5).max(3).default(1),
      markers: z.boolean().default(false),
      minDurationMs: z.number().int().min(0).max(60000).optional(),
    },
    DESKTOP_INPUT,
    (a, extra) =>
      desktop.perform(a.observationToken, a.steps, a.pace, {
        onBeatStart: a.markers ? () => studio.recordingAction("addMarker") : undefined,
        minDurationMs: a.minDurationMs,
        signal: extra.signal,
      }),
  );
}
