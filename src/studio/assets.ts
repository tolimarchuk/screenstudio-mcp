// Screen Studio's bundled media (wallpapers, cursor sets, device frames, music)
// read straight from the installed app.asar, without extracting it.
import { open } from "node:fs/promises";
import { join } from "node:path";

type Node = { files?: Record<string, Node>; size?: number; offset?: string };

async function header(asarPath: string) {
  const fh = await open(asarPath, "r");
  const head = Buffer.alloc(16);
  await fh.read(head, 0, 16, 0);
  const pickleSize = head.readUInt32LE(4);
  const jsonSize = head.readUInt32LE(12);
  const json = Buffer.alloc(jsonSize);
  await fh.read(json, 0, jsonSize, 16);
  return { fh, base: 8 + pickleSize, root: JSON.parse(json.toString("utf8")) as Node };
}

function find(root: Node, inner: string) {
  let node: Node | undefined = root;
  for (const part of inner.split("/").filter(Boolean)) node = node?.files?.[part];
  return node;
}

export async function readAsar(asarPath: string, inner: string): Promise<Buffer> {
  const { fh, base, root } = await header(asarPath);
  try {
    const node = find(root, inner);
    if (!node || node.size === undefined) throw new Error(`Not in the app bundle: ${inner}`);
    const data = Buffer.alloc(node.size);
    await fh.read(data, 0, node.size, base + Number(node.offset));
    return data;
  } finally {
    await fh.close();
  }
}

/** Lists a bundle folder as { folder: [files] } one level deep. */
export async function listAsar(asarPath: string, inner: string): Promise<Record<string, string[]>> {
  const { fh, root } = await header(asarPath);
  await fh.close();
  const dir = find(root, inner);
  const out: Record<string, string[]> = {};
  for (const [name, node] of Object.entries(dir?.files ?? {})) {
    if (node.files)
      out[name] = Object.keys(node.files)
        .filter((f) => !f.startsWith(".") && !f.endsWith(".ts"))
        .sort();
    else (out["."] ??= []).push(name);
  }
  return out;
}

export const appAsar = (appPath: string) => join(appPath, "Contents/Resources/app.asar");

/** The bundled music library as { genre: [track names] }, names exactly as shipped (some use U+2011). */
export async function musicLibrary(appPath: string): Promise<Record<string, string[]>> {
  const genres = await listAsar(appAsar(appPath), "assets/background-audio");
  return Object.fromEntries(
    Object.entries(genres)
      .filter(([genre]) => genre !== ".")
      .map(([genre, files]) => [genre, files.filter((f) => f.endsWith(".mp3")).map((f) => f.slice(0, -4))]),
  );
}

export async function catalog(appPath: string) {
  const asar = appAsar(appPath);
  const [backgrounds, cursorSets, devices, music] = await Promise.all([
    listAsar(asar, "assets/backgrounds"),
    listAsar(asar, "assets/cursors/sets"),
    listAsar(asar, "assets/devices"),
    musicLibrary(appPath),
  ]);
  return {
    wallpapers: Object.fromEntries(
      Object.entries(backgrounds).map(([k, v]) => [k, v.map((f) => `${k}/${f}`)]),
    ),
    cursorSets: Object.keys(cursorSets),
    deviceFrames: (devices["."] ?? []).map((f) => f.replace(/\.png$/, "")),
    music: Object.fromEntries(Object.entries(music).map(([k, v]) => [k, v.map((name) => `${k}/${name}`)])),
  };
}
