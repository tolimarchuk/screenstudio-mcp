// Editing Codex's config.toml: only the screenstudio server table, nothing else.
const NAME = "screenstudio";
const tomlTable = `mcp_servers.${NAME}`;

/** Drops `[mcp_servers.screenstudio]` and its sub-tables from a config.toml. */
export function withoutTable(toml: string) {
  const out: string[] = [];
  let skipping = false;
  for (const line of toml.split("\n")) {
    const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
    if (header) skipping = header[1] === tomlTable || header[1].startsWith(`${tomlTable}.`);
    if (!skipping) out.push(line);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

export function codexBlock(cmd: { command: string; args: string[] }) {
  const q = (s: string) => JSON.stringify(s);
  return [
    `[${tomlTable}]`,
    `command = ${q(cmd.command)}`,
    `args = [${cmd.args.map(q).join(", ")}]`,
    "startup_timeout_sec = 60",
    "# Renders and transcription can take minutes.",
    "tool_timeout_sec = 1800",
  ].join("\n");
}
