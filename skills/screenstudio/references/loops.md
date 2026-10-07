# Seamless loops

A landing page hero and a README demo play on repeat, so the last frame must flow into the first. `screenstudio_loop` finds that stretch in the footage and renders it for the web.

## How the loop is chosen

1. The planner splits the recording into beats, the same way `screenstudio_plan_edit` does.
2. Every start and end on a beat boundary that gives `targetMs` of playback (4 to 15 seconds) is a candidate. Beats start and end in the pauses between sentences: a lead-in or hold that would land inside a sentence moves to the sentence break. Every distinct pair is compared (up to 200, spread across lengths when there are more), so a matching pair far from the target is still found. Frames are read once per time.
3. When no pair of beat edges matches, the rest of those 200 comparisons go to windows inside a run of beats (one long beat, such as someone typing or talking over the screen the whole time, or a talk split into a beat per sentence). They start and end on clean cuts: sentence breaks (the analysis's sentences, or the punctuation inside each spoken phrase with its words taken as evenly spread), still points of the screen between bursts of activity, and the run's own edges. A cut at a sentence break beats one on a still screen mid-sentence, and either beats a plain `targetMs` from the run's start, the last resort.
4. The recording frames at each candidate's first and last moment are compared (SSIM). A pair at 0.9 or more is a seamless loop; the best pair wins on similarity times closeness to the target.
5. With no matching pair, the loop is whichever comes closest to the target: a single beat held on its settled result (the still screen after it toward the target, never into the next beat or the stop click, then its last second slowed down to 0.25x when it is still under 4s), several beats in a row, or a window. It is never longer than 15 seconds. If its frames match after all, it is seamless; otherwise `seamless` is false and the restart shows a jump. Record the action so it ends back on the starting screen (close the dialog, clear the field) and try again. When the frames cannot be read at all, the notes say so.

The loop's copy then gets:

- the chosen range with the planner's typing and waiting speed-ups,
- the planner's zooms inside it, starting at least 0.5s in and ending 0.8s before the restart, so the last frame is wide like the first,
- the cursor gliding back to its starting point in the last 0.6s, all sound muted, and no fill-crop.

## Where the work happens

The loop is applied to a copy, `<name> Loop.screenstudio` next to the original, opened in the editor; the main edit stays as it was. `apply: false` only plans: it returns the ops, the range and the first and last frames of the raw recording, without copying or rendering.

## What comes back

- MP4 at 1080p60, a silent VP9 WebM, and a GIF under `maxGifBytes` (frame rate then height halved until it fits), as `formats` asks.
- A poster PNG of the first frame.
- The first and last frame side by side. They should look the same; if they do not, the join will show.
- `embed`, ready to paste:

```html
<video autoplay muted loop playsinline poster="demo-loop-poster.png">
  <source src="demo-loop.webm" type="video/webm">
  <source src="demo-loop.mp4" type="video/mp4">
</video>
```

Browsers only autoplay muted video; `playsinline` keeps phones from going full screen. Use the GIF where video cannot embed (READMEs, chat).
