import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "../dist/mcp/tools/editor.js";

test("edit context reads the current window once, without opening or copying it", async () => {
  const registered = new Map();
  const server = { registerTool: (name, schema, handler) => registered.set(name, { schema, handler }) };
  const calls = [];
  const raw = {
    projectPath: "/open",
    name: "demo",
    editGeneration: 7,
    config: { camera: { hide: false } },
    scenes: [],
  };
  register(server, {
    editor: {
      current: async (p) => {
        calls.push(["current", p]);
        return "/open";
      },
      raw: async (p) => {
        calls.push(["raw", p]);
        return raw;
      },
    },
    analysisFor: async (p) => {
      calls.push(["analysis", p]);
      return { hasMicrophone: true, speech: [] };
    },
  });
  const tool = registered.get("screenstudio_edit_context");
  assert.ok(tool);
  const result = await tool.handler({ analyze: true });
  const context = JSON.parse(result.content[0].text);
  assert.deepEqual(calls, [
    ["current", undefined],
    ["raw", "/open"],
    ["analysis", "/open"],
  ]);
  assert.equal(context.projectPath, "/open");
  assert.equal(context.editGeneration, 7);
  assert.equal(context.needsTranscript, true);
  assert.deepEqual(context.config, raw.config);
  assert.equal(registered.get("screenstudio_editor_apply").schema.inputSchema.show.def.defaultValue, false);
});
