import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RECIPE_NAMES } from "../studio/recipes.js";
import { packageFile, SKILL, STAGES } from "./resources.js";

/** The skill's text without its front matter, followed by the guides for the stages a prompt covers. */
async function guidance(stages: (keyof typeof STAGES)[]) {
  const skill = (await packageFile(SKILL)).replace(/^---\n[\s\S]*?\n---\n+/, "");
  const guides = await Promise.all(stages.map((stage) => packageFile(STAGES[stage])));
  return [skill, ...guides].join("\n\n");
}

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
      const text = await guidance(["record", "edit", "deliver"]);
      return userMessage(
        `Make this walkthrough: ${goal}\nTarget: ${target ?? "identify the requested app"}\n\n${text}\nRead the craft, pacing and narration resources before editing; read browser-demos before recording a website.`,
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
      const text = await guidance(["edit"]);
      return userMessage(
        `Edit ${projectPath}.${direction ? ` Direction: ${direction}` : ""}\n\n${text}\nRead the craft, pacing and narration resources before editing. Optional recipe presets (none is applied unless named): ${RECIPE_NAMES.join(", ")}.`,
      );
    },
  );
}
