import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** First `length` hex characters of a SHA-256, for stable file and cache names. */
export const shortHash = (text: string, length = 16) =>
  createHash("sha256").update(text).digest("hex").slice(0, length);

export function assertUuid(id: string, message: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error(message);
}

/** Creates a directory only this user can read, if missing, and returns it. */
export async function privateDir(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** A file path inside a private state directory, creating the directory first. */
export async function statePath(dir: string, name: string) {
  return join(await privateDir(dir), name);
}

/**
 * Keeps the state folder from growing forever: previews (PNGs) older than a
 * day and edit checkpoints and export records older than a week go. Caches
 * (voice clips, analyses) and brand kits stay.
 */
export async function pruneState(dir: string, now = Date.now()) {
  const { readdir, stat, rm } = await import("node:fs/promises");
  const day = 86_400_000;
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const maxAge = name.endsWith(".png")
      ? day
      : /^(editor|export)-[0-9a-f-]{36}\.json$/.test(name)
        ? 7 * day
        : null;
    if (maxAge === null) continue;
    const file = join(dir, name);
    const age =
      now -
      (await stat(file).then(
        (s) => s.mtimeMs,
        () => now,
      ));
    if (age > maxAge) await rm(file, { force: true });
  }
}
