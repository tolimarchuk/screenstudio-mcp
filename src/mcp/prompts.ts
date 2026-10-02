import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RECIPE_NAMES } from "../studio/recipes.js";
import { packageFile } from "./resources.js";

const userMessage = (text: string) => ({
  messages: [{ role: "user" as const, content: { type: "text" as const, text } }],
});

export function register(server: McpServer) {
  server.registerPrompt(
    "screenstudio_demo",
    {
      description: "Record a new video in Screen Studio, then edit and export it.",
      argsSchema: { goal: z.string(), target: z.string().optional() },
    },
    async ({ goal, target }) => {
      const skills = await Promise.all(
        ["record", "edit", "deliver"].map((name) => packageFile(`skills/screenstudio-${name}/SKILL.md`)),
      );
      return userMessage(
        `Make this walkthrough: ${goal}\nTarget: ${target ?? "identify the requested app"}\n\n${skills.join("\n\n")}\nRead the craft, pacing and narration resources before editing; read browser-demos before recording a website.`,
      );
    },
  );

  server.registerPrompt(
    "screenstudio_edit",
    {
      description: "Edit a video already in Screen Studio, following the user's direction.",
      argsSchema: { projectPath: z.string(), direction: z.string().optional() },
    },
    async ({ projectPath, direction }) => {
      const skill = await packageFile("skills/screenstudio-edit/SKILL.md");
      return userMessage(
        `Edit ${projectPath}.${direction ? ` Direction: ${direction}` : ""}\n\n${skill}\nRead the craft, pacing and narration resources before editing. Optional recipe presets (none is applied unless named): ${RECIPE_NAMES.join(", ")}.`,
      );
    },
  );
}
