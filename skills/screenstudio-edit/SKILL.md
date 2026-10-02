---
name: screenstudio-edit
description: Edit a video already in Screen Studio, live in the open editor, following the person's own direction - cuts and speed, camera zooms and the glass loupe, camera layouts including cutout camera, crop, backdrop, masks, transcript captions, cursor, music and narration. Reads the footage (clicks, typing, speech, screen changes), plans the edit, checks pacing and visual settings, and verifies rendered frames. Recipes are optional presets. Use for "edit my video", polishing any recording, re-cutting an edit that feels too fast or too slow, or adapting a video to a destination.
---
# Edit a Screen Studio demo

Follow the person's direction in their own words: any cut, zoom, layout, look or sound they ask for. The planner and recipes fill in what they leave open.

The viewer should always know where to look and have time to see what happened. Good Screen Studio edits feel calm: real-time clicks, short pauses removed, typing and loading sped up, and a few long zooms that pan between actions instead of popping in and out.

Read [craft](references/craft.md) (resource `screenstudio://craft`) before styling anything: it covers every element (crop, backdrop, camera layouts and cutout, zoom, glass loupe, masks, captions, cursor, clicks, sound, motion) with ranges that look finished and the ways each one goes wrong.

Edit in the open editor window. By default `screenstudio_editor_apply` runs in show mode: the editor comes forward and every step plays out in Screen Studio's own interface, fast enough to film. The playhead jumps to each edit, clips are split and deleted one cut at a time, zooms, layouts and masks drop in selected, and each setting changes with its sidebar panel open. Group related ops into one apply so the sequence reads as one continuous edit; use `stepMs` 250–450 (lower is snappier). Use `show: false` only for bulk background fixes. Never quit Screen Studio or rewrite project files to edit.

Each apply saves the project unless you pass `save: false`. Duplicate first, or pass `save: false` while experimenting. Undo (`screenstudio_editor_history`), `screenstudio_editor_restore`, `screenstudio_narrate` and `screenstudio_music` change only the open editor, so call `screenstudio_editor_save` after them.

## Workflow

1. **Open.** `screenstudio_status`, then `screenstudio_editor_open` on the project. To keep the original intact, `screenstudio_project_duplicate` first and open the copy; every apply saves. Note the editor's current timeline.
2. **Understand the footage.** If there is a microphone, `screenstudio_transcript_read` (or `screenstudio_transcript_generate` when none exists): what is said, when. `screenstudio_analyze` lists every click, drag, typing burst, shortcut, spoken phrase, screen change and idle stretch in source ms. Look at the key moments with `screenstudio_source_frames` (up to 8 at once; clicks are boxed in red). Name the beats: the starting state, each meaningful action, each visible result, the ending.
3. **Decide what matters.** What is the one outcome this video shows? Which beats are setup, detours or mistakes? Use `drop` spans for detours, `keep` spans for results the planner might trim.
4. **Plan.** `screenstudio_plan_edit` with the destination `aspect`, an optional starting `look`, `tightenPausesMs` for talking videos, and a style: `balanced` by default, `calm` for docs and tutorials, `snappy` for short social clips. Read its `pacing` and `currentPacing` reports. Adjust keep/drop/maxZooms and re-plan rather than hand-editing numbers.
   Recipes are optional presets that set a whole direction in one word: pass a `recipe` only when one fits (`screenstudio_recipes` lists them; none is a default, see [recipes](references/recipes.md), resource `screenstudio://recipes`). For a length, pass `targetMs`; for a talking head, `talkingHead: true`. Read the plan's `notes` (each decision at its playback time) and `droppedBeats` before applying; [story](references/story.md) (resource `screenstudio://story`) covers beats, fit to length, markers and the camera director.
