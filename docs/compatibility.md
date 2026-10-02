# Screen Studio 4 compatibility

Supported app build: **4.0.1-4897**. Project schema: **4.0.0**. Exercised on Apple Silicon macOS.

| Surface | Coverage | Exercised |
| --- | --- | --- |
| Connection | Port auto-detection, editor renderer selection | Real app |
| Sources and state | Window/display IDs, devices, live recording state | Real app |
| Recording | Start exact window, pause/resume, add markers (read back in source ms by `screenstudio_analyze`), finish into a project | Real app |
| Native walkthrough | Focus, human-paced glide/click/double-click/drag, typing, shortcuts, smooth scroll, one-take beats | Real sample app |
| Live editor | Find open editors, open projects, slices, zooms, config, undo, checkpoints, save after each apply | Real app, real footage copy |
| Preview frames | Editor preview capture at playback times | Real app |
| Analysis | Clicks, drags, typing, shortcuts, movement, screen changes, idle, multi-session | Window and display recordings |
| Planning and pacing | Calm/balanced/snappy plans, pacing check | Unit tests plus real footage |
| Export | Local MP4/GIF from live editor data, job lifecycle, delivery, encoded inspection | MP4 and GIF |
| Narration | Neural voice lines pinned to source time, mixed over library music with ducking, attached as the project's background audio track | Real app, exported with audio |
| Click sounds, ripple, springs, background, loupe | Supported config and zoom fields | Real app, exported |
| Transcript and captions | On-device generation, read, word fixes, full caption styling, live editor refresh | Real app, real speech recording |
| Camera layouts and cutout | Default layout settings and layout track items | Real app, exported |
| Masks | Sensitive-data and highlight masks | Real app, exported |
| Crop, backdrop, device frames, cursor sets | Any project setting, checked against the live config | Real app, exported |
| Music | Library tracks ducked under transcript speech; shares the background audio track with narration | Real app, exported |
| Webcam/audio effects | Supported nested settings | Schema mapped |
| Export height | Targets and recipes carry the frame's short side (1080 for 1080x1920 at 9:16). Screen Studio reads export height as the frame's height, so `renderHeight` converts the short side for portrait frames (a 9:16 frame at 1080 asks for 1920, 4:5 asks for 1350) | Confirmed by a live portrait render (606x1080 before the fix); the post-render resolution check names the frame it wanted |
| Brand presets | `screenstudio_brand` `toPreset` calls the app's `presets.createFromConfig` and reports when the build lacks it | Tool registered; not yet run against the real app |
| Camera presence | Read loosely from the recording's channels (a `camera` or `webcam` type); unknown keeps the old behaviour | Not yet checked against a real camera recording |
| Presets | List saved presets, apply one to a project with the app's own preset apply. An open editor keeps its old settings and saves them back, so close its window and reopen the project to load the preset | Tool registered; not yet run against the real app |
| Screen Studio AI voiceover and recorded voiceover tracks | Disabled by the app in this build ("not enabled"); narration uses the audio track instead | Inspected |

The app's local bridge and editor model are undocumented. A different build is rejected before any change, so turn off Screen Studio's auto-update. `SCREENSTUDIO_ALLOW_UNTESTED=1` lets edits run on an untested 4.x build at your own risk; reads always work. To add a build: inspect its state and editor model, run the unit tests and a seeded record-edit-export pass, then update this table.

Vendor code is not in this repository. Screen Studio is installed and licensed separately.
