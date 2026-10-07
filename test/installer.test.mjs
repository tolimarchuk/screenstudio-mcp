// The installer puts one skill where Claude Code and Codex read skills, and
// removes the old record, edit and deliver skills, but only folders it made.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LEGACY_SKILLS, MARKER, installSkills, removeSkills, skillNames } from "../dist/cli/skills.js";

const run = promisify(execFile);
const root = process.cwd();
const scratch = () => mkdtemp(join(tmpdir(), "screenstudio-installer-"));

/** A skill folder an earlier installer copied: it carries the marker. */
async function installedCopy(dir, name) {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
  await writeFile(join(dir, name, MARKER), "0.5.4\n");
}

/** A folder the person made themselves: no marker. */
async function ownFolder(dir, name) {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), "mine\n");
}

/** A screenstudio-mcp checkout with its own old skill folders. */
async function checkout(base) {
  const repo = join(base, "screenstudio-mcp");
  await mkdir(join(repo, "skills"), { recursive: true });
  await writeFile(join(repo, "package.json"), JSON.stringify({ name: "screenstudio-mcp" }));
  for (const name of LEGACY_SKILLS) await ownFolder(join(repo, "skills"), name);
  return repo;
}

test("the package ships one skill, named screenstudio, with its stage references", async () => {
  assert.deepEqual(await skillNames(root), ["screenstudio"]);
  const refs = await readdir(join(root, "skills/screenstudio/references"));
  for (const stage of ["record.md", "edit.md", "deliver.md"]) assert.ok(refs.includes(stage), stage);
  const skill = await readFile(join(root, "skills/screenstudio/SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: screenstudio\ndescription: .+\n---\n/);
  assert.ok(skill.match(/^description: (.+)$/m)[1].length <= 600, "the description stays short");
  assert.ok(Buffer.byteLength(skill) <= 8192, "the skill body stays under 8 KB");
});

test("install copies the skill with its marker and replaces only its own copy", async () => {
  const dir = join(await scratch(), "skills");
  let result = await installSkills(root, dir, { version: "9.9.9" });
  assert.deepEqual(result, { installed: ["screenstudio"], kept: [] });
  assert.equal(await readFile(join(dir, "screenstudio", MARKER), "utf8"), "9.9.9\n");
  assert.ok(existsSync(join(dir, "screenstudio/references/edit.md")));

  result = await installSkills(root, dir, { version: "9.9.10" });
  assert.deepEqual(result.installed, ["screenstudio"]);
  assert.equal(await readFile(join(dir, "screenstudio", MARKER), "utf8"), "9.9.10\n");

  await rm(join(dir, "screenstudio"), { recursive: true });
  await ownFolder(dir, "screenstudio");
  result = await installSkills(root, dir, { version: "9.9.11" });
  assert.deepEqual(result, { installed: [], kept: [join(dir, "screenstudio")] });
  assert.equal(await readFile(join(dir, "screenstudio/SKILL.md"), "utf8"), "mine\n");

  result = await installSkills(root, dir, { version: "9.9.11", force: true });
  assert.deepEqual(result.installed, ["screenstudio"]);
  assert.ok(existsSync(join(dir, "screenstudio", MARKER)));
});

test("old skills go only when the installer made them", async () => {
  const base = await scratch();
  const dir = join(base, "skills");
  await installedCopy(dir, "screenstudio-record");
  await ownFolder(dir, "screenstudio-edit");
  const { removed, kept } = await removeSkills(dir, LEGACY_SKILLS);
  assert.deepEqual(removed, ["screenstudio-record"]);
  assert.deepEqual(kept, [join(dir, "screenstudio-edit")]);
  assert.ok(!existsSync(join(dir, "screenstudio-record")));
  assert.equal(await readFile(join(dir, "screenstudio-edit/SKILL.md"), "utf8"), "mine\n");
});

test("a symlink to a screenstudio-mcp checkout's own skill counts as the installer's", async () => {
  const base = await scratch();
  const repo = await checkout(base);
  const elsewhere = join(base, "elsewhere");
  await ownFolder(elsewhere, "screenstudio-deliver");
  const dir = join(base, "skills");
  await mkdir(dir);
  await symlink(join(repo, "skills/screenstudio-record"), join(dir, "screenstudio-record"));
  // Relative, and pointing at a folder the checkout no longer has.
  await rm(join(repo, "skills/screenstudio-edit"), { recursive: true });
  await symlink("../screenstudio-mcp/skills/screenstudio-edit", join(dir, "screenstudio-edit"));
  await symlink(join(elsewhere, "screenstudio-deliver"), join(dir, "screenstudio-deliver"));

  const { removed, kept } = await removeSkills(dir, LEGACY_SKILLS);
  assert.deepEqual(removed, ["screenstudio-record", "screenstudio-edit"]);
  assert.deepEqual(kept, [join(dir, "screenstudio-deliver")]);
  // Only the links went; what they pointed to is untouched.
  assert.ok(existsSync(join(repo, "skills/screenstudio-record/SKILL.md")));
  assert.ok(existsSync(join(elsewhere, "screenstudio-deliver/SKILL.md")));
  assert.ok((await lstat(join(dir, "screenstudio-deliver"))).isSymbolicLink());
});

test("a symlink to the plugin mirror or to an installed copy is the installer's too", async () => {
  const base = await scratch();
  const repo = await checkout(base);
  const mirror = join(repo, "plugins/screenstudio/skills");
  await cp(join(repo, "skills"), mirror, { recursive: true });
  const claude = join(base, "claude/skills");
  await installedCopy(claude, "screenstudio-deliver");
  const dir = join(base, "skills");
  await mkdir(dir);
  await symlink(join(mirror, "screenstudio-record"), join(dir, "screenstudio-record"));
  await symlink(join(claude, "screenstudio-deliver"), join(dir, "screenstudio-deliver"));
  assert.deepEqual((await removeSkills(dir, LEGACY_SKILLS)).removed, [
    "screenstudio-record",
    "screenstudio-deliver",
  ]);
  assert.ok(existsSync(join(claude, "screenstudio-deliver", MARKER)));
});

test("a symlink into another package's skills folder is the person's", async () => {
  const base = await scratch();
  const other = join(base, "other");
  await mkdir(join(other, "skills"), { recursive: true });
  await writeFile(join(other, "package.json"), JSON.stringify({ name: "someone-else" }));
  await ownFolder(join(other, "skills"), "screenstudio-record");
  const dir = join(base, "skills");
  await mkdir(dir);
  await symlink(join(other, "skills/screenstudio-record"), join(dir, "screenstudio-record"));
  assert.deepEqual(await removeSkills(dir, LEGACY_SKILLS), {
    removed: [],
    kept: [join(dir, "screenstudio-record")],
  });
});

test("uninstall removes the new and old skills from every location, and keeps the person's own", async () => {
  const base = await scratch();
  const claude = join(base, "claude");
  const codex = join(base, "codex");
  const agents = join(base, "agents");
  for (const home of [claude, codex, agents]) {
    await installedCopy(join(home, "skills"), "screenstudio");
    for (const name of LEGACY_SKILLS) await installedCopy(join(home, "skills"), name);
    await ownFolder(join(home, "skills"), "unrelated");
  }
  await rm(join(agents, "skills/screenstudio-edit"), { recursive: true });
  await ownFolder(join(agents, "skills"), "screenstudio-edit");
  await writeFile(join(codex, "config.toml"), '[mcp_servers.screenstudio]\ncommand = "npx"\n');

  await run(
    process.execPath,
    [
      "dist/cli/main.js",
      "uninstall",
      "--claude-home",
      claude,
      "--codex-home",
      codex,
      "--agents-home",
      agents,
    ],
    { cwd: root },
  );
  assert.deepEqual(await readdir(join(claude, "skills")), ["unrelated"]);
  assert.deepEqual(await readdir(join(codex, "skills")), ["unrelated"]);
  assert.deepEqual((await readdir(join(agents, "skills"))).sort(), ["screenstudio-edit", "unrelated"]);
  assert.doesNotMatch(await readFile(join(codex, "config.toml"), "utf8"), /mcp_servers\.screenstudio/);
});
