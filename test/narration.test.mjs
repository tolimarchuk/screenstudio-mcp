// Narration and music: spec merging, library names, the duck envelope and cleanup rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  duckEnvelope,
  narrationInput,
  narrationSpec,
  orphanedAudio,
  previousTrack,
  resolveMusic,
  ttsArgs,
  MUSIC,
  NARRATION_DEFAULTS,
} from "../dist/studio/narration.js";
import { catalog, musicLibrary, readAsar } from "../dist/studio/assets.js";
import { z } from "zod";

const lines = [{ sourceMs: 1000, text: "Here is the dashboard." }];

test("a fresh narration uses the defaults for anything not passed", () => {
  const spec = narrationSpec({ lines }, { lines: [{ sourceMs: 0, text: "old" }], voice: "x", music: "a/b" });
  assert.deepEqual(spec, { ...NARRATION_DEFAULTS, lines });
});

test("a re-sync keeps the saved settings and takes the request's explicit values", () => {
  const saved = {
    lines,
    voice: "en-US-AvaMultilingualNeural",
    rate: 5,
    music: null,
    musicVolume: 0.1,
    voiceVolume: 1.2,
    fileName: "narration-1-abc.m4a",
  };
  assert.deepEqual(narrationSpec({ music: "commercial/Product Uplift", musicVolume: 0.12 }, saved), {
    lines,
    voice: "en-US-AvaMultilingualNeural",
    rate: 5,
    music: "commercial/Product Uplift",
    musicVolume: 0.12,
    voiceVolume: 1.2,
  });
  assert.equal(narrationSpec({ music: null }, { ...saved, music: "lo-fi/Lean Groove" }).music, null);
  assert.equal(narrationSpec({}, { ...saved, music: "lo-fi/Lean Groove" }).music, "lo-fi/Lean Groove");
  assert.throws(() => narrationSpec({}, null), /No earlier narration/);
});

test("the request schema rejects an empty lines array and leaves settings unset", () => {
  const schema = z.object(narrationInput);
  assert.match(schema.safeParse({ lines: [] }).error.issues[0].message, /at least one line/);
  assert.deepEqual(schema.parse({}), {});
});

const library = {
  commercial: ["Focus Mallets", "Product Uplift"],
  "lo-fi": ["Lean Groove", "Sunny Lo‑Fi"],
};

test("music names match with plain hyphens and any case, and come back as shipped", () => {
  assert.equal(resolveMusic(library, "lo-fi/Sunny Lo-Fi"), "lo-fi/Sunny Lo‑Fi");
  assert.equal(resolveMusic(library, "Commercial/product uplift"), "commercial/Product Uplift");
  assert.equal(resolveMusic(library, "lo-fi/Sunny Lo‑Fi"), "lo-fi/Sunny Lo‑Fi");
  assert.throws(() => resolveMusic(library, "constructor/x"), /Unknown music track/);
  assert.throws(() => resolveMusic(library, "Product Uplift"), /Unknown music track/);
  assert.throws(() => resolveMusic({}, "commercial/Product Uplift"), /not found in the app bundle/);
  assert.equal(MUSIC["lo-fi"].includes("Sunny Lo‑Fi"), true);
});

