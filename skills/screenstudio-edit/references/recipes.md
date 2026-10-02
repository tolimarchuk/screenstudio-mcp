# Recipes

A recipe is one word for a whole direction: pacing style, frame, aspect, plan options, captions, cursor, click sound, music, voice and export settings that agree with each other. Pass it as `recipe` to `screenstudio_plan_edit`; `screenstudio_recipes` lists them with when to use each, or returns one in full.

None is a default and none is applied unless you name it. Pick by the content and where the video will be watched, not by what the last video used. When nothing fits, skip recipes and set style, look and aspect yourself.

## How a recipe applies

- It seeds `style`, `look`, `aspect` and plan options (`maxZooms`, `targetMs`, `structure`, `tightenPausesMs`, `removeFillers`, `speedUps`, `talkingHead`, `markers`). Any argument you pass explicitly wins.
- Its pacing rule overrides (for example shallower zoom levels, a longer final hold, slower typing) shape the plan and the pacing check that judges it.
- Its config lands in the plan's `config` op after the style and look settings: captions, cursor, click effect and sound, and any frame changes. A different look (an explicit `look`, or `recipeOverrides.look`) replaces the recipe's frame (backdrop, padding, corners, shadow) while its other settings stand; `look: "keep"` keeps the project's own frame. The notes describe what the plan applies and say when your argument or a brand replaced the recipe's choice. `screenstudio_editor_apply` checks every key against the project before anything changes.
- The result's `recipe` field carries what the editor cannot set: `music` (pass the track, volume and `duckTo` to `screenstudio_music`, or the track as `music` to `screenstudio_narrate` when voicing), `voice` (the `voice` and `rate` for `screenstudio_narrate`), `export` (height as the short side of the frame, fps and format for `screenstudio_export_start`) and how it treats the glass loupe.
- `targets` names where the video usually goes, as `screenstudio_export_variants` targets. Pass the same `recipe` to `screenstudio_export_variants` and it renders those targets (unless you name your own) with the recipe's frame rate on every video and its resolution on targets in its own aspect.
- `brand` names a saved brand kit (`screenstudio_brand`). Built-in recipes name none; set it with `recipeOverrides: { "brand": "<name>" }`, or pass `brand` to `screenstudio_plan_edit`. Only the brand's own colours, captions, cursor and sound land after the recipe's config (its starting look is left out, so it never undoes the recipe's cursor, clicks or frame). Its voice and music replace the recipe's where the recipe has them; a recipe without voice or music keeps it that way, and the notes offer the brand's. `screenstudio_recipes` takes `brand` too and shows the result.
- `recipeOverrides` changes parts of it: `{ "plan": { "targetMs": 20000 }, "config": { "captions.enableTranscript": false }, "music": null }`. Objects merge field by field; unknown fields are refused.
- Pass the same `recipe` (with any `recipeOverrides` and `brand` you planned with) to `screenstudio_check_pacing` or `screenstudio_editor_apply` to judge by its rules and flag settings that work against it (`off-recipe`): a click ripple or click sound under a recipe that keeps clicks quiet, captions revealed with a different energy.

## The recipes

**keynote.** For a product moment on a big screen or a launch page. Calm pacing lets each result land; zooms stay shallow (1.4x and 1.25x) because a big screen already makes text large, and deep zooms there feel like a lurch. A near-black gradient with generous padding and a deep shadow makes the app float. No click ripple and no click sound: on stage the voice carries the action. Line-by-line captions fade in low in the frame. The glass loupe is preferred for detail because it magnifies without moving the camera. Documentary-style instrumental music sits far under a warm, confident voice.

**social-vertical.** For a phone-first clip in a vertical feed. Snappy pacing and a 30-second target, structured hook, demo, payoff so the best moment is offered as a cold open. A large cursor and a ripple with a quiet click sound make every action visible on a small screen. Captions fade in line by line, larger, at two thirds of the height so they clear the platform's own controls at the bottom. Line by line, because Screen Studio's word-by-word reveal shows one word at a time, too little to read at feed speed. Loupes are avoided: their detail is too small on a phone, a camera zoom reads better. Upbeat electronic music and a cheerful voice slightly faster than normal. Export is 1080p on the short side, a 1080x1920 frame.

**changelog.** For one shipped feature in a release note or a post. Balanced pacing with a 45-second target and at most two zooms, on exactly what changed. A minimal dark frame and no captions keep it quiet, because the post's text already explains it. No click effects. Soft lo-fi music, no voice. Exports go to x and linkedin; for a looping GIF, cut one with `screenstudio_loop`, since the GIF target's 15-second limit is shorter than the edit.

**founder-talking-head.** For someone on camera talking through their product. The speaker's own voice sets the pace: pauses tighten to 350ms, fillers go, nothing is ever sped up. The camera director plans layouts (see [story](story.md)): the person cut out beside the screen by default, full screen for the opening line and the sign-off, screen only while a zoom asks the viewer to read. Face tracking and a soft cutout edge. Line-by-line captions sit just above the bottom edge. Light lo-fi music far under the voice; no narrator, since the person is the narrator. Exported at 30fps, which matches camera footage.

**tutorial.** For teaching a task step by step. Calm holds so each result can be read and copied, fillers removed, pauses tightened to 400ms. Shortcuts appear on screen so viewers learn the keys, not just the clicks. A chapter per marker, so a long tutorial can be navigated. A light frame and a friendly, expressive narrator; no music, which competes with instructions.

**launch-teaser.** For a 20-second teaser before a launch. Snappy pacing, only the beats worth most, the payoff saved for last with a longer final hold and offered as a cold open. A bright warm-to-violet gradient, a ripple and a click sound for energy, music with lift and an upbeat voice. No captions: on-screen text is the post's job.

**docs-walkthrough.** For a silent clip embedded in documentation. A plain light backdrop with small padding and a soft shadow sits on a docs page without fighting it. Typing plays slower (up to 1.5x) so readers can copy what is typed, and every shortcut shows on screen, single letters included. No captions, music or voice: docs clips autoplay muted. The loupe is preferred for settings tables and code. For a looping GIF of one step, cut it with `screenstudio_loop`; the walkthrough itself runs longer than a GIF's 15 seconds.

## Choosing

| Watching on | Talking? | Recipe |
| --- | --- | --- |
| A stage, a launch page | Narrated | keynote |
| A vertical feed | Either | social-vertical |
| A release note, a post | Silent or music | changelog |
| Anywhere, with a face on camera | The person talks | founder-talking-head |
| A help center, a course | Narrated | tutorial |
| A post before launch day | Music, maybe a voice | launch-teaser |
| A docs page | Silent | docs-walkthrough |

A recipe is a starting point. Change what the content asks for, then look at real frames.
