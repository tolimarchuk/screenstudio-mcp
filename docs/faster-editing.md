# Faster editing in the current window

The fastest route to a good edit is fewer decisions and fewer round trips before the first useful change. Work in the current window, preserve the person's adjustments, understand the footage once, then apply one coherent edit. Keep the final visual and audio review.

## Changes made

| Problem | Change | Quality check |
| --- | --- | --- |
| Editing began by copying the project | The current window is now the default. A copy requires the person to ask for one. | Select the focused editor; refuse to guess among several unfocused editors. |
| Shared guidance repeated detailed workflows | Keep shared guidance short and use the existing skills and resources for detail. | Retain direction, recovery, speech, privacy and delivery rules. |
| Opening context required separate connection, timeline, settings and analysis requests | One initial request returns the existing editor, current settings, timeline and speech/action analysis. Settings-only corrections skip footage analysis. | Include the current edit generation so an older plan cannot overwrite a newer adjustment. |
| Every edit animated sidebar controls and paused between steps | Apply the batch directly by default. Step animation remains available for demonstrating the editing process. | Use the same editor model, undo history, pacing check and final rendered review. |
| A manual adjustment could land while an edit batch was waiting | Stop the batch when the project changes. | Preserve the person's adjustment and inspect the current state before continuing. |
| Later nested settings could restore values from the start of a batch | Prepare each change against the preceding changes in that batch. | Test multiple updates to the same nested setting group. |
| A missing optional camera crop was rejected | Initialize the known crop field through its existing rectangle rules. | Reject invalid rectangles and unrelated unknown fields. |
| Reading captions before they existed failed | Return an empty transcript. | Generate speech timing before cutting a talking recording. |
| A successful call could hide a setting the app ignored | Compare requested settings with the resulting model. | Stop and report the differing setting. |
| A preview could be captured after a manual scrub or edit | Check the requested time and project generation before and after the screenshot. | Refuse a moved preview instead of presenting it as the requested moment. |

## Editing sequence

1. Read the current window and footage together. For a small styling correction, read settings only.
2. Generate captions when missing. Inspect three to six source frames together: opening, action, result and ending. Read individual word timing only for caption corrections or precise speech cuts.
3. Pick the cuts and framing. Keep requested camera placement, essential buttons and sentence boundaries. Use recipes only when they help the requested outcome.
4. Apply one batch containing cuts, zooms and styling. Inspect its pacing result and a contact sheet.
5. Correct only what the inspection reveals. After a manual adjustment, refresh the current settings and preserve them.
6. Export once framing is settled. Check the actual delivered captions, controls, joins and ending; listen to speech across the cuts.

This removes an initial copy, an unnecessary open, separate context reads, and animated delays. It also avoids repeated full inspections after a one-setting correction. It does not remove the checks that establish whether the edit works.

## Measurements and priorities

On one connected Mac, selecting the current editor took 224 ms; three live state reads took 125, 121 and 122 ms. A preview capture with the new time checks took 1,989 ms. A separate same-process comparison took 88 ms for a combined settings read and 170–185 ms for two separate reads. Analysis took 1,252 ms on the first call in that process and 82 ms on the next cached call; the first call may reuse an existing disk cache. These are single-session observations, not a before/after speed claim or a promised target. The included measurement script reads the existing project without changing its settings or playhead and can compare a combined settings read with two separate reads, plus cold and cached analysis.

The old animated path adds 45% of the step interval for each config field and 60% for each group. With a 350 ms step, 40 fields across 10 groups add about 8.4 seconds before timeline animation, app calls or agent reasoning. Direct application removes those intentional waits while retaining the edit and its checks.

Suggest: ship the current-window and direct-application changes first, because they remove unnecessary work and prevent the mistakes that caused repeated corrections.

## Further work, in priority order

1. **Make preview readiness come from the renderer.** A fixed 700 ms wait cannot prove that the screen, camera and captions have finished drawing, even if the playhead is correct. Hidden editor windows stop their animation callbacks, so waiting on those callbacks broke real capture during investigation and was removed. Add a rendering completion signal, compare preview frames with exported frames, and test unchanged-time previews after config changes. This is the highest remaining quality issue.
2. **Measure time to the first useful edit.** Record stage durations and request counts without recording speech, screen text or project names. Separate agent decision time, analysis, caption generation, application and review. Compare the old sequence with the new sequence on the same footage and destination before making speed claims.
3. **Read footage, speech and microphone levels concurrently.** The initial context already reads live state and analysis together; within analysis, screen activity, fresh speech and microphone levels are still collected in sequence. Run the independent stages together and share in-flight analysis between concurrent callers. Retry failed stages and keep speech fresh after caption edits.
4. **Reuse the editor connection after measuring its value.** Each evaluation currently locates the renderer and opens and closes a connection. The measured state-read overhead was small relative to preview and animated delays, so this comes later. A reusable connection must detect app restarts, reject uncertain writes and avoid replaying mutations automatically.
5. **Review affected moments only.** Capture the opening, cut joins, zooms, changed camera framing and ending in one pass. Keep a record of the inspected project generation so a manual change invalidates only the affected review. The final export still needs its own check.
6. **Move less routine text through the agent.** Keep tool summaries focused and put detailed editing guidance in the skills and resources. Return concise plan summaries by default, with word timing and full director notes available on demand. Measure whether the client repeats shared server instructions across discovered tools before changing descriptions.
7. **Protect speech when analysis fails.** A missing transcript is different from a failed transcript read. Surface that distinction rather than silently treating an error as no speech. A talking edit should stop speech-dependent cuts until timing is available.
8. **Make composition constraints part of planning.** Let the person pin camera side, crop and size, and identify essential controls. Check captions against those controls in both wide and zoomed frames. Camera size should grow gradually from the actual source crop rather than jump to the largest legal setting.

Suggest: tackle renderer readiness next, because unreliable previews create rework and weaken every visual decision that follows.

## Delivery status

The source changes and installed editing guidance are updated. The running connection still uses the installed package, so new server behavior needs a package update and a fresh client connection. Publishing a release is a separate step.
