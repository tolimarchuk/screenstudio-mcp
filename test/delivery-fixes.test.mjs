// Delivery at its edges: the GIF floor, safe caption and chapter files, default
// names from any project name, loop embeds, render heights, narration cues, and
// loops that search every pair and hold a short beat without running on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  baseNameFor,
  fitGif,
  loopEmbed,
  narrationCues,
  planLoop,
  renderHeight,
  frameSize,
  limitChecks,
  TARGETS,
  spreadByLength,
  tidyChapters,
  toVtt,
  chapterLines,
} from "../dist/studio/deliver.js";
import { shortHash } from "../dist/studio/util.js";

test("the GIF search reaches its 8fps and 160px floor", async () => {
  const tried = [];
  const fit = await fitGif(async ({ fps, height }) => {
    tried.push([fps, height]);
    return fps <= 8 && height <= 160 ? 100 : 1e9;
  }, 1000);
  assert.equal(fit.fits, true, JSON.stringify(tried));
  assert.deepEqual([fit.fps, fit.height], [8, 160]);
  assert.deepEqual(tried.at(-1), [8, 160]);
  const never = await fitGif(async () => 1e9, 1000);
  assert.equal(never.fits, false);
  assert.deepEqual([never.fps, never.height], [8, 160]);
});

test("VTT cue text is escaped and chapter labels stay on one line", () => {
  const vtt = toVtt([{ text: "R&D --> <b>bold</b>", startMs: 0, endMs: 1000 }]);
  assert.ok(vtt.includes("R&amp;D → &lt;b&gt;bold&lt;/b&gt;"), vtt);
  assert.equal(vtt.split("-->").length, 2, "only the timing line has an arrow");
  assert.equal(chapterLines([{ playbackMs: 0, label: "Intro\nsecond line" }]), "0:00 Intro second line\n");
  const tidy = tidyChapters([
    { playbackMs: 30000, label: "Ship it" },
    { playbackMs: 5000, label: "Set up" },
    { playbackMs: 34000, label: "Too close" },
    { playbackMs: 60000, label: "Wrap" },
  ]);
  assert.deepEqual(
    tidy.chapters.map((c) => [c.playbackMs, c.label]),
    [
      [0, "Set up"],
      [30000, "Ship it"],
      [60000, "Wrap"],
    ],
  );
  assert.ok(tidy.notes.some((n) => /time order/.test(n)));
  assert.ok(tidy.notes.some((n) => /moved to 0:00/.test(n)));
  assert.ok(tidy.notes.some((n) => /Left out "Too close"/.test(n)));
});

test("default file names come from any project name; a given baseName is still checked", () => {
  assert.equal(baseNameFor("/p/Sam's demo: v2.screenstudio"), "Sam-s demo- v2");
  assert.equal(baseNameFor("/p/Sam's demo.screenstudio", undefined, "-loop"), "Sam-s demo-loop");
  assert.equal(baseNameFor(`/p/${"x".repeat(100)}.screenstudio`, undefined, "-loop").length, 80);
  assert.equal(baseNameFor("/p/.hidden.screenstudio"), "hidden");
  assert.throws(() => baseNameFor("/p/x.screenstudio", "it's"), /baseName/);
});

test("the loop embed plays what was made, with encoded names", () => {
  assert.equal(
    loopEmbed({ gif: "/o/My loop.gif", poster: "/o/My loop-poster.png" }),
    '<img src="My%20loop.gif" alt="" loading="lazy">',
  );
  const video = loopEmbed({ mp4: "/o/a #1.mp4", webm: "/o/a #1.webm", poster: "/o/p.png" });
  assert.match(video, /src="a%20%231\.webm"/);
  assert.match(video, /src="a%20%231\.mp4"/);
  assert.match(video, /poster="p\.png"/);
});

test("render heights are the short side, converted to the frame's real height for portrait frames", () => {
  // Screen Studio reads height literally: a 9:16 render at 1080 came out 606x1080.
  assert.equal(renderHeight("9:16", 1080), 1920);
  assert.equal(renderHeight("4:5", 1080), 1350);
  assert.equal(renderHeight("1:1", 1080), 1080);
  assert.equal(renderHeight("16:9", 1080), 1080);
  assert.equal(renderHeight(9 / 16, 720), 1280);
  assert.equal(renderHeight(16 / 9, 1080), 1080);
  // Always even, as encoders need.
  assert.equal(renderHeight("9:16", 1081) % 2, 0);
  // "auto" takes the recording's own ratio, when known.
  assert.equal(renderHeight("auto", 1080, 9 / 16), 1920);
  assert.equal(renderHeight("auto", 1080), 1080);
  assert.deepEqual(frameSize("9:16", 1080), { width: 1080, height: 1920 });
  assert.deepEqual(frameSize("16:9", 1080), { width: 1920, height: 1080 });
  assert.deepEqual(frameSize("4:5", 1080), { width: 1080, height: 1350 });
  assert.deepEqual(frameSize("16:9", 480), { width: 854, height: 480 });
});

