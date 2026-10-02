# Export variants and the delivery kit

One edit usually goes to several places in the same day. `screenstudio_export_variants` renders it once per destination from copies of the live project, so the editor never changes and the agent does not hand-run five exports and five frame checks.

## Pick targets for the content

No target is the default. Pick the places this video is actually going.

| Target | Frame | Render | Limit | Changes on its copy |
| --- | --- | --- | --- | --- |
| `x` | 16:9 | 1080p60 MP4 | 2:20, 512 MB | none beyond the aspect |
| `landing` | 16:9 | 1080p60 MP4 | none | none beyond the aspect |
| `linkedin` | 1:1 | 1080p30 MP4 | 10:00 | captions 5.5% of the height, padding 0.05 |
| `shorts` | 9:16 | 1080p60 MP4 | 1:00 | 1080x1920; captions 6% at y 0.68, padding 0.02, camera cutout 0.55, fixed zooms on the main actions, the screen kept at about 1.8x between them |
| `portrait` | 4:5 | 1080p30 MP4 | 1:30 | 1080x1350; captions 5%, padding 0.03, the screen kept at about 1.5x |
| `docs` | 16:9 | 1080p30 MP4 | none | none beyond the aspect |
| `gif` | 16:9 | 480p GIF | 0:15, 12 MB | converted with its own palette, frame rate then height halved until it fits |

With `recipe` (see [recipes](../../screenstudio-edit/references/recipes.md)), `targets` may be left out: the recipe's own targets render. Its export settings apply too: its frame rate on every video target (camera footage stays at 30fps), its resolution on targets in its own aspect, read as the short side. GIFs keep their own size budget. The notes say what the recipe changed.

Every result carries a `notes` line per target saying why it is rendered that way, and `checks` that flag a file over its target's length or size.

## What changes per target

- **Aspect, padding, captions and camera cutout** are set on that target's copy only, through the same rules an editor apply uses. A setting the project does not have is skipped and named in the notes.
- **Vertical targets** (`shorts`) shrink the screen to a third of the frame. The copy gets fixed-target zooms (2.2x or 1.8x, actions up to 8s apart share one) on the planned beats, where they do not overlap the edit's own zooms and stay clear of the opening and ending wide shots.
- **Portrait targets** (`shorts`, `portrait`) never show the screen as a thin band with empty backdrop above and below. Every stretch between zooms gets a follow zoom deep enough that the visible part of the screen is about as tall as the frame is wide: the square root of the screen's aspect over the frame's, so 1.8x for a 16:9 recording in 9:16 and 1.5x in 4:5. Shallower follow zooms are raised to it; loupes become camera zooms of the same kind (a fixed loupe a fixed zoom on its target, a follow loupe a follow zoom kept within reach of its clicks), since a lens over a small screen reads poorly on a phone; deeper zooms and fixed-target zooms stay as they are; switched-off zooms leave the copy, so the stretch under them is filled too. When the recording is already as tall as the frame (a phone recording), nothing changes, loupes included. The first and last second sit a little wider (1.55x in 9:16) so the opening and ending show where we are. Around clicks close together (3s or less apart) the level drops so they all fit in the frame, and stays wide when they cannot. The notes give the level and what really happened: stretches zoomed less, stretches left wide and for how long, loupes converted, switched-off zooms left out.
- **No crop.** When "avoid empty zoom area" is on and the target's frame differs from the recording (or the recording's size is unknown), Screen Studio would crop every wide shot, so that target's copy has it turned off, and its notes say so. The editor keeps your own setting.
- **Heights are the short side.** Every target and recipe height is the frame's short side: 1080 means 1920x1080 at 16:9, 1080x1080 at 1:1, 1080x1350 at 4:5 and 1080x1920 at 9:16. Screen Studio reads its export height as the frame's real height (asked for 1080 at 9:16 it renders 606x1080), so a portrait frame asks for its long side: the short side over the aspect, rounded to an even number (1920 at 9:16, 1350 at 4:5). `screenstudio_export_start` takes the short side the same way. The resolution check after each render names the frame it wanted when one comes out smaller.
- **Long batches.** Targets render one at a time, with a progress notification per target so clients keep waiting. A render past `renderTimeoutMs` (20 minutes by default) is cancelled before the next starts. A second call for the same project and folder is refused while one runs.
- Files are named `<baseName>-<target>.<ext>` in `outputDir`. An existing file is never replaced; the next free name (`-2`, `-3`) is used.

## The kit

With `kit` on (the tool's default):

- **Posters**, one PNG per aspect, at the payoff: where the last beat's result (or the beat marked payoff) has settled. Use it as the `poster` of a `<video>` and as the share image.
- **Captions files** (`.srt` and `.vtt`) from the transcript, mapped through the cut: words cut away are gone, words in a sped-up clip shrink with it. Narration captioned for burn-in (`screenstudio_narrate` with `captions: true` on a recording with a microphone) adds its words, and each video also gets a `<baseName>-<target>-captioned.mp4` with the narration burned in, sized for that frame. A kit file that fails to write is a warning; the videos are already on disk. Chapters you pass are put in order, the first moved to 0:00, and any under 10s after the one before left out, with a note.
- **Chapters** (`<baseName>-chapters.txt`, `m:ss Title` per line), starting at 0:00, each at least 10 seconds. Titles come from the beats (spoken words first); pass `chapters` with real titles for YouTube or docs.
- **A manifest** (`<baseName>-manifest.json`): every file with its duration, dimensions, bytes and limit checks.
- **A contact sheet** of every variant at its opening, midpoint and ending, returned as an image. Look at it before reporting: the action must sit inside every frame, captions must not cover it, and the vertical zooms must land on the action.

## Review in one look

`screenstudio_contact_sheet` puts the moments that matter in one labelled grid: the opening, each cut and the frame just before it, each zoom's midpoint, layout and mask starts, every pacing issue, and the ending. Each tile reads `n · m:ss.s what`. Read it first; use `screenstudio_editor_frame` only for a close look at one moment. With `jobIds` it shows finished exports instead, one row each.
