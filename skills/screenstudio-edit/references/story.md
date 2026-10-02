# Story: beats, length, markers and the camera

`screenstudio_plan_edit` treats a recording as a story told in beats. This guide covers how it values beats, fits an edit to a length, reads markers, explains itself, and plans camera layouts for a talking head.

## Beats

A beat is a group of actions close in time: clicks, typing, shortcuts and spoken phrases. Every beat in the plan has:

- `score`: what it is worth to the viewer. Typing +3 each (it is what a demo shows), a click or shortcut +1 each, a page that changes because of it +4, a region of the screen that updates +2, speech +2, the last beat +3 (the payoff), the first +1 (it sets the scene).
- `role`: `setup` for the leading beats that type nothing and change nothing before the first page change, `payoff` for the last beat, `demo` for the rest.
- `label`: the first action and its result, like `click at (0.31, 0.42), page changes`.
- `kept`: false when the beat was dropped or cut.

## Fit to a length

`targetMs` fits the edit to a length, for "a 15-second teaser from this 3-minute recording" or "keep it under 45 seconds". The plan fits when it plays within 5% of the target.

1. If faster typing and waiting (up to the style's cap, never clicks or speech) and, for targets under 30s, shorter holds are enough, those go first: every beat stays.
2. Otherwise the lowest-scoring beats go, never the payoff, a beat inside your `keep` spans, or a marked beat in markers keep mode. Among beats that score about the same, one next to a beat already dropped goes first (one cut instead of two), then the one whose length best matches what is left to cut. A beat whose actions or sentence overlap a neighbour's is never cut in half; it stays. Each dropped beat is listed in `droppedBeats` with its reason, and the loop repeats.
3. When nothing more can go, `fit.fitted` is false with `fit.overshootMs`, and the notes say what is holding it up. A fitted edit that fails its own pacing check (too many cuts close together) also reports `fitted: false`, and the notes say why.

To bring a dropped beat back, pass its span in `keep` and plan again. Recipes with a natural length (social-vertical, changelog, launch-teaser) set `targetMs` for you.

`structure: "hook-demo-payoff"` halves the lead-in of setup beats and returns `coldOpen`: the payoff's settled result, 1.8s after its last screen change, inside the kept footage. The editor keeps clips in source order, so the plan never moves it to the front; export it as its own clip to lead a post, or use the frame as the thumbnail.

## Markers

Markers dropped while recording (Screen Studio's add-marker action, or `screenstudio_desktop_perform` with `markers: true`, one per beat) arrive in `screenstudio_analyze` as `markers` with their source time. The `markers` option says what they do; it is `keep` whenever the recording has any.

- `keep`: each marker starts a new beat. The stretch up to the next marker is kept when speech or narration covers at least half of it, otherwise the first 1.5s after the marker is; neither ever runs past the end of the video (before Screen Studio's stop click). Marked beats are never dropped to fit a length; pass `chapters` if they may go. Voiced beats recorded with `minDurationMs` pass their lengths as `markerBeatsMs`, so each marker keeps the hold stretched for its line.
- `retake`: when the speech in the 8s after a marker repeats at least 60% of the content words in the 8s before it, in the same order and at least four of them, the person started over. Two different steps that share "click", "save" and "page" are not a retake. The earlier take goes, from the start of the beat before the marker to the marker or the end of a sentence running across it, listed in `droppedBeats` with reason `retake`.
- `chapters`: beats carry a `chapter` number (1 after the first marker), and the notes list where each chapter starts in playback time, or that a chapter was cut when none of it is left.
- `ignore`: markers change nothing.

## Director's notes

Every plan returns `notes`: each decision at its playback time, with the rule behind it. The opening hold, each beat with its role and score, each cut and why (nothing to watch, a dropped beat, your drop), jump cuts inside a talk, every sped-up stretch and its cap, every zoom and why it is that deep, the final hold, chapters and the cold open. A recipe adds what it set and the music, voice and export to use. Read them to the person when you show the plan; they are written to be read aloud.

## Camera director

For a talking-head recording, `talkingHead: true` on `screenstudio_plan_edit` (or `screenstudio_plan_layouts` over the current cut) plans the layouts track:

| Rule | Layout |
| --- | --- |
| Everywhere else | `cutout-camera` as the default layout, 0.6 of the frame, shrinking to 0.5 under zooms, on the side away from the clicks (mean click x) |
| The first line, when it is at least 2s and ends before the first click | `fullscreen-camera` from the start |
| The last line, when nothing is clicked after it starts | `fullscreen-camera` to the end |
| Each zoom, widened to the sentence around it | `screen-only` |
| A phrase over 12s with no click and no zoom under it | `split-screen` |

Every boundary sits in the silence between phrases. Stretches of one kind closer than `minStretchMs` (6s) join up; a short gap between different kinds joins a neighbour so the default never flashes up for a moment: the one showing more screen when something is clicked in the gap, otherwise the one showing more of the person. A bookend shorter than 2.5s on screen, or a stretch in the middle shorter than 5s, is dropped. The config adds face tracking, a soft cutout edge (0.4), no hiding the camera in silences, a LUT toned down to 0.4 when one is set, and captions lifted to 0.93 when they are on. The ops clear the layouts track first, so planning again replaces the old layouts.

`screenstudio_check_pacing` judges layouts on any timeline: `layout-churn` when two layout changes are under 5s apart in playback, `layout-mid-phrase` when a change lands inside a spoken phrase.
