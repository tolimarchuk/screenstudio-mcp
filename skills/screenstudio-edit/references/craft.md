# Craft: every Screen Studio element

Screen Studio makes any recording look expensive, and it is easy to overdo. Every effect should help the viewer see or hear one thing. If you can't say what an effect is for, leave it out. Vary the look from video to video: match it to the content, the brand and the person on camera, not to the last video you made.

Timing rules live in [pacing](pacing.md) (`screenstudio://pacing`), voice-over in [narration](narration.md) (`screenstudio://narration`). `screenstudio_catalog` lists everything settings can point to; `screenstudio_editor_state` with `includeConfig` shows every setting; any of them can be changed with a `config` op.

## Start clean

When asked to start from scratch, clear the timeline tracks (`clearTrack` layouts and masks, `clearZooms`) and set every setting you rely on explicitly in one `config` op, rather than inheriting whatever the project had. Edit a duplicate so the original stays intact.

## Frame: crop, aspect, padding, backdrop

- **Crop** (`crop.rect01`) away what the viewer should not see: the macOS menu bar (y ≈ 0.025 on a display recording), a dock, a second monitor's edge, private sidebars.
- **Aspect**: 16:9 for X, YouTube and landing pages; 1:1 or 4:5 for mobile-first feeds; 9:16 only when the content is built for it.
- **Avoid empty zoom area** off. On, it fills the frame by magnifying and panning whenever the recording's shape differs from the output, cropping every wide shot.
- **Padding** 0.04–0.08. Less for phones, more for a framed, editorial feel.
- **Backdrop** (`styles.background`): pick from the catalog's wallpapers (`systemName: "Sunset/sunset-4.jpg"`), a gradient, a solid color, or an image. Choose it for the video, not by habit:
  - echo a color from the product or the person on camera (warm wallpaper for warm clothing or lighting, cool for a blue brand);
  - dark UI on a light, soft wallpaper reads clearly; a busy wallpaper behind a busy UI does not;
  - background blur 0–20 if the wallpaper competes.
- **Window styling**: corner radius 12–20, shadow 0.3–0.6. Device frames (`device.frameKey`) suit mobile recordings and app-store style shots; skip them for desktop walkthroughs with a camera.

## Camera

Five layouts. The default (`defaultLayout.type`) can be `cutout-camera`, `camera-overlay` or `split-screen`. Any of the five, including `fullscreen-camera` and `screen-only`, can cover a stretch on the layouts track (`addLayout`). For a whole-video screen-only or camera-only look, add one layout stretch covering the full timeline.

| Layout | Use it for |
| --- | --- |
| `cutout-camera` | The person cut out from their background, standing over the screen. Best for a talking demo. Size 0.55–0.65 at the right or left edge (`cutoutCameraPositionX01` 1 or 0), shrinking to about 0.5 during zooms (`cutoutCameraZoomedScale`). Larger than ~0.7 covers the content. |
| `camera-overlay` | A rounded camera bubble in a corner; quieter than cutout. |
| `split-screen` | Person and screen side by side; good for a conversation-style explanation. |
| `fullscreen-camera` | Only the person. Bookend a video with it: an intro line before the screen appears, a sign-off at the end. |
| `screen-only` | Hide the person for a stretch where the screen needs all the attention. |

Put the person on the side away from the content they are showing. Change layout on a sentence boundary, never mid-word, and at most every 5–10 seconds.

Camera look: face tracking on for cutout; `edgeFalloff01` 0.3–0.5 for a soft cutout edge; a LUT at 0.3–0.5 intensity rather than full; light sharpen (0.1–0.2) and grain (≤ 0.05); background blur for the fullscreen and overlay layouts when the room is busy.

## Zoom and glass loupe

