# Tests

`npm test` builds and runs the protocol, connection, pacing and docs suites: a real MCP stdio client, a local CDP fixture, timeline math, the pacing check (including an edit that is too fast), the planner on synthetic recordings for every style, a check that the skill and docs name only real tools, ops, resources and status fields, and the installer against temporary skill folders. Nothing touches the desktop.

## Tests against the real app

Live scripts move the real pointer and create real recordings. Use only the bundled demo app. Keep the target visible and avoid typing while they run.

1. `npm run build && npm run build:native`, then `npm run build:demo` and open `.artifacts/Demo.app`.
2. Launch Screen Studio through the server (or with an automation port already open).
3. Run:

```sh
SCREENSTUDIO_LIVE_TEST=1 node scripts/live-record.mjs <demo-window-id>   # one-take beats, finish, analyze, plan, edit live, export
SCREENSTUDIO_LIVE_TEST=1 node scripts/live-export.mjs <sample.screenstudio>  # GIF, reconnect, cancel
```

Reports and videos stay in `.artifacts/`, outside Git.
