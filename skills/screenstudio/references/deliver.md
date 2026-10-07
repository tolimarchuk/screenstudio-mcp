# Deliver the finished video

Deliver a playable file, its duration and dimensions, and an honest note on anything still off.

Before rendering anything that will be published, run `screenstudio_find_sensitive` and apply its blur masks ([privacy](privacy.md), resource `screenstudio://privacy`): keys, emails and customer data on screen must not ship.

1. **Pacing check.** `screenstudio_check_pacing` on the project. Fix every error and every `fill-crop` or `cursor-flicker` warning before rendering; a render does not fix them.
   Read the plan's director's notes (`notes` from `screenstudio_plan_edit`): each cut, speed-up, zoom and hold at its playback time with the rule behind it. They are what to check in the pictures and what to tell the person when they ask why.
2. **Pick the format.** With a recipe, its `targets` and `export` settings are the starting point; pass the same `recipe` to `screenstudio_export_variants`. X: 1080p, 60fps, 16:9 (1:1 for mobile-first), under 45s. Landing page: 1080p60, 45–90s. Docs: 1080p30 is fine, 2–3 min. GIF: keep under ~15s. 720p renders fast for drafts. 4K only from a 4K source. `height` is always the frame's short side: 1080 renders 1920x1080 at 16:9 and 1080x1920 at 9:16; the tools ask Screen Studio for a portrait frame's full height themselves.
3. **Render.** `screenstudio_export_start` renders exactly what the open editor shows, including unsaved edits. If no editor has the project open, it renders the saved project; the result's `source` says which (`live` or `disk`). Use a fresh output path. It waits for the render and returns the delivered file; never end your turn before it does. With `wait: false` it returns a job to poll with `screenstudio_export_status`. For more than one destination, `screenstudio_export_variants` renders every target in one call with posters, captions, chapters and a manifest; see [variants](variants.md) for each target's limits.
4. **Check the file.** Duration matches the edited timeline; dimensions match the aspect ratio with the short side at the asked height (1080x1920 for a 1080 vertical); no audio unless intended.
5. **Check the pictures.** `screenstudio_contact_sheet` first (the edit's key moments in one grid, or `jobIds` for finished exports), then `screenstudio_export_frame` for a close look at any moment that needs it. Go through the review below.
6. **Listen** when there is narration or music: voice clear and on its moments, music under it, a quiet tail.
7. **Save** with `screenstudio_editor_save` if anything changed since the last apply (undo, restore, narration or music), so the project matches the video.
8. **Report** the file with a link or attachment and a one-line description. Publishing or sharing is a separate step that follows the person's request.

## Review

- The opening frame shows where we are, wide, for about two seconds.
- Each action and its result are both visible and on screen long enough to read.
- The cursor moves at a followable speed; no click plays faster than 1.25x.
- Zooms are few, long and land on the action; no zoom-out-zoom-in within a few seconds.
- Text stays legible at the final size; the cursor or loupe never covers the key detail.
- Cuts keep cause and effect; waiting is shortened, not mistaken for progress.
- Captions match speech and avoid essential controls.
- Camera, background and audio match the request.
- No secrets, unrelated windows, notifications or real customer data.
- The last frame is a settled result held for 2–3 seconds, not a mid-click.

## Loops

For a landing page hero or a README demo that plays on repeat, `screenstudio_loop` finds a stretch whose last frame matches its first and renders MP4, WebM and GIF from a copy of the project. See [loops](loops.md) for how it chooses and the embed snippet.

## When an export fails

Read its status and reason; retry only after fixing the cause. If a request times out, poll the same job. Job metadata survives a server restart; the app's renderer state does not survive an app restart.

Exports render into Screen Studio's local QA folder to avoid a save dialog, then deliver the file to the requested path without ever overwriting an existing file.
