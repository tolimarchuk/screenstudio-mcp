# Narration

A narrated demo is planned around the voice. Write the script, voice it first to time each line, record each beat to last as long as its line, edit, then pin the voiced lines to the footage.

## Write

- One line per beat, 1–3 short sentences. Time each line at about 2.8 words a second. Keep it moving: viewers drift when the voice waits on the screen.
- Say what the viewer is looking at as they look at it. Name the thing on screen ("Three plans, billed monthly"), then what it does for them.
- Lead with what the product is in the first line. End with what to do next.
- Plain, confident, specific. No hype words, no rhetorical questions stacked up, no "seamlessly".
- The video is the person's. Never credit the agent, the AI or the model ("recorded, cut and captioned by Claude", "made with AI") in a line, caption or end card. Credit them or their product, unless they ask otherwise.
- Spell out what a voice would misread: prices ("twenty-nine dollars"), domains ("acme dot com"), acronyms.
- If a beat has a silent stretch with action in it (a scroll, a click, a panel opening), extend the line to cover it rather than leaving dead air.

## Voice

`screenstudio_catalog` lists recommended voices; pick one that suits the product and audience, and use one voice per video. Rate 0 to +5% keeps energy up; slower than -5% drags. Lines are voiced with edge-tts (Microsoft's online speech service; free, no account), which must be installed (`pipx install edge-tts` or `uv tool install edge-tts`).

Voice the script before recording with `screenstudio_voice_lines`: it needs no project and returns each line's spoken `durationMs` and a `beatMs` (the line plus 400ms). The clips are cached, so narrating the same text later costs nothing.

## Record to the voice

1. `screenstudio_voice_lines` with the script. Fix any line it calls too fast.
2. Record each beat with `screenstudio_desktop_perform`, `markers: true` and `minDurationMs` set to that line's `beatMs`. The marker lands where the beat starts; the last hold stretches so the beat lasts as long as its line, and no longer.
3. Put the action where its words will fall: the click on "Save" happens about a second after the line starts.
4. After recording, `screenstudio_analyze` returns the markers in source ms. A marker dropped while recording was paused lands where recording resumed.

Without markers, pin lines from the footage instead: the beat's first click or typing burst in `screenstudio_analyze`.

## Edit around the voice

- Plan with `speedUps: false`. A still screen under narration is not dead air.
- Recorded with markers and `minDurationMs`, pass each line's `beatMs` as `markerBeatsMs` (one per marker, in order) to `screenstudio_plan_edit`. Each marker then keeps [marker, marker + beatMs], so the hold stretched for the line is not cut as dead air before the voice exists. Without markers, pass the narrated stretches as `keep` source-ms spans.
- Choose zooms and loupes to illustrate what the line names.

## Pin and mix

`screenstudio_narrate` with one line per beat, a voice, and optional library `music` at `musicVolume` about 0.06–0.12. Recorded with markers, pass the lines as `{ text }` with `pinToMarkers: true`: line 1 starts 300ms after marker 1, line 2 after marker 2, and so on. Otherwise give each line `sourceMs` (about a second before the beat's first click or typing burst from `screenstudio_analyze`). It returns each line's playback start and end.

Narration and `screenstudio_music` share the project's background audio track. Music added later with `screenstudio_music` is mixed under the voice, not swapped in for it. Re-sync keeps the last voice, rate, music and volumes unless you pass new ones; `music: null` on `screenstudio_narrate` removes the music.

- **Sync to actions:** compare each line's timing with its click. If the key words come more than about a second before the action ("switch to annual" vs the toggle click), move that line later and run again. The tool warns when a line would run into the next.
- **End cleanly:** the last line should finish 1.5–2s before the video ends, over a settled final frame.
- **After re-cutting**, call `screenstudio_narrate` with no lines to re-sync the voice and its captions.
- **Retakes and failed steps add markers.** A beat retried after a failed step or redone after a wrong result leaves an extra marker. Plan with `markers: "retake"` and pin lines with the plan's live markers (see below), or pass each line's `sourceMs`, so lines after a retake do not land one beat early.
- **Save** with `screenstudio_editor_save`: narration changes the open editor only.

## Captions

Most feeds autoplay muted, so caption narrated videos meant for social. `captions: true` on `screenstudio_narrate` takes word timings from the voice and captions it one of two ways, and says which:

- **Screen Studio's own captions**, when the recording has no microphone. Use `line-by-line` with `wordEntrance: fade-in` for readable captions; Screen Studio's own `word-by-word` shows only one word at a time in this build. The words become the project's transcript in source time and `captions.enableTranscript` is turned on. The voice is pinned in playback time and does not move with a re-cut, so after any cut change run `screenstudio_narrate` without lines: it re-syncs the voice and rewrites the captions together. Style them like any captions (`config` captions.*, or a brand). Check a frame with `screenstudio_editor_frame`.
- **Subtitle files for burn-in**, when the recording has a microphone (its transcript is never replaced) or the app did not keep the words. An `.srt` and an `.ass` styled like the project's captions (font, size, colours, position) are written next to the project, timed to the current cut. They show a line at a time; with a `word-by-word` style, each word in the line lights as it is spoken. `screenstudio_export_variants` burns them into a `<name>-<target>-captioned.mp4` beside each video variant, sized for that variant's frame, and puts the words in the kit's `.srt` and `.vtt`. For a single export, burn the `.ass` with ffmpeg's `subtitles` filter, or upload the `.srt` where a platform takes captions.

Re-sync keeps captions on and re-times them.

## Check

Measure in the export: voice around −20 to −24 dB mean, music alone about 10 dB lower, a silent tail. Listen to the first and last lines and to every line that names a click.

Screen Studio's own AI voiceover and recorded voiceover tracks are disabled in app build 4.0.1-4897, so narration plays as the project's background audio track. It renders in Screen Studio's export like any background music.
