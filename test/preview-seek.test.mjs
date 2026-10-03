import { test } from "node:test";
import assert from "node:assert/strict";
import { previewSeekScript } from "../dist/studio/editor/page.js";

const run = (time, afterWait = () => {}) => {
  const c = {
    project: { playbackDurationMs: 10000, editGeneration: 2 },
    playback: {
      pause() {},
      goTo(ms) {
        this.playbackTimeMs = ms;
      },
      playbackTimeMs: 0,
    },
    view: { targetWindow: { requestAnimationFrame: (fn) => fn(), document: { querySelectorAll: () => [] } } },
  };
  return new (async () => {}).constructor(
    "__ss",
    "setTimeout",
    "clearTimeout",
    previewSeekScript("/p", time),
  )(
    { edit: () => c },
    (fn, ms) => {
      if (ms === 700) {
        afterWait(c);
        fn();
      }
      return 1;
    },
    () => {},
  );
};

test("a preview returns the requested time once the playhead settles", async () => {
  assert.deepEqual(await run(4000), { playheadMs: 4000, editGeneration: 2 });
  assert.deepEqual(await run(12000), { playheadMs: 10000, editGeneration: 2 });
});

test("a preview moved by a manual scrub is refused instead of mislabelled", async () => {
  await assert.rejects(
    run(4000, (c) => {
      c.playback.playbackTimeMs = 7000;
    }),
    /playhead/,
  );
});

test("a project changed during preview capture is refused", async () => {
  await assert.rejects(
    run(4000, (c) => {
      c.project.editGeneration++;
    }),
    /project changed/i,
  );
});
