# Agent workflow

Three skills teach recording, editing and delivery. Tool schemas are the contract. `screenstudio_status` reports the connection, app version, open editors, recording state and `knownSettings` (config keys with exact range checks).

## Record

Rehearse each beat, then record it in one take with `screenstudio_desktop_perform`: a list of steps, each followed by a hold so its result is visible. The pointer glides and settles before clicking; typing runs at a readable rhythm. Thinking time between beats becomes idle footage that the edit plan removes. `markers: true` drops a recording marker at the start of each beat; `screenstudio_analyze` reads them back in source ms, and `screenstudio_plan_edit` and `screenstudio_narrate` (`pinToMarkers`) use them to find each beat.

## Edit

```text
screenstudio_editor_open      → the project opens in a Screen Studio window
screenstudio_analyze          → clicks, typing, shortcuts, screen changes, idle (source ms)
screenstudio_source_frames    → look at the moments that matter
screenstudio_plan_edit        → slices, zooms and style settings + a pacing report + ready ops
screenstudio_editor_apply     → applied in the editor and saved; returns timeline, pacing report, checkpoint
screenstudio_editor_frame     → the rendered preview at any playback time
screenstudio_editor_save      → same as Cmd+S; needed after undo, restore, narration or music
```

Example apply:

```json
{
  "projectPath": "/Users/me/Screen Studio Projects/Demo.screenstudio",
  "ops": [
    { "op": "setSlices", "slices": [
      { "startMs": 400, "endMs": 9200, "speed": 1 },
      { "startMs": 9200, "endMs": 13400, "speed": 2 },
      { "startMs": 13400, "endMs": 21000, "speed": 1 }
    ]},
    { "op": "clearZooms" },
    { "op": "addZoom", "startMs": 9000, "endMs": 14200, "zoom": 1.6, "target": { "x": 0.31, "y": 0.42 } },
    { "op": "config", "changes": { "animations.screenMovementSpring": { "stiffness": 170, "damping": 50, "mass": 3 } } }
  ]
}
```

Applies run in show mode by default: the person watches the playhead move, the timeline get chopped and each panel change in Screen Studio. `show: false` applies instantly.

Each apply saves the project unless `save: false`. Duplicate first (`screenstudio_project_duplicate`), or pass `save: false` while experimenting.

Slices and zooms use source time; the editor state, pacing report and frames use playback time. Every apply returns both.

## Sound

`screenstudio_narrate` and `screenstudio_music` share the project's one background audio track. For a narrated video, pass `music` to `screenstudio_narrate`; music added later with `screenstudio_music` is mixed under the voice, and `music: null` on `screenstudio_narrate` removes it. Both change the open editor; save afterwards.

## Judge

`screenstudio_check_pacing` reads the timeline the way a viewer feels it: zooms that are too short or back to back, too many zooms per minute, choppy cuts, speed ramps, sped-up clicks, snappy springs and abrupt endings. Fix its errors before exporting. See the pacing resource for the rules and their sources.

## Deliver

`screenstudio_export_start` renders what the editor shows. Poll the job, then check frames at the opening, each zoom, each cut and the end with `screenstudio_export_frame`.

## Recovery

Each apply writes a checkpoint; `screenstudio_editor_restore` returns the open editor to it. `screenstudio_editor_history` steps the app's own undo. Neither saves: call `screenstudio_editor_save` to write the result to disk. After any timeout, inspect state before repeating a change.
