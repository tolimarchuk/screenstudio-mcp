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
      "Screen Studio MCP does two jobs in the real Screen Studio app: record a new video (operate the person's app with real input while Screen Studio records), and edit a video that is already in Screen Studio (live in the open editor).",
      "Follow the person's own direction for every edit; anything Screen Studio can do is fair to change.",
      "Edit in the open editor window: screenstudio_editor_open, then screenstudio_editor_apply. Changes appear live for the person watching and use the app's undo history. Never quit the app or rewrite project files to edit.",
      "Let the footage decide the edit: screenstudio_analyze reads clicks, typing and screen changes; screenstudio_plan_edit proposes calm cuts, speed-ups only for typing and waiting, and few long zooms; screenstudio_check_pacing flags anything too fast.",
      "Look before you commit: screenstudio_source_frames shows raw moments, screenstudio_editor_frame shows the edited preview at any playback time.",
      "Record with screenstudio_desktop_perform so each beat is one natural take with holds between steps.",
      "Read the craft resource (zoom, loupe, cursor, clicks, springs, frame, music, narration) before editing, and the narration resource before voicing a video.",
      "screenstudio_recipes lists optional presets that set a whole direction in one word (none is applied unless named); a saved brand kit (screenstudio_brand) goes on top. Read each plan's notes: they say why every cut, speed-up and zoom is there.",
      "Render and inspect frames before calling a video finished: screenstudio_contact_sheet shows the key moments in one grid, screenstudio_export_variants renders every destination with a delivery kit.",
      "Before publishing, run screenstudio_find_sensitive to blur keys, emails and other private text on screen.",
    ].join(" "),
  },
);

const ctx = new Context();
pruneState(ctx.studio.stateDir).catch(() => {});
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
