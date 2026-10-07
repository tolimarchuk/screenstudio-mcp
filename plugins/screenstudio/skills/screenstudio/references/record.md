# Record a software walkthrough

Deliver a saved Screen Studio project whose footage is easy to edit: deliberate cursor moves, a visible result after every action, and clean starting and ending states. When a finished video is requested, continue with [edit](edit.md) and [deliver](deliver.md).

## Prepare

1. `screenstudio_status`. If not connected, `screenstudio_launch` (the person may need to quit Screen Studio first).
2. Decide the audience, destination and the one outcome the video shows. Default to a short silent walkthrough of one window, no microphone or camera.
3. Write 3–6 beats: starting state → action → visible result, ending on the finished state. Use realistic demo data, never lorem ipsum or private records.
4. `screenstudio_sources`; pick the exact window by app, title and ID. Size the window to about 1440×900 points so zooms stay sharp and text is legible. No tool resizes windows: launch a browser with `--window-size=1440,900` (see browser demos), or ask the person to size the window. Close notifications, unrelated tabs and anything private.
5. Recording a website? Read [browser demos](browser-demos.md) (resource `screenstudio://browser-demos`): a clean app window in a fresh browser profile, scouting, rehearsing demo widgets and staying on the site.
6. Rehearse every beat once without recording: screenshot, find coordinates, confirm each step produces the expected result. Rehearsal is where you think; the take should not contain your thinking.

## Narrated videos

Write the narration and voice it before recording: `screenstudio_voice_lines` returns each line's spoken `durationMs` and a `beatMs` (the line plus 400ms), so each beat on screen lasts as long as its line. After the edit, `screenstudio_narrate` pins the same lines to the footage, reusing the cached clips when the voice and rate are unchanged; [narration](narration.md) covers the whole voice-over workflow.

Mark where each beat starts: `screenstudio_desktop_perform` with `markers: true` adds a recording marker before the beat's first step, and `minDurationMs` (a line's `beatMs` from `screenstudio_voice_lines`) makes the beat last as long as its narration line. `screenstudio_analyze` reads the markers back in source ms and `screenstudio_narrate` `pinToMarkers` puts each line on its beat.

## Perform

1. `screenstudio_record_start` on the window. Leave the starting state still for about 1.5 seconds; that becomes the opening shot.
2. For each beat: `screenstudio_desktop_inspect` for a fresh token, then `screenstudio_desktop_perform` with all of the beat's steps. Each step is followed by a hold (click 1.2s, type 0.9s, key 1s, scroll 1.2s); set `holdMs` longer where a result needs reading or loading. Use `pace: 1.2–1.4` for a calmer feel.
3. After each beat, screenshot and confirm the intended result is on screen before the next beat. Time spent between beats becomes idle footage that the edit plan cuts, so there is no need to pause the recording for short thinking. Pause only for long waits or fixes.
4. End on the finished state and hold it for 2–3 seconds before `screenstudio_record_control` finish. Keep the returned project path.

## How the input looks on camera

The pointer glides along a slight arc in 0.4–1.1s depending on distance, settles 0.2s, then clicks. Typing runs at about 12 characters a second with natural variation. Scrolling glides in small steps. Shortcuts press real modifier keys (`{type:"key", key:"k", modifiers:["command"]}`) so Screen Studio can show keycaps. `drag` and `doubleClick` are available.

## Coordinates

Take `screenstudio_desktop_screenshot` of the same window ID you will act on. Coordinates are points relative to the window's top-left, including the title bar. A Retina screenshot has twice as many pixels as points: in a 2880-pixel-wide screenshot of a 1440-point window, a button at pixel (1800, 1000) is (900, 500). The helper adds the window's desktop origin; never add it yourself.

Tokens from `screenstudio_desktop_inspect` last 60 seconds and are used up by one `screenstudio_desktop_action` or `screenstudio_desktop_perform`. A moved or resized window invalidates the token. During a perform, every step re-checks that the same window is frontmost and focused; if focus changes, the remaining steps stop and the error says how many completed.

Steps: `focus`, `move`, `click`, `doubleClick`, `drag` (x, y → toX, toY), `taps` (a burst of `count` taps every `intervalMs`, default 110, at one x, y: rapid repeated taps), `hold` (press at x, y for `ms`, then release: press-and-hold UI), `type`, `key` (letters, digits, punctuation, return, tab, space, backspace, delete, escape, arrows, home/end, pageup/pagedown, `selectAll`, with modifiers), `scroll` (lines, positive scrolls up; optional window-point `x`, `y` to aim at a region, given together). Without them it scrolls where the pointer rests inside the window, or the middle of the window, moving the pointer there first.

Input fails when Accessibility permission is missing, focus changes, the window cannot be identified, or coordinates fall outside it. macOS grants Accessibility and Screen Recording to the host app that runs the agent (Terminal, Claude, Codex), not to a helper. `npx screenstudio-mcp doctor` checks both. Ask the person to grant a missing permission and relaunch the host app, then inspect again. Screenshots and source listings can contain private information; record only what the person asked to show.

## Recovery

A timeout can mean the change happened: inspect recording state before retrying. If the window moves, loses focus or a person interferes, input stops; inspect and continue. Never click through a permission dialog blindly. On a failed walkthrough, finish the recording to keep the footage and explain what remains. See [recovery](recovery.md) (resource `screenstudio://recovery`).
