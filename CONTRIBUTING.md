# Contributing

Thanks for improving Screen Studio MCP. It does two jobs: record a new video by operating an app while Screen Studio records, and edit a video already in Screen Studio, live in the open editor. Changes should serve one of those two.

## Local setup

You need macOS, Node 22+, Xcode command line tools and `ffmpeg`.

```bash
git clone https://github.com/tolimarchuk/screenstudio-mcp.git
cd screenstudio-mcp
npm ci
npm run build:native
npm run check
```

`npm run check` runs formatting and the test suite. Tests run offline and never touch Screen Studio.

## Try your checkout in an agent

Register the checkout instead of the npm package, into throwaway homes first:

```bash
root=$(mktemp -d)
node dist/cli/main.js install --local --claude-home "$root/claude" --codex-home "$root/codex"
rm -rf "$root"
```

Then for real: `node dist/cli/main.js install --local`, and restart Claude Code or Codex.

## Tests against the real app

`npm run test:live` records a sample app with Screen Studio. It needs the exact build in `src/studio/compat.ts`, Accessibility and Screen Recording permission, and it takes over the mouse while it runs.

## A new Screen Studio version

Everything tied to one app build lives in `src/studio/compat.ts`. Start there, read [docs/compatibility.md](docs/compatibility.md), and keep mutating operations refusing unknown builds until they are tested.

## Pull requests

- Keep tools general: no defaults tuned to one app, site or brand. People direct edits in their own words; recipes stay optional presets.
- Every new editing rule gets a test in `test/`.
- Tool descriptions are read by agents: say what it does, when to use it, and what it leaves behind.
