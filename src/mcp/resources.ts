// Guidance agents read before recording and editing, served from the package's markdown.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";

/** Resource name to markdown file, relative to the package root. */
export const RESOURCES = {
  craft: "skills/screenstudio-edit/references/craft.md",
  coverage: "docs/coverage.md",
  narration: "skills/screenstudio-edit/references/narration.md",
  "browser-demos": "skills/screenstudio-record/references/browser-demos.md",
  pacing: "skills/screenstudio-edit/references/pacing.md",
  workflow: "docs/agent-workflow.md",
  compatibility: "docs/compatibility.md",
  recovery: "skills/screenstudio-record/references/recovery.md",
  recipes: "skills/screenstudio-edit/references/recipes.md",
  story: "skills/screenstudio-edit/references/story.md",
  variants: "skills/screenstudio-deliver/references/variants.md",
  loops: "skills/screenstudio-deliver/references/loops.md",
  brand: "skills/screenstudio-edit/references/brand.md",
  privacy: "skills/screenstudio-edit/references/privacy.md",
};

/** Reads a file shipped with the package. */
export const packageFile = (relative: string) =>
  readFile(new URL(`../../${relative}`, import.meta.url), "utf8");

export function register(server: McpServer) {
  for (const [name, relative] of Object.entries(RESOURCES)) {
    const uri = `screenstudio://${name}`;
    server.registerResource(
      name,
      uri,
      { description: `Screen Studio ${name} guidance`, mimeType: "text/markdown" },
      async () => ({ contents: [{ uri, mimeType: "text/markdown", text: await packageFile(relative) }] }),
    );
  }
}
