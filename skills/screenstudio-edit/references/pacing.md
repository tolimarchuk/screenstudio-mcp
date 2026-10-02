# Pacing

These rules are encoded in `screenstudio_plan_edit` and `screenstudio_check_pacing`. They come from Screen Studio 4's own auto-zoom behaviour and spring presets (read from the app), Screen Studio's guides, and open auto-zoom planners that measured what viewers tolerate.

## Speech sets the pace

When someone talks, their words are the timeline. Never cut inside a phrase or speed up speech. Trim the silences between phrases to a breath (`tightenPausesMs` 250–400), drop "um" and "uh" when asked, and let screen actions happen under the words. A talking video with no pauses to trim stays at its natural length; that is fine.

## Neither too fast nor too slow

Too slow is as real as too fast: long holds after every action, narration that waits on the screen, a wide shot lingering after the point is made. Default to the balanced style; use calm only for docs and tutorials where viewers follow along step by step.

## Why edits feel too fast

The most common failure is an edit that crams many short zooms and speed ramps into a few seconds. Picture 30 seconds of footage cut to 12, every clip sped up 1.2–1.8x, six zooms on screen for 1–2 seconds each with under a second of wide shot between them. That is nearly 30 zooms a minute. Every zoom spends most of its time moving, the cursor races through clicks, and the eye never settles.

## Zooms

| Rule | Value | Source |
| --- | --- | --- |
| Group clicks into one zoom when they are less than this far apart | 5.3s (Screen Studio: 300ms before + 2.5s after each click, gaps under 2.5s merged) | Screen Studio 4 app |
| Minimum on-screen zoom | 2.5–3s; Screen Studio's auto-zooms are never under 2.8s | App, OpenScreen planner |
| Wide shot between zooms | ≥ 2.5s, else merge into one follow zoom or drop the weaker | App, OpenScreen planner |
| Zooms per minute | 2 (calm) to 3 (snappy), never more | OpenScreen measured 7.6 → 2.1/min as the fix for "too many zooms" |
| Opening and ending | Wide for the first ~2.5s and the last ~1.5s | OpenScreen planner |
| Depth | Deepest of 1.25 / 1.5 / 1.8x that keeps every target inside a 12% margin; 2x only for one tiny target on a sharp source | OpenScreen, Screenify |
| Lead | Arrive 0.5–0.6s before the first click | App (300ms), "start animation early" adds 350ms |
| Hold | 1.5–2s after the last click; longer when there is text to read | Screenify |
| Don't zoom | Scrolling, navigation, page loads, modal open/close, big layout changes | Screen Studio guides |
| Loupe | A detail under ~10% of the frame where surrounding context matters | Screen Studio 4 |

A `follow` zoom (`follow-click-groups`) stays zoomed and pans between clicks; that is how one zoom covers a cluster of actions. A manual zoom holds a fixed target.

## Springs

| Preset | Stiffness / damping / mass | Feel |
| --- | --- | --- |
| Schema default | 125 / 12 / 1.5 | Snaps in ~0.2s. Avoid. |
| Screen Smooth | 170 / 50 / 3 | Glides in ~0.9s. Default for demos. |
| Screen Focused | 250 / 40 / 2.25 | Settles in ~0.4s, for snappy clips. |
| Cursor Smooth | 470 / 70 / 3 | Calm cursor. |
| Cursor Medium | 340 / 60 / 3 | Balanced cursor. |

Screen Studio forces a spring faster when a zoom is shorter than its settle time, which is another reason short zooms feel jerky.

## Time

| Rule | Value |
| --- | --- |
| Clicks and cursor travel | 1x. Up to 1.25x only for a snappy social clip. |
| Typing | 1.5–2.5x. Sound mutes above 2x. |
| Waiting / loading | 2–4x, or cut. |
| Sped-up stretch on screen | At least ~1.2s, otherwise it flashes by; cut or slow it. |
| Before an action | 0.5–0.9s of stillness so the viewer sees where the cursor is going. |
| After an action | 1.1–1.8s for the result, plus ~0.3s per new word of text to read. |
| Final result | 2–3s hold. |
| Cuts | About one per 10s for calm and balanced edits; snappy (social, launch) cuts on every beat, about one every 3–4s. Pauses shorter than ~1.2s stay in; a cut must earn its jump. |
| Length | X teaser under 30s, X post under 45s, landing page 45–90s, docs 2–3 min. |

## Cut checks

- `choppy` counts scene cuts only. Jump cuts that trim a pause or filler inside a talk don't add to it.
- `jumpy-talk` warns when a talking video has more than 3 jump cuts per 10s. It is a warning only; spread the trims or keep a few pauses.
- `stop-click` means the video still shows the click on Screen Studio's stop button at the end. Trim the tail before it.

## Cursor and style

- Hide the cursor after 1.5s still; stop its motion 0.8s before the end; keep remove-shake at 500ms.
- Turn off smooth cursor movement for slices with dropdowns or menus if the cursor lags the UI.
- Padding 0.06–0.10, 16:9 for desktop and X, 1:1 or 4:5 for mobile-first clips.
- Keep `output.avoidEmptyZoomArea` off. When the recorded window's shape differs from the output (a 16:10 window in a 16:9 video), it magnifies the screen to fill the frame and pans with the cursor, cropping the top or bottom of every wide shot. Check the opening frame after changing the aspect ratio.
- Export 1080p at 60fps for X; 4K only from a 4K source.
- Motion blur helps once springs are calm; it exaggerates fast moves.

## Sources

- Screen Studio 4 app bundle (auto-zoom grouping, spring presets, defaults)
- screen.studio/guide: auto-zoom, manual zoom, animations, cursor, speeding up the video, speed up typing segments, export settings
- screen.studio/changelog (4.0.0)
- OpenScreen auto-zoom planner: github.com/getopenscreen/openscreen/pull/873
- Screenify: screenify.studio/blog/2026-04-10-auto-zoom-screen-recording