5. **Apply live.** Pass the plan's `ops` to `screenstudio_editor_apply`. Keep the returned checkpoint. Read the pacing report it returns; fix every error.
6. **Shape it by hand.** Camera layouts for intro, demo and sign-off (`addLayout`); masks for anything private or worth highlighting (`addMask`); crop, backdrop and captions (`config`); then the moments that need magnifying. One screen zoom where text must be read, a glass loupe (`presentation: "loupe"`, 1.8x, fixed target) on a table, list or picker. Two or three a minute, never more than three, never back to back.
7. **Look at the result.** `screenstudio_contact_sheet` shows the opening, each cut, each zoom's midpoint and the ending in one labelled grid; use `screenstudio_editor_frame` for a close look at any one moment. Check: the zoom target is centered on the action, text is legible, nothing important is cropped, no private data shows.
8. **Refine one thing at a time** with `updateZoom`, `removeZoom` or a new `setSlices`. Re-run `screenstudio_check_pacing` after changes. `screenstudio_editor_play` a range so the person can watch it.
9. **Narrate** when asked for a voiceover: write one short line per beat (about 2.8 words a second), in the person's voice. Never credit the agent or AI in a line, caption or end card. Best path: record each beat with `screenstudio_desktop_perform` `markers: true`, plan with each line's `beatMs` as `markerBeatsMs`, then call `screenstudio_narrate` with `pinToMarkers: true` so each line lands on its beat. Without markers, pin each line with `sourceMs` (about a second before the beat's first click or typing burst from `screenstudio_analyze`) and pass the narrated spans as `keep` to `screenstudio_plan_edit` so a still screen under narration is not cut as dead air. Either way use `speedUps: false`. For music under the voice, pass `music` (for example `commercial/Product Uplift`) to `screenstudio_narrate`; music added later with `screenstudio_music` is mixed under the voice, and `music: null` on `screenstudio_narrate` removes it. Fix every warning (a line running into the next means the beat needs more hold). After changing the cut, call it again without lines to re-sync.
   Read [narration](references/narration.md) (resource `screenstudio://narration`) first.
   For a brand's colours, captions, cursor and sound, apply their saved brand with `screenstudio_brand`; read [brand](references/brand.md) (resource `screenstudio://brand`).
10. **Blur private text.** `screenstudio_find_sensitive` finds keys, emails, phone numbers and other private text in the footage and proposes blur masks; check its preview, then apply. Read [privacy](references/privacy.md) (resource `screenstudio://privacy`).
11. **Save** with `screenstudio_editor_save` if you undid, restored, narrated or added music since the last apply, then deliver with screenstudio-deliver.

## Pacing rules that matter most

Read [pacing](references/pacing.md) (resource `screenstudio://pacing`) before changing anything by hand. The short version:

- **Clicks play at 1x.** Never speed up a stretch with clicks or cursor travel the viewer must follow. Speed up only typing (1.5–2.5x) and waiting/loading (2–4x), and never so much that a stretch flashes by in under ~1.2s.
- **Cut dead air, not actions.** Keep ~0.7–0.9s before an action and 1.4–1.8s after it so the result can be read. Hold the final result 2–3s. About one cut per 10 s for calm and balanced styles; snappy (social, launch) cuts on every beat, about every 3–4 s.
- **Few, long zooms.** At most 2–3 per minute. Each on screen at least 2.5–3s. At least 2.5s of wide shot between zooms, otherwise merge them into one follow zoom that pans. Open wide for ~2.5s and end wide.
- **Zoom where detail matters:** typing into a field, a small control, a value that changes. Not during scrolling, page navigation or a big layout change; end the zoom before the page is replaced.
- **Gentle depth.** 1.4–1.8x. Above 2x text blurs on a normal-resolution source. Loupe for a tiny detail where context matters.
- **Calm springs.** Screen Studio's Smooth spring (170/50/3) for zooms; Medium or Smooth for the cursor. The schema default (125/12/1.5) snaps.

## Ops reference

All times are source ms. `screenstudio_editor_state` and every apply return the timeline with playback times and on-screen durations.

| Op | Use |
| --- | --- |
| `setSlices` | Full ordered list of kept ranges `{startMs, endMs, speed}`. Replaces the scene's slices. |
| `addZoom` | `{startMs, endMs, zoom, follow}` follows the clicks inside it; or `target: {x, y}` (0–1 of the recording) for a fixed focus. `presentation: "loupe"` for the glass loupe. |
| `updateZoom` / `removeZoom` / `clearZooms` | Adjust by zoom ID from the timeline. |
| `addZoom` with `presentation: "loupe"` | Screen Studio 4's glass loupe: magnifies a detail (a table row, a price, a picker) while the rest of the screen stays in place. |
| `splitAt`, `cutRange`, `removeSlice`, `mergeSlices`, `updateSlice`, `resetCuts` | Cut the timeline like the app does: split, delete a range, merge, per-clip speed, volume, cursor. |
| `addLayout`, `addMask`, `duplicateItem`, `setTrackDisabled`, `restoreAutoZooms` | Camera layout stretches, masks, copies, whole-track toggles, Screen Studio's own click zooms. |
| `updateItem` / `removeItem` / `clearTrack` | Change, remove or clear layouts, masks and zooms by ID; `removeItem` and `clearTrack` also take `voiceOvers`. |
| `config` | Dotted keys for any field in the project config (see `screenstudio_editor_state` with `includeConfig`), e.g. `animations.screenMovementSpring`, `cursor.hideNotMovingAfterMs`, `output.aspectRatio`, `styles.background.color`. `screenstudio_status` → `knownSettings` lists the ones with exact range checks; other fields only need to keep their type. |

A zoom that overlaps another fails with a clear error: shorten or remove the neighbour first. Screen Studio clamps zooms to free time; the result reports `trimmed: true` when it did.

## When the person says it feels wrong

- "Too fast": run `screenstudio_check_pacing`; switch to `calm`; remove speed-ups on actions; widen holds via `keep`.
- "Too many zooms": `maxZooms` 1–2, or `zoom: "none"` and add one zoom by hand on the moment that matters.
- "Too slow / boring": `balanced` or `snappy`, drop detours; never fix slowness by speeding up clicks.
- Something looks off in a frame: inspect `screenstudio_source_frames` at that source time before changing the zoom target.

## Recovery

`screenstudio_editor_restore` with an apply checkpoint returns the timeline and settings to that point. `screenstudio_editor_history` steps the app's own undo. Both change only the open editor; `screenstudio_editor_save` writes the result to disk. If the project is not open, `screenstudio_editor_open` it; if Screen Studio has no automation connection, ask the person to quit it and use `screenstudio_launch`.

The coverage resource (`screenstudio://coverage`) maps every Screen Studio command to its tool or op.