test("the resolution check reads the short side and names the frame it wanted", () => {
  const media = (width, height) => ({ durationMs: 10000, width, height, fps: 60, bytes: 1e6 });
  const res = (w, h) =>
    limitChecks("shorts", TARGETS.shorts, media(w, h)).find((c) => c.check === "resolution");
  assert.equal(res(1080, 1920), undefined);
  const small = res(606, 1080);
  assert.equal(small.ok, false);
  assert.match(small.message, /606x1080; shorts wants 1080x1920/);
  assert.equal(
    limitChecks("x", TARGETS.x, media(1920, 1080)).find((c) => c.check === "resolution"),
    undefined,
  );
});

test("narration cues saved by narrate are read with their caption mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ssmcp-cues-"));
  try {
    const project = "/p/Demo.screenstudio";
    assert.deepEqual(await narrationCues(dir, project), { cues: [], mode: null });
    await writeFile(
      join(dir, `narration-${shortHash(project)}.json`),
      JSON.stringify({
        captionsMode: "burn-in",
        cues: [
          { text: "Open", startMs: 300, endMs: 600 },
          { text: "broken", startMs: 900, endMs: 900 },
        ],
      }),
    );
    const read = await narrationCues(dir, project);
    assert.equal(read.mode, "burn-in");
    assert.deepEqual(read.cues, [{ text: "Open", startMs: 300, endMs: 600 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const click = (atMs, x, y) => ({ atMs, endMs: atMs + 80, x, y, drag: false, button: "left" });
function analysis(times, end) {
  const clicks = times.map((t, i) => click(t, 0.2 + (i % 5) * 0.15, 0.3 + (i % 3) * 0.2));
  const idle = [];
  let at = 0;
  for (const c of clicks) {
    if (c.atMs - at >= 800) idle.push({ startMs: at, endMs: c.atMs - 200 });
    at = c.endMs + 200;
  }
  idle.push({ startMs: at, endMs: end });
  return {
    projectPath: "/x.screenstudio",
    sourceDurationMs: end,
    capture: { kind: "window", widthPt: 1440, heightPt: 900 },
    sessions: [{ startMs: 0, endMs: end, video: "" }],
    clicks,
    typing: [],
    shortcuts: [],
    movement: [],
    screen: { changes: [], active: [] },
    idle,
  };
}

test("every distinct pair is compared, so a match far from the target is found", async () => {
  // Clicks 4s apart: dozens of pairs near an 8s target, and the one that matches runs about 14s.
  const times = Array.from({ length: 25 }, (_, i) => 3000 + i * 4000);
  const a = analysis(times, 105000);
  let best = null;
  const loop = await planLoop(a, { targetMs: 8000 }, async (first, last) => {
    const len = last - first;
    if (len > 12500 && first > 40000 && first < 43000) {
      best ??= [first, last];
      return first === best[0] && last === best[1] ? 0.97 : 0.3;
    }
    return 0.3;
  });
  assert.equal(loop.seamless, true, loop.notes.join(" "));
  assert.equal(loop.ssim, 0.97);
});

test("a short beat with no match is held on its result, not run into the next beat", async () => {
  const a = analysis([3000, 6500, 10000, 13500], 20000);
  const loop = await planLoop(a, { targetMs: 4000 }, async () => 0.3);
  assert.equal(loop.seamless, false);
  assert.ok(loop.playbackMs >= 3999, String(loop.playbackMs));
  // The clip stops before the next click, whichever beat it is.
  const clicks = a.clicks.map((c) => c.atMs);
  const inside = clicks.filter((t) => t > loop.sourceRange.startMs && t < loop.sourceRange.endMs);
  assert.equal(inside.length, 1, JSON.stringify({ range: loop.sourceRange, inside }));
  assert.match(loop.notes.join(" "), /held on its result|restart shows a jump/);
});

test("loop checks spread across lengths when there are more pairs than the cap", () => {
  const near = Array.from({ length: 30 }, (_, i) => ({ len: 8000 + i, fit: 0.99 - i / 1000 }));
  const far = { len: 14500, fit: 0.2 };
  const picked = spreadByLength([...near, far], 10);
  assert.equal(picked.length, 10);
  assert.ok(picked.includes(far));
  assert.equal(spreadByLength([far, near[0]], 10)[0], near[0]);
});
