# Screen Studio coverage

Every editor command in Screen Studio 4.0.1 (its menus, toolbar, command menu and shortcuts), and how the MCP does it. Commands are thin wrappers over the project model; the MCP drives the same model, so results match the app.

## Recording

| Screen Studio | MCP |
| --- | --- |
| Record display, window, area | `screenstudio_record_start` (displayId, windowId, or displayId + area) |
| Pause, resume, finish, restart, cancel, add marker | `screenstudio_record_control`; `screenstudio_desktop_perform` markers adds one per beat, `screenstudio_analyze` reads them back in source ms |
| Recording widget, speaker notes prompter, show app windows in recordings | App UI only |

## Timeline: cuts and speed

| Screen Studio | MCP (`screenstudio_editor_apply` ops) |
| --- | --- |
| Split at current time | `splitAt` |
| Remove slice, remove slice till previous cut | `removeSlice`, `cutRange` |
| Merge slice with next / previous | `mergeSlices` |
| Set slice speed, apply speed to all slices | `updateSlice` speed, `setSlices` |
| Set slice volume, system audio volume, external device volume | `updateSlice` (0–1) |
| Hide mouse cursor, disable smooth mouse movement (per slice) | `updateSlice` |
| Reset slice trim, reset trims and cuts for all slices | `resetCuts`, `setSlices` |
| Edit by transcript (cut words) | `cutRange` on word times from `screenstudio_transcript_read`; `screenstudio_plan_edit` removeFillers and tightenPausesMs |

## Zooms and loupe

| Screen Studio | MCP |
| --- | --- |
| Add zoom, remove zoom, duplicate zoom | `addZoom`, `removeZoom`, `duplicateItem` |
| Change / increase / decrease zoom level, apply level to all | `updateZoom` |
| Set zoom to auto / manual | `updateZoom` follow |
| Toggle loupe mode, loupe radius / bevel / aberration / glass | `updateZoom` presentation and loupe |
| Toggle zoom disabled, disable / enable all zooms | `updateItem` fields isDisabled, `setTrackDisabled` |
| Remove all zooms, restore default (auto) zooms | `clearZooms`, `restoreAutoZooms` |
| Start zoom animation early, zoom springs, motion blur | `config` zooms.*, animations.* |

## Camera layouts, masks, voiceovers

| Screen Studio | MCP |
| --- | --- |
| Default layout (camera overlay, split screen, cutout camera) and its options | `config` defaultLayout.* |
| Layout changes on the timeline (incl. fullscreen camera, screen only) | `addLayout`, `updateItem`, `removeItem`, `clearTrack` layouts; planned from speech by `screenstudio_plan_layouts` |
| Camera style: mirror, face tracking, LUT, grain, sharpen, crop, background blur, cutout edge, hide during silence | `config` camera.* |
| Add sensitive data / highlight mask, change type, opacity, disable, remove all | `addMask`, `updateItem`, `setTrackDisabled`, `clearTrack` masks |
| Find private text on screen and propose blur masks (MCP only) | `screenstudio_find_sensitive` |
| Remove voiceover(s) | `removeItem` / `clearTrack` voiceOvers |
| AI voiceover, recorded voiceover | Disabled in this app build; `screenstudio_narrate` adds narration on the audio track |

## Look and sound

| Screen Studio | MCP |
| --- | --- |
| Background: wallpaper, gradient, color, image, blur; padding; radius; shadow; inset | `config` styles.*, output.*, `screenstudio_catalog` wallpapers |
| Crop | `config` crop.rect01 |
| Output aspect ratio, avoid empty zoom area | `config` output.* |
| Device frame | `config` device.*, catalog deviceFrames |
| Cursor: set, size, hide, idle hide, rotation, shake, click effect, loop, stop at end | `config` cursor.*, catalog cursorSets |
| Captions: transcript on/off, font, size, colors, position, reveal, line growth, entrance, sound labels | `config` captions.* |
| Keyboard shortcut keycaps | `config` captions.enableShortcuts, shortcutsSizeRatio, showShortcutsWithSingleLetters |
| Generate / edit transcript | `screenstudio_transcript_generate`, `screenstudio_transcript_edit` |
| Audio: volume, mic preset, mutes, improve quality | `config` audio.*, processing.* |
| Click sound effects | `config` audio.clickSoundEffect, clickSoundEffectVolume |
| Background music library | `screenstudio_music` (ducked under speech), or the `music` option of `screenstudio_narrate`; both write the one background audio track |
| Presets: list, apply | `screenstudio_presets` |
| Brand colours, captions, cursor and sound saved once | `screenstudio_brand` (one live config op) |

## Editor interface and playback

| Screen Studio | MCP |
| --- | --- |
| Play, pause, go to first / last frame, move by frames, play speed | `screenstudio_editor_play`, `screenstudio_editor_seek` |
| Undo, redo | `screenstudio_editor_history` |
| Save, save as | `screenstudio_editor_save` (each apply also saves unless `save: false`), `screenstudio_project_duplicate` |
| Open sidebar sections (General, Cursor, Captions, Edit by transcript, Keyboard Shortcuts, Audio, Animations) | `screenstudio_editor_view` panel: background, cursor, captions, transcript, shortcuts, audio, animation |
| Select an item, timeline zoom in / out, show / hide sidebar and timeline, preview mode | `screenstudio_editor_view` |
| Export current frame as image | `screenstudio_editor_frame` |
| Export to file | `screenstudio_export_start` |
| Export for several destinations, with posters, captions, chapters and a manifest | `screenstudio_export_variants` |
| Looping hero video and README GIF | `screenstudio_loop` |
| Review every key moment at once | `screenstudio_contact_sheet` |

## Beyond the app (MCP only)

| Capability | MCP |
| --- | --- |
| Fit an edit to a length, structure it hook-demo-payoff, cut to the beats marked while recording, director's notes for every decision | `screenstudio_plan_edit` targetMs, structure, markers; returns beats, droppedBeats, coldOpen, notes |
| Optional presets: one word for a whole direction (pacing, frame, captions, sound, music, voice, export targets) | `screenstudio_recipes`, `recipe` on `screenstudio_plan_edit`, `screenstudio_check_pacing` and `screenstudio_export_variants` |
| Brand kit over a recipe | `brand` on `screenstudio_plan_edit`, or `recipeOverrides.brand` |
| Voice the script first and size each beat to its line | `screenstudio_voice_lines`, then `screenstudio_desktop_perform` minDurationMs and `screenstudio_narrate` pinToMarkers |
| Captions for an AI voice | `screenstudio_narrate` captions (the app's own captions, or SRT and styled ASS files) |

## Not automated

Shareable links and share project (upload to the cloud), export to clipboard and cut/copy/paste between projects (touches the clipboard), delete project, license, subscription and account, quit, check for updates, settings, onboarding, diagnostics and debug commands, reel preview mode, preview size and resolution.
