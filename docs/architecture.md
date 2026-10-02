# Architecture

The MCP server registers tools with the official TypeScript SDK. It talks to Screen Studio over the app's loopback debugging connection and calls the same internal bridge and editor model the app's UI uses. The adapter is build-specific.

**Connection.** The server finds the running app's debugging port from its launch arguments, or uses `SCREENSTUDIO_PORT`. Renderer discovery picks the main renderer and skips export workers. Requests are never retried automatically, because a timed-out change may have completed.

**Live editor.** All editor windows share one React tree. The server walks it to find each open editor's context (project, playback, view) and matches it by project path. Edits go through the editor's timeline collections and config model, so they appear immediately, respect Screen Studio's own constraints (for example zooms cannot overlap), and land in the app's undo history. Saving uses the editor's own save sequence: serialize, write through the app, mark saved. Apply saves after its ops unless called with `save: false`. Before each apply the server writes a private checkpoint of the scene and settings. In show mode the same edits are paced through the editor's own view model: playhead seeks, timeline splits and deletions, item selection and sidebar panels, so the person sees the edit happen in the app.

**Preview frames.** The server seeks the editor, briefly tags the editor window title to identify its native window, captures that window and crops to the preview canvas. The frames are the app's own rendering.

**Analysis.** The recording folder holds Screen Studio's input logs (clicks, keys, mouse moves) and screen video per session. The analyzer maps events to source time across pause/resume sessions, normalizes coordinates to the captured window or display, and measures on-screen change with ffmpeg scene scores to find page changes, loading and idle stretches. Results are cached per recording.

**Planning and pacing.** Pure functions turn an analysis into slices, zooms and style settings, and score any timeline in playback time. Both encode Screen Studio 4's own auto-zoom grouping and spring presets plus published guidance; see the pacing reference.

**Native input.** A small Swift helper uses public Accessibility and Core Graphics APIs. It targets one on-screen window with matching process and geometry, re-checks focus during input and stays inside the window. Motion is human-paced. Observation tokens expire after 60 seconds and are single use. No clipboard, shell execution or UI scripting is exposed.

**Narration and music.** Narration voices each line with edge-tts, places it at its playback time, mixes the lines over optional library music with ffmpeg, copies the mix into the project and sets it as the background audio track. Music does the same with a library track alone. There is one background track: music added after narration is mixed under the voice, and `music: null` on narration removes it.

**Export.** Exports are asynchronous jobs in the app renderer using the open editor's live project data, or the saved project when no editor has it open. The app's local QA destination avoids a native save dialog; the file is delivered to the requested path without overwriting anything and checked with ffprobe. Nothing is uploaded or shared.
