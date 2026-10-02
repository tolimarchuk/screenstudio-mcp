// The skills and docs are what agents act on, so every tool, op, resource,
// status field and default they name must exist in the code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RESOURCES } from "../dist/mcp/resources.js";
import { editOp } from "../dist/studio/editor/ops.js";
import { configFields } from "../dist/studio/project.js";
import { DEFAULT_STYLE } from "../dist/studio/styles.js";

async function markdownFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await markdownFiles(path)));
    else if (entry.name.endsWith(".md")) out.push(path);
  }
  return out;
}

const docs = await Promise.all(
  ["README.md", ...(await markdownFiles("docs")), ...(await markdownFiles("skills"))].map(async (path) => ({
    path,
    text: await readFile(path, "utf8"),
  })),
);
const doc = (path) => docs.find((d) => d.path === path).text;
const localLinks = (text) =>
  [...text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]).filter((l) => !/^[a-z]+:/.test(l));
const opNames = new Set(editOp.options.map((o) => o.shape.op.value));

async function serverSurface() {
  const client = new Client({ name: "docs", version: "1" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: ["dist/mcp/main.js"], stderr: "pipe" }),
  );
  try {
    const { tools } = await client.listTools();
    const { prompts } = await client.listPrompts();
    const { resources } = await client.listResources();
    const status = await client.callTool({ name: "screenstudio_status", arguments: {} });
    return {
      names: new Set([...tools, ...prompts].map((t) => t.name)),
      uris: new Set(resources.map((r) => r.uri)),
      statusFields: new Set(Object.keys(JSON.parse(status.content[0].text))),
    };
  } finally {
    await client.close();
  }
}

test("docs name only registered tools, prompts, resources and status fields", async () => {
  const { names, uris, statusFields } = await serverSurface();
  for (const { path, text } of docs) {
    for (const [name] of text.matchAll(/\bscreenstudio_[a-z_]+/g))
      assert.ok(names.has(name), `${path}: ${name}`);
    for (const [uri] of text.matchAll(/screenstudio:\/\/[a-z-]+/g))
      assert.ok(uris.has(uri), `${path}: ${uri}`);
    for (const [, field] of text.matchAll(/`screenstudio_status`\s*→\s*`(\w+)`/g))
      assert.ok(statusFields.has(field), `${path}: status field ${field}`);
  }
});

test("local links resolve, and skill references are served as resources", async () => {
  const served = new Set(Object.values(RESOURCES));
  for (const { path, text } of docs) {
    for (const link of localLinks(text)) {
      const target = normalize(join(dirname(path), link));
      await access(target).catch(() => assert.fail(`${path}: broken link ${link}`));
      // Prompts paste SKILL.md text and resources serve files on their own, so a
      // markdown file they point to is only reachable if it is a resource too.
      if ((path.endsWith("SKILL.md") || served.has(path)) && target.endsWith(".md"))
        assert.ok(served.has(target), `${path}: ${link} is not a resource`);
    }
  }
});

test("the edit skill's ops table lists only real ops", () => {
  const table = doc("skills/screenstudio-edit/SKILL.md").split("## Ops reference")[1].split("\n## ")[0];
  const named = table
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .flatMap((line) => [...line.split("|")[1].matchAll(/`(\w+)`/g)].map((m) => m[1]));
  assert.ok(named.length > 10);
  for (const op of named) assert.ok(opNames.has(op), op);
});

test("the workflow example apply is a valid request", () => {
  const json = doc("docs/agent-workflow.md").match(/```json\n([\s\S]*?)```/)[1];
  for (const op of JSON.parse(json).ops) {
    const parsed = editOp.parse(op);
    if (parsed.op !== "config") continue;
    for (const [key, value] of Object.entries(parsed.changes)) configFields[key]?.parse(value);
  }
});

test("docs agree with the code's default style", () => {
  for (const { path, text } of docs) {
    for (const [, style] of text.matchAll(/`?\b(calm|balanced|snappy)\b`? (?:\(the default\)|by default)/g))
      assert.equal(style, DEFAULT_STYLE, path);
    for (const [, style] of text.matchAll(/Default to the (\w+) style/g))
      assert.equal(style, DEFAULT_STYLE, path);
  }
});

test("craft lists exactly the layouts that can be the default", () => {
  const sentence = doc("skills/screenstudio-edit/references/craft.md").match(
    /The default \(`defaultLayout\.type`\) can be ([^.]+)\./,
  )[1];
  const listed = [...sentence.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, [...configFields["defaultLayout.type"].options].sort());
});
