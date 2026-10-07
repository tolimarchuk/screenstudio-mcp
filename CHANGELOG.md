# Screen Studio MCP Changelog

New releases go at the top.

## Unreleased

- **One skill instead of three.** `screenstudio-record`, `screenstudio-edit` and `screenstudio-deliver` are now one `screenstudio` skill, so agents see a single catalog entry. Its `SKILL.md` lists the tools, the record, edit and deliver flow and the rules for every stage, and routes to a guide per stage (`references/record.md`, `edit.md`, `deliver.md`) and the existing references. The stage guides are also resources (`screenstudio://record`, `screenstudio://edit`, `screenstudio://deliver`), and the prompts paste the skill with the guides they need.
- **Your own defaults.** Before recording or editing, the skill reads `~/.screenstudio-mcp/preferences.md` (in `SCREENSTUDIO_STATE_DIR` when set) if it exists: editing taste, pacing, narration voice and settings, credit rules. Its preferences override the skill's defaults.
- **Installer.** `install` and `update` put the skill in Claude Code's skills folder and, for Codex, in `~/.agents/skills` (`$CODEX_HOME/skills` is deprecated). They remove the three old skill folders from Claude Code, `$CODEX_HOME/skills` and `~/.agents/skills`, but only folders the installer made: a copy with its marker, or a symlink to a screenstudio-mcp checkout's own skill folder. `uninstall` removes the new and old folders. `--agents-home` points at a folder other than `~/.agents`.

## 0.5.4 (2026-10-03)

- **Edit the current window.** Editing starts in the existing focused project, preserving the person's camera size, crop and other adjustments. Project copies are created only when requested.
- **Apply edits directly by default.** `show: true` remains available to demonstrate each step. In one paired full-edit replay, the same prepared edit took 14.98 seconds with visible steps and 0.40 seconds directly, about 37 times faster. Both retained the same pacing and visual review. See `docs/faster-editing.md` for the method and limits.
- **Start with one context read.** `screenstudio_edit_context` returns the current settings, timeline and footage analysis together; `analyze: false` keeps small corrections fast.
- **Protect newer adjustments.** Edit generation checks stop outdated batches, and config read-back reports settings the app ignored. Preview captures check the requested playhead and project generation before and after capture.
- **Fix nested updates and missing data.** Successive config changes preserve earlier changes, optional camera crops can be initialized, and an absent transcript returns empty timing data.

## 0.5.3 (2026-10-02)

- **Zooms are manual by default.** The planner gives every zoom one fixed position on what matters. Following the mouse is only for tracking the pointer itself, like a drag.
- **Back-to-back zooms.** Moments too far apart for one frame become separate manual zooms that hand off with no wide shot between, instead of one zoom re-aimed or left to follow the mouse. The pacing check treats a back-to-back hand-off as fine and still flags a sliver of wide shot between two zooms.
- **A manual zoom must say where it points.** `addZoom` without `target` (and without `follow`) is refused.
- **Camera-aware framing, documented.** Screen Studio places a manual target at the middle of the area the camera leaves free, not the frame center; the edit skill and tool description say so and to check the frame.

## 0.5.2 (2026-10-02)

- Scripts, captions and titles stay in the person's voice: the server instructions, narration tools and edit skill tell agents never to credit the agent or AI in a video.
- Editor preview frames are scaled to at most 1600 pixels wide, so a large editor window no longer produces frames too big to return.

## 0.5.1 (2026-10-02)

- `screenstudio_export_start` waits for the render and returns the delivered file, so an agent can't end its turn with the video still undelivered. `wait: false` keeps the old poll-based flow.
- On startup the server delivers any export that finished after the session that started it ended.

## 0.5.0 (2026-10-02)

First public release.

- **Recording.** Operates your app with native input while Screen Studio records: clicks, typing, scrolling, drags, repeated taps and press-and-hold, paced like a person. Each beat records as one take with markers.
- **Editing existing projects.** Edits any project already in Screen Studio in the open editor, in your own words: cuts and speed, zooms and the loupe, camera layouts, crop, backdrop, masks, cursor and captions. Changes use the app's own undo history and save after each apply.
- **Edit planning.** Reads the footage (clicks, typing, scene changes, idle time, transcripts) and proposes an edit with styles (calm, balanced, snappy), beat scoring and fit-to-length. A pacing check explains every cut, speed-up and zoom. Seven recipes are available as optional presets.
- **Narration, captions and music.** Narration pinned to moments in the recording so it survives re-cuts, captions from the transcript or the voice, and library music ducked under speech.
- **Export.** Renders variants for X, Shorts, LinkedIn, landing pages and docs, plus seamless loops, contact sheets, brand kits and blur masks for keys and emails on screen.
- **Install.** `npx screenstudio-mcp` sets up the server and skills for Claude Code and Codex and checks the Mac (Screen Studio build, ffmpeg, edge-tts, Accessibility, Screen Recording). The same server and skills install as a plugin in Claude Code (`/plugin marketplace add tolimarchuk/screenstudio-mcp`) and Codex (`codex plugin marketplace add tolimarchuk/screenstudio-mcp`).
- Supports Screen Studio up to 4.0.1 (build 4897). Reading works on any 4.x; recording and editing on another build needs `SCREENSTUDIO_ALLOW_UNTESTED=1`.
