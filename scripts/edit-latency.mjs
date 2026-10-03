// Measures the real app without changing its project or playhead.
// node scripts/edit-latency.mjs [--analyze]
import { performance } from "node:perf_hooks";
import { Context } from "../dist/mcp/context.js";
import { register } from "../dist/mcp/tools/editor.js";

const context = new Context();
const tools = new Map();
register({ registerTool: (name, _schema, handler) => tools.set(name, handler) }, context);
let evaluations = 0;
const evaluate = context.studio.evaluate.bind(context.studio);
context.studio.evaluate = (...args) => {
  evaluations++;
  return evaluate(...args);
};
const results = [];
async function measure(label, fn) {
  const start = performance.now();
  const before = evaluations;
  await fn();
  results.push({
    operation: label,
    milliseconds: Math.round(performance.now() - start),
    evaluations: evaluations - before,
  });
}
const current = await context.editor.current();
await measure("current window and settings", async () => {
  const result = await tools.get("screenstudio_edit_context")({ analyze: false, projectPath: current });
  if (result.isError) throw new Error(result.content[0].text);
});
await measure("separate timeline and settings reads", async () => {
  await context.editor.state(current);
  await context.editor.raw(current);
});
if (process.argv.includes("--analyze")) {
  for (const label of ["analysis first call", "analysis cached call"])
    await measure(label, () => context.analysisFor(current));
}
console.log(JSON.stringify({ results }, null, 2));
