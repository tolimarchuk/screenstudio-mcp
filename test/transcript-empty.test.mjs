import { test } from "node:test";
import assert from "node:assert/strict";
import { readTranscript } from "../dist/studio/transcript.js";

test("a recording without generated captions returns an empty transcript", async () => {
  const studio = {
    evaluate: (body) =>
      new (async () => {}).constructor("bridge", body)({
        client: { query: async () => null },
      }),
  };
  const result = await readTranscript(studio, new URL("fixtures/window-recording", import.meta.url).pathname);
  assert.deepEqual(result, { sessions: [], words: [] });
});
