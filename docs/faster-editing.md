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

## Live comparison, October 3

Compared the installed 0.5.3 handlers with this checkout's handlers in the same open editor. Both used their schema defaults, the same nine-setting batch and the same preview check. Eight settings-read pairs and three edit pairs alternated order to reduce warm-app bias. The editor was brought forward for the final run.

| Stage | Installed median | New median | Improvement |
| --- | ---: | ---: | ---: |
| Read timeline and settings | 169 ms | 83 ms | 2.0× |
| Apply nine settings and check pacing | 2,339 ms | 392 ms | 6.0× |
| Capture and check a preview | 1,750 ms | 1,795 ms | Similar |
| Apply and capture together | 4,089 ms | 2,182 ms | 1.9×, 47% less time |

Edit times ranged from 2,330–2,345 ms installed and 387–402 ms new. Both paths retained the pacing check. Every trial compared the complete resulting settings and timeline against the expected edit, including unchanged camera size, crop, cuts, zooms and layouts. Preview inspection showed the changed background and the essential controls with the existing shoulder crop. Original settings and playhead were restored and saved after the test. No project copy was created.

These measurements cover a settings correction in a warm, connected app. They exclude agent decision time, footage analysis, caption generation, file saving and export. The settings comparison starts with a known project path; it does not time window discovery. The new default removes sidebar animation delays, so most of the gain comes from applying the same batch directly. The installed version can also use direct application when requested.

An initial run while the editor was behind another window returned unchanged preview pixels despite correct live settings. Bringing the editor forward made the changed background appear. This confirms that generation and playhead checks alone cannot establish preview freshness. The repeatable comparison now checks that a color-background edit actually changes the captured image. A renderer completion signal remains the next quality improvement.

The repeatable comparison is `scripts/compare-edit-latency.mjs`. Pass an installed package directory as its first argument; it measures settings reads by default. Add `--edit` to temporarily apply and restore styling and capture both results. Keep the editor visible and paused. Screen content and project names stay outside the report.

## Full edit replay with both modes

A second comparison reset the existing editor to the first pre-edit checkpoint before each run, with the full 138.231-second timeline, original automatic zooms, full camera frame and caption display off. Both runs started at 0:00 and applied the same prepared edit: clear automatic zooms, apply 38 changed settings, keep five source ranges at normal speed, and add one manual zoom. The resulting video was 106.052 seconds long, using the approved camera size and shoulder crop.

| Stage | Visible steps, 350 ms interval | Direct application |
| --- | ---: | ---: |
| Apply full batch and check pacing | 14,975 ms | 401 ms |
| Focus editor and capture five moments | 7,604 ms | 7,606 ms |
| Apply and review together | 22,579 ms | 8,007 ms |

Direct application took about 37× less time for the batch, and about 65% less time including the same visual review. This is one paired full replay, not an average across recordings. Both used the new build. Planning, existing transcript generation, reset, final save and export were outside the timers. The comparison tests replaying the prepared edit rather than deciding a fresh edit.

Both results matched the approved settings and timeline after excluding generated item ids. Both pacing reports were good with no issues. Five captured moments covered the opening, a cut, the zoom, the main result region and the ending. The captions and call controls remained visible with the approved camera framing. The editor was left saved at 0:00 with the approved edit, in the same project.

This replay exposed the more precise preview condition: activating the app alone did not focus the editor window, and all requested times could return the opening image. Focusing the existing editor window before capture produced distinct, correctly timed frames. The completed comparison rejected repeated opening images and used that focus step in both modes. The capture implementation should incorporate editor focus and a renderer completion signal; app activation and model timestamps alone are insufficient.

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