- **Camera zoom** for something the viewer must read that is too small wide: a field being typed into, a chat thread, a value that changes. 1.4x for a region, 1.6–1.8x for one control. Frame the region, check the frame, and end before the screen changes.
- **Zoom position is manual.** Give every zoom a fixed `target` on what matters (x, y 0–1 in the cropped frame). `follow: true` (Screen Studio's Auto) chases the pointer; use it only when the pointer itself is the subject: a drag, drawing, a long scroll. Clicking between things is two manual zooms back to back (the second starts where the first ends), never one zoom re-aimed or left to follow. A manual zoom holds one position; to move, add the next zoom.
- **The camera shifts the framing.** Screen Studio puts a manual target at the middle of the area the camera does not cover, not at the frame center. With a cutout or overlay camera on the right, the target lands left of center and the view slides right; with the camera centered, it lands beside the camera. Aim at the subject and check the frame with `screenstudio_editor_frame`; if it must sit dead center, hide or move the camera for that stretch.
- **Glass loupe** (`presentation: "loupe"`) for a block of text, a table, a list or a picker, where the viewer needs the detail and where it sits. 1.6–2x, radius 0.3–0.35, fixed target on the content, 4–6 seconds, while the voice names what is inside it. A loupe is a lens over a still frame, so it can sit closer to a camera zoom than two camera zooms can sit to each other. Two or three per video.
- Alternate: wide, loupe, wide, zoom, wide. Never two of the same effect back to back.

## Masks

- `sensitive-data` blurs what must not be seen (emails, keys, customer names) for the whole stretch it is visible. Cover generously and check every frame of the stretch.
- `highlight` dims everything except a region: a quiet way to direct attention without moving the camera (a notifications column, one card). Opacity 0.85–0.9 to be noticeable; 0.5 barely shows.

## Captions

Captions come from the transcript (`screenstudio_transcript_generate`, on-device). Fix misheard names with `screenstudio_transcript_edit` before styling.

- **Reveal:** `line-by-line` with `wordEntrance: fade-in` keeps the whole line on screen; use it for readable captions. Screen Studio's own `word-by-word` shows only one word at a time in this build: punchy for a short social hook, hard to read for anything longer.
- **Size** 0.04–0.05 of the frame height for desktop, 0.055–0.065 for phone-first.
- **Position** bottom centre (`position01` y 0.92–0.94) by default; move up or to the side if the camera or key UI sits there.
- **Background** black at about 70% (`#000000b3`), white text, sans-serif.
- **Keyboard shortcuts** (`enableShortcuts`) show keycaps when the recording used shortcuts; turn them on for tutorials.

## Cursor and clicks

- Cursor set from the catalog (`cursor.set.id`), size 48–64 for a 1440-point capture, larger for a full display.
- Hide when still after 1500ms (2500ms under narration), stop movement 0.8s before the end, remove shake 500ms.
- Ripple click effect for demos; none for docs. Click sounds only with a ripple, at 0.2–0.35.
- Per clip: `hideCursor` for a stretch where the cursor distracts; `disableSmoothMouseMovement` for menus where smoothing lags the UI.

## Sound

- **Voice** on camera: microphone preset `voice` or `podcast`, recording-quality improvement 0.5–0.7. Keep clip volume at or below 1; above 1 breaks Screen Studio's audio mixing on export.
- **Music**: one library track chosen for mood (lo-fi for casual builds, commercial for product demos, instrumental for tutorials). Volume about 0.06–0.12 under a voice, up to 0.2 for a silent demo (`screenstudio_music` defaults to 0.08).
  - Narrated video: pass `music` (with `musicVolume`) to `screenstudio_narrate`. Music added later with `screenstudio_music` is mixed under the voice; `music: null` on `screenstudio_narrate` removes it.
  - Silent video or recorded voice: `screenstudio_music`, ducked under transcript speech.
- **Narration** when there is no recorded voice: see [narration](narration.md).

## Motion

Screen spring Smooth (170/50/3) or between Smooth and Focused (about 200/45/2.5); cursor Medium (340/60/3). Motion blur 0.4–0.6.

## Finished looks

`screenstudio_plan_edit` accepts a `look` (wallpaper, gradient, dark, light, minimal, social) as a starting point for the frame. None is a default. Pick one that suits the video, then change the backdrop, camera and captions to fit.

## Before delivery

`screenstudio_check_pacing` reports timing and visual settings together: zoom rhythm, mid-phrase cuts, sped-up speech or clicks, frame cropping, cursor flicker, loupe depth and overuse, loud clicks, heavy blur. Then look at real frames: the opening, every layout change, each zoom and loupe at its midpoint, each mask, each cut and the last second. Read the captions in those frames.
