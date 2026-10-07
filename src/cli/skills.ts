// Copying the skill into agent skill folders, and removing what earlier
// versions put there. Only folders this installer made are ever replaced or removed.
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, readlink, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** Written into every skill folder the installer copies, so it can tell its own folders from the person's. */
export const MARKER = ".screenstudio-mcp";

/** The record, edit and deliver skills that versions up to 0.5 installed; one `screenstudio` skill replaced them. */
export const LEGACY_SKILLS = ["screenstudio-record", "screenstudio-edit", "screenstudio-deliver"];

const PACKAGE = "screenstudio-mcp";

/** The skill folders a package ships in `<root>/skills`. */
export async function skillNames(root: string) {
  return (await readdir(join(root, "skills"), { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/**
 * A symlink to a skill folder inside a screenstudio-mcp checkout or package
 * (`<package>/skills/<name>` or its plugin mirror), even one whose folder has
 * since been removed. That is how a developer links the skills by hand.
 */
async function linksToPackageSkill(link: string, names: string[]) {
  const target = resolve(dirname(link), await readlink(link));
  const skills = dirname(target);
  if (basename(skills) !== "skills" || !names.includes(basename(target))) return false;
  let pkg = dirname(skills);
  if (basename(pkg) === "screenstudio" && basename(dirname(pkg)) === "plugins") pkg = dirname(dirname(pkg));
  const manifest = await readFile(join(pkg, "package.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  return manifest?.name === PACKAGE;
}

/**
 * Whether the installer made `dest`: a folder holding the marker (also when
 * reached through a symlink), or a symlink to one of the package's own skill
 * folders. `names` are the skill folder names the package has ever shipped.
 */
export async function isOurs(dest: string, names: string[]) {
  const stat = await lstat(dest).catch(() => null);
  if (!stat) return false;
  if (existsSync(join(dest, MARKER))) return true;
  return stat.isSymbolicLink() && linksToPackageSkill(dest, names);
}

/** Removes a skill folder; a symlink is unlinked and what it points to is left alone. */
async function remove(dest: string) {
  const stat = await lstat(dest).catch(() => null);
  if (stat?.isSymbolicLink()) await unlink(dest);
  else if (stat) await rm(dest, { recursive: true, force: true });
}

/**
 * Copies every skill in `<root>/skills` into `dir`, replacing only folders this
 * installer made (or any folder of the same name with `force`). Returns the
 * names installed and the paths kept because they belong to the person.
 */
export async function installSkills(
  root: string,
  dir: string,
  { version, force = false }: { version: string; force?: boolean },
) {
  const names = await skillNames(root);
  const installed: string[] = [];
  const kept: string[] = [];
  await mkdir(dir, { recursive: true });
  for (const name of names) {
    const dest = join(dir, name);
    const there = await lstat(dest).catch(() => null);
    if (there && !force && !(await isOurs(dest, [...names, ...LEGACY_SKILLS]))) {
      kept.push(dest);
      continue;
    }
    await remove(dest);
    await cp(join(root, "skills", name), dest, { recursive: true });
    await writeFile(join(dest, MARKER), `${version}\n`);
    installed.push(name);
  }
  return { installed, kept };
}

/**
 * Removes the named skill folders from `dir` when this installer made them.
 * Returns the names removed and the paths kept because they belong to the person.
 */
export async function removeSkills(dir: string, names: string[]) {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const name of names) {
    const dest = join(dir, name);
    if (!(await lstat(dest).catch(() => null))) continue;
    if (await isOurs(dest, names)) {
      await remove(dest);
      removed.push(name);
    } else kept.push(dest);
  }
  return { removed, kept };
}