test("the duck envelope nests logarithmically and merges spans whose ramps touch", () => {
  assert.equal(duckEnvelope([], 0.35), "1");
  const spans = Array.from({ length: 1000 }, (_, i) => [i * 2, i * 2 + 0.5]);
  const env = duckEnvelope(spans, 0.35);
  let depth = 0;
  let max = 0;
  for (const c of env) {
    if (c === "(") max = Math.max(max, ++depth);
    if (c === ")") depth--;
  }
  assert.ok(max < 20, `nesting ${max}`);
  assert.equal(env.match(/clip\(/g).length, 1000);
  const merged = duckEnvelope(
    [
      [3, 4],
      [1, 2],
      [2.5, 2.8],
    ],
    0.5,
  );
  assert.equal(merged, "1-0.500*clip(min((t-0.650)/0.35,(4.350-t)/0.35),0,1)");
});

test("edge-tts gets the text as one argument so a leading dash is not an option", () => {
  const args = ttsArgs("-50% off", "en-US-AndrewMultilingualNeural", -5, "/tmp/x.mp3");
  assert.ok(args.includes("--text=-50% off"));
  assert.ok(args.includes("--rate=-5%"));
  assert.ok(ttsArgs("hi", "v", 3, "o").includes("--rate=+3%"));
});

test("the previous track is told apart as narration, music or a custom track", () => {
  const narration = { fileName: "narration-1-a.m4a" };
  const music = { track: "commercial/Product Uplift", volume: 0.08, fileName: "music-2-b.m4a" };
  assert.equal(previousTrack(null, narration, music), null);
  assert.equal(previousTrack("narration-1-a.m4a", narration, music).kind, "narration");
  assert.deepEqual(previousTrack("music-2-b.m4a", narration, music), {
    fileName: "music-2-b.m4a",
    kind: "music",
    track: "commercial/Product Uplift",
  });
  assert.equal(previousTrack("my-song.mp3", null, null).kind, "custom");
});

test("only unreferenced tool-made audio is swept from a project", () => {
  const files = [
    "narration-17-aaa.m4a",
    "narration-18-bbb.m4a",
    "music-19-ccc.m4a",
    "my-song-1-x.m4a",
    "cam.mp4",
  ];
  assert.deepEqual(orphanedAudio(files, '{"backgroundAudioFileName":"narration-18-bbb.m4a"}'), [
    "narration-17-aaa.m4a",
    "music-19-ccc.m4a",
  ]);
});

/** A minimal app.asar: pickle-framed JSON header, then file contents. */
async function fakeApp(files) {
  const root = { files: {} };
  const blobs = [];
  let offset = 0;
  for (const [path, body] of Object.entries(files)) {
    const parts = path.split("/");
    let node = root;
    for (const p of parts.slice(0, -1)) node = node.files[p] ??= { files: {} };
    const data = Buffer.from(body);
    node.files[parts.at(-1)] = { size: data.length, offset: String(offset) };
    blobs.push(data);
    offset += data.length;
  }
  const json = Buffer.from(JSON.stringify(root));
  const padded = Math.ceil(json.length / 4) * 4;
  const head = Buffer.alloc(16 + padded);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(8 + padded, 4);
  head.writeUInt32LE(4 + padded, 8);
  head.writeUInt32LE(json.length, 12);
  json.copy(head, 16);
  const app = await mkdtemp(join(tmpdir(), "ss-app-"));
  await mkdir(join(app, "Contents/Resources"), { recursive: true });
  await writeFile(join(app, "Contents/Resources/app.asar"), Buffer.concat([head, ...blobs]));
  return app;
}

test("the music library is read from the app bundle, names as shipped", async () => {
  const app = await fakeApp({
    "assets/background-audio/lo-fi/Sunny Lo‑Fi.mp3": "sunny",
    "assets/background-audio/lo-fi/.DS_Store": "",
    "assets/background-audio/commercial/Product Uplift.mp3": "uplift",
    "assets/background-audio/readme.txt": "x",
  });
  const lib = await musicLibrary(app);
  assert.deepEqual(lib, { "lo-fi": ["Sunny Lo‑Fi"], commercial: ["Product Uplift"] });
  const track = resolveMusic(lib, "lo-fi/sunny lo-fi");
  const asar = join(app, "Contents/Resources/app.asar");
  assert.equal((await readAsar(asar, `assets/background-audio/${track}.mp3`)).toString(), "sunny");
  assert.deepEqual((await catalog(app)).music, {
    "lo-fi": ["lo-fi/Sunny Lo‑Fi"],
    commercial: ["commercial/Product Uplift"],
  });
});
