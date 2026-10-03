#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Context } from "./context.js";
import { pruneState } from "../studio/util.js";
import { packageFile } from "./resources.js";
import * as resources from "./resources.js";
import * as prompts from "./prompts.js";
import * as app from "./tools/app.js";
import * as recording from "./tools/recording.js";
import * as desktop from "./tools/desktop.js";
import * as footage from "./tools/footage.js";
import * as plan from "./tools/plan.js";
import * as editor from "./tools/editor.js";
import * as audio from "./tools/audio.js";
import * as transcript from "./tools/transcript.js";
import * as exporting from "./tools/export.js";
import * as delivery from "./tools/deliver.js";
import * as brand from "./tools/brand.js";
import * as privacy from "./tools/privacy.js";

const { version } = JSON.parse(await packageFile("package.json"));
const server = new McpServer(
  { name: "screenstudio-mcp", version },
  {
    instructions: [
      "Record and edit in the real Screen Studio app. Follow the person's direction; recipes are optional.",
      "Start edits with screenstudio_edit_context and use the current window. Copy only when asked; open only when the requested project is not open. Preserve manual adjustments and refresh state after they change. Apply directly by default; show:true demonstrates each step. Use undo/checkpoints, never quit the app or rewrite project files to edit.",
      "Read craft and pacing before styling; narration before adding a voice. Analyze speech and actions, inspect source frames, plan the edit, apply one batch, then inspect the affected previews. Never speed up speech or clicks the viewer needs to follow.",
      "Record with screenstudio_desktop_perform and holds between beats. Resources and skills contain the full recording, editing and delivery workflow.",
      "Before finishing, render and inspect the delivered key frames, captions, controls and pacing; listen to the audio. Before publishing, scan and blur private text.",
      "Write in the person's voice about their product. No agent, AI or model credits unless asked.",
    ].join(" "),
  },
);

const ctx = new Context();
pruneState(ctx.studio.stateDir)
  .then(() => ctx.studio.deliverPending())
  .catch(() => {});
for (const tools of [
  app,
  recording,
  desktop,
  footage,
  plan,
  editor,
  audio,
  transcript,
  exporting,
  delivery,
  brand,
  privacy,
])
  tools.register(server, ctx);
resources.register(server);
prompts.register(server);

await server.connect(new StdioServerTransport());
