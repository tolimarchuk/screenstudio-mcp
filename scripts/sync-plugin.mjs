// Mirrors skills/ into the plugin folder that Claude Code and Codex install from.
// `node scripts/sync-plugin.mjs` writes it; `--check` exits non-zero when it is stale.
import { cp, readFile, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = join(root, "skills");
const mirror = join(root, "plugins/screenstudio/skills");

async function files(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else out.push(p);
  }
  return out;
}

if (process.argv.includes("--check")) {
  const a = (await files(source)).map((f) => relative(source, f)).sort();
  const b = (await files(mirror)).map((f) => relative(mirror, f)).sort();
  let same = a.join("\n") === b.join("\n");
  for (const f of same ? a : []) {
    if ((await readFile(join(source, f), "utf8")) !== (await readFile(join(mirror, f), "utf8"))) same = false;
  }
  if (!same) {
    console.error("plugins/screenstudio/skills is out of date: run npm run sync:plugin");
    process.exit(1);
  }
} else {
  await rm(mirror, { recursive: true, force: true });
  await cp(source, mirror, { recursive: true });
  console.log("synced plugins/screenstudio/skills");
}
