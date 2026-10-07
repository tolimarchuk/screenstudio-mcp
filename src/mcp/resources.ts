// Guidance agents read before recording and editing, served from the package's markdown.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";

const REFERENCES = "skills/screenstudio/references";

/** The skill a client can install, and its stage guides that prompts paste in. */
export const SKILL = "skills/screenstudio/SKILL.md";
export const STAGES = {
  record: `${REFERENCES}/record.md`,
  edit: `${REFERENCES}/edit.md`,
  deliver: `${REFERENCES}/deliver.md`,
};

/** Resource name to markdown file, relative to the package root. */
export const RESOURCES = {
  ...STAGES,
  craft: `${REFERENCES}/craft.md`,
  coverage: "docs/coverage.md",
  narration: `${REFERENCES}/narration.md`,
  "browser-demos": `${REFERENCES}/browser-demos.md`,
  pacing: `${REFERENCES}/pacing.md`,
  workflow: "docs/agent-workflow.md",
  compatibility: "docs/compatibility.md",
  recovery: `${REFERENCES}/recovery.md`,
  recipes: `${REFERENCES}/recipes.md`,
  story: `${REFERENCES}/story.md`,
  variants: `${REFERENCES}/variants.md`,
  loops: `${REFERENCES}/loops.md`,
  brand: `${REFERENCES}/brand.md`,
  privacy: `${REFERENCES}/privacy.md`,
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
