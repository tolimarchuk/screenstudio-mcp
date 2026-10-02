// Real protocol client: discover schemas, call offline capabilities, and ensure
// malformed recording/edit requests fail without touching the desktop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
test("stdio server advertises editing tools and rejects malformed edits", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/mcp/main.js"],
    stderr: "pipe",
  });
  const client = new Client({ name: "smoke", version: "1" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const { resources } = await client.listResources();
    assert.ok(resources.some((r) => r.uri === "screenstudio://pacing"));
    const { prompts } = await client.listPrompts();
    assert.ok(prompts.some((p) => p.name === "screenstudio_demo"));
    for (const name of [
      "record_start",
      "desktop_perform",
      "analyze",
      "plan_edit",
      "check_pacing",
      "editor_open",
      "editor_apply",
      "editor_frame",
      "editor_save",
      "transcript_generate",
      "transcript_edit",
      "music",
      "catalog",
      "editor_view",
      "presets",
    ])
      assert.ok(
        tools.some((t) => t.name === `screenstudio_${name}`),
        name,
      );
    assert.ok(!tools.some((t) => t.name === "screenstudio_project_edit"));
    const result = await client.callTool({
      name: "screenstudio_status",
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    const bad = await client.callTool({
      name: "screenstudio_editor_apply",
      arguments: {
        projectPath: "/tmp/x",
        ops: [{ op: "setSlices", slices: [{ startMs: 0, endMs: 1, speed: 0 }] }],
      },
    });
    assert.equal(bad.isError, true);
  } finally {
    await client.close();
  }
});
