---
name: screenstudio
description: Records, edits and delivers videos in the Screen Studio macOS app with the screenstudio MCP tools. Performs a software walkthrough with human-paced native clicks and typing while Screen Studio records; edits a project live in the open editor (cuts, speed, zooms, glass loupe, camera layouts, crop, backdrop, masks, captions, cursor, narration, music, blurred private text); renders, checks and exports MP4s and GIFs. Use when asked to record a screen, product demo or app walkthrough, edit or polish a Screen Studio recording, or render, export or deliver a finished Screen Studio video or GIF.
---

# Screen Studio videos

Three stages, each usable on its own: **record** a walkthrough by operating the person's app while Screen Studio records, **edit** a project live in the open Screen Studio editor, and **deliver** a checked render. Start at the stage the request needs: "edit my video" starts at edit, "export it for X" at deliver.

## The person's preferences come first

The person may keep their own defaults (editing taste, pacing, narration voice and settings, credit rules) in `~/.screenstudio-mcp/preferences.md`, or in `preferences.md` inside `$SCREENSTUDIO_STATE_DIR` when that variable is set. If the file exists, read it before recording or editing. Its preferences override this skill's defaults; what the person asks for in the conversation overrides both. Change the file only when they ask.

## Tools

| Job | Tools |
| --- | --- |
| Connect | `screenstudio_status` (start here: connection, build, open editors, recording state, `knownSettings`), `screenstudio_launch`, `screenstudio_quit` |
| Record | `screenstudio_sources`, `screenstudio_record_start`, `screenstudio_record_control` (pause, marker, finish), `screenstudio_record_state`, `screenstudio_desktop_inspect`, `screenstudio_desktop_screenshot`, `screenstudio_desktop_perform` (a whole beat), `screenstudio_desktop_action` (one step), `screenstudio_voice_lines` |
| Understand | `screenstudio_edit_context` (start of every edit), `screenstudio_analyze`, `screenstudio_source_frames`, `screenstudio_transcript_generate`, `screenstudio_transcript_read`, `screenstudio_transcript_edit` |
| Plan | `screenstudio_plan_edit`, `screenstudio_plan_layouts`, `screenstudio_check_pacing`, `screenstudio_recipes`, `screenstudio_catalog`, `screenstudio_brand`, `screenstudio_presets` |
| Edit live | `screenstudio_editor_apply` (ops), `screenstudio_editor_state`, `screenstudio_editor_open`, `screenstudio_editor_list`, `screenstudio_editor_view`, `screenstudio_editor_seek`, `screenstudio_editor_play`, `screenstudio_editor_history`, `screenstudio_editor_restore`, `screenstudio_editor_save`, `screenstudio_project_duplicate` (only when asked) |
| Sound and privacy | `screenstudio_narrate`, `screenstudio_music`, `screenstudio_find_sensitive` |
| Look | `screenstudio_contact_sheet`, `screenstudio_editor_frame`, `screenstudio_export_frame` |
| Deliver | `screenstudio_export_start`, `screenstudio_export_status`, `screenstudio_export_cancel`, `screenstudio_export_variants`, `screenstudio_loop` |

Slices, zooms, markers and the footage analysis use source ms; the editor state, pacing report and frames use playback ms. Every apply returns both.

## The flow

1. **Record**, only for a new video: connect, write 3–6 beats, rehearse, record each beat in one take with `screenstudio_desktop_perform`, and finish to a saved project. For a narrated video, write the script and voice it with `screenstudio_voice_lines` before recording, so each beat lasts as long as its line.
2. **Edit**: read the current window with `screenstudio_edit_context`, look at the footage, plan, apply one batch, look at the result, refine one thing at a time, narrate, blur private text, save.
3. **Deliver**: check pacing, render, check the file and its frames, listen, save, report.

## Rules for every stage

- **The person directs.** Follow their words for every cut, zoom, layout, look and sound. The planner and recipes fill only what they leave open. Recipes are optional presets; none is a default.
- **The video is theirs.** Write lines, captions and titles in their voice about their product. Never credit the agent, the AI or the model in a line, caption or end card unless they ask.
- **The real app, the open editor.** Edit in the person's current editor window; open a project only when the requested one is not open; copy only when asked. Never quit Screen Studio or rewrite project files to edit. Keep their crop, camera size and other manual adjustments unless the request needs them changed. After they adjust anything, read the live state again; never replay an older plan over their changes.
- **No connection?** `screenstudio_status` explains why. If Screen Studio runs without an automation connection, the person quits it (Cmd+Q) and `screenstudio_launch` starts it again; the server never kills the app.
- **A timeout is not a failure.** A timed-out start, finish, apply or export may have happened: inspect state, or poll the same export job, before retrying.
- **The viewer must keep up.** Clicks and cursor travel play at 1x, speech is never sped up, and only typing and waiting get faster. Few, long zooms. [Pacing](references/pacing.md) has the numbers.
- **Private stays private.** Record only what the person asked to show. Before anything is published, run `screenstudio_find_sensitive` and apply its blur masks.
- **Look before calling it done.** Check real rendered frames (the contact sheet first) after editing and after export, listen when there is sound, and wait for the export to deliver its file before ending the turn.
- **Save what an apply did not.** Applies save by default. Undo, restore, narration and music change only the open editor and need `screenstudio_editor_save`.
- **Fast, not careless.** Skip references a request does not need; never skip framing, pacing, caption and final-frame checks.

## References

Read the stage reference before starting that stage, and the others when the job calls for them. The MCP server also serves each one as a resource.

| Job | Read | Resource |
| --- | --- | --- |
| Recording a walkthrough: beats, rehearsal, input, coordinates | [record](references/record.md) | `screenstudio://record` |
| Recording a website in a clean browser window | [browser-demos](references/browser-demos.md) | `screenstudio://browser-demos` |
| A recording that stalls, times out or loses the app | [recovery](references/recovery.md) | `screenstudio://recovery` |
| Editing: workflow, ops table, fixes for "it feels wrong" | [edit](references/edit.md) | `screenstudio://edit` |
| Styling: crop, backdrop, camera, zoom, loupe, masks, captions, cursor, sound | [craft](references/craft.md) | `screenstudio://craft` |
| Timing: cuts, speed, zooms, springs | [pacing](references/pacing.md) | `screenstudio://pacing` |
| Beats, fitting a length, markers, director's notes, camera layouts | [story](references/story.md) | `screenstudio://story` |
| Voice-over, script timing, narration captions | [narration](references/narration.md) | `screenstudio://narration` |
| Optional recipe presets | [recipes](references/recipes.md) | `screenstudio://recipes` |
| A saved brand kit | [brand](references/brand.md) | `screenstudio://brand` |
| Blurring keys, emails and other private text | [privacy](references/privacy.md) | `screenstudio://privacy` |
| Rendering, final review, failed exports | [deliver](references/deliver.md) | `screenstudio://deliver` |
| Several destinations at once and the delivery kit | [variants](references/variants.md) | `screenstudio://variants` |
| A seamless loop for a landing page or README | [loops](references/loops.md) | `screenstudio://loops` |

`screenstudio://coverage` maps every Screen Studio command to its tool or op; `screenstudio://compatibility` lists the supported builds.
