# AGENTS.md

Screen Studio MCP is an npm package: an MCP server plus one agent skill for the Screen Studio macOS app. It does two jobs:

1. Record a new video: it operates the person's app with real input while Screen Studio records.
2. Edit a video already in Screen Studio: every change happens live in the open editor.

Every edit follows the person's own direction. Recipes are optional presets, never a default.

## Repo shape

- `src/mcp/` is the MCP server: `main.ts`, one file per tool group in `tools/`, resources and prompts.
- `src/studio/` is the engine: app connection, recording, footage analysis, edit planning, pacing rules, styles and recipe presets, narration, export and delivery.
- `src/studio/editor/` edits the open project live through the app's own editor model.
- `src/cli/main.ts` is the `screenstudio-mcp` command: install, doctor, update, uninstall, serve.
- `native/Desktop.swift` is the native input helper (clicks, typing, taps, holds, OCR). The npm package ships it prebuilt and universal.
- `skills/screenstudio/` is the one skill. `SKILL.md` is the router: the tools, the record, edit and deliver flow, the rules for every stage and a table of references. `references/record.md`, `edit.md` and `deliver.md` hold each stage's detail; the rest are topic references. The installer copies the skill into Claude Code (`<claude home>/skills`) and Codex (`~/.agents/skills`) and removes the old `screenstudio-record`, `-edit` and `-deliver` folders it installed. The MCP server serves every reference as a resource, and its prompts paste `SKILL.md` with the stage guides they need.
- `plugins/screenstudio/` is the plugin Claude Code and Codex install: both manifests plus a mirror of `skills/`. Never edit the mirror; run `npm run sync:plugin` after changing `skills/` (`npm run check` fails when it is stale).
- `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json` make the repo a plugin marketplace for Claude Code and Codex.

## Rules

- Everything tied to one Screen Studio build lives in `src/studio/compat.ts`. Mutating operations refuse other builds.
- Nothing may write to stdout in the server: it is the MCP channel.
- Keep tools general. Never tune a default to one app, site, brand or person. A person's own taste belongs in their preferences file (`~/.screenstudio-mcp/preferences.md`), never in the skill.
- Keep `SKILL.md` under about 8 KB and its description under 600 characters; put detail in references. Every reference `SKILL.md` or a resource links to must be a resource too (the docs test checks).
- Edits go through the open editor, never by rewriting project files behind the app.
- Run `npm run check` before calling work done.

## Release

- Bump `version` in `package.json` and both plugin manifests (including the pinned `screenstudio-mcp@<version>` they start), add a CHANGELOG entry, and publish a GitHub release tagged `v<version>`. The publish workflow builds the universal helper on macOS and publishes to npm with provenance.
