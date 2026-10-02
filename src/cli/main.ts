#!/usr/bin/env node
// The screenstudio-mcp command: one command installs the MCP server and its
// skills into Claude Code and Codex; `serve` (or a non-interactive start, the
// way an MCP client launches it) runs the server over stdio.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { APP_BUILD } from "../studio/compat.js";
import { codexBlock, withoutTable } from "./codex.js";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const NAME = "screenstudio";
const MARKER = ".screenstudio-mcp";
const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith("-"));
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const claudeHome = option("claude-home") ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const codexHome = option("codex-home") ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
const customHomes = !!(option("claude-home") || option("codex-home"));

/** How MCP clients start the server: the published package, or this checkout with --local. */
const server = flag("local")
  ? { command: process.execPath, args: [join(root, "dist/cli/main.js"), "serve"] }
  : // Pinned, so clients start without an npm lookup (and offline); update re-pins.
    { command: "npx", args: ["-y", `${pkg.name}@${pkg.version}`, "serve"] };

const ok = (s: string) => console.log(`  ✓ ${s}`);
const warn = (s: string) => console.log(`  ! ${s}`);
const bad = (s: string) => console.log(`  ✗ ${s}`);

async function has(bin: string, versionArgs = ["--version"]) {
  try {
    await run(bin, versionArgs, { timeout: 15000 });
    return true;
  } catch (e: any) {
    // It ran but exited non-zero: still installed.
    return typeof e?.code === "number";
  }
}

function targets() {
  const t = option("target") ?? "all";
  if (!["all", "claude", "codex"].includes(t))
    throw new Error(`--target must be claude, codex or all, not ${t}`);
  return {
    claude: t !== "codex",
    codex: t === "codex" || (t === "all" && (existsSync(codexHome) || customHomes)),
  };
}

// ---------- skills ----------

async function skillNames() {
  return (await readdir(join(root, "skills"), { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** Copies each skill into `<home>/skills`, replacing only folders this installer made. */
async function installSkills(home: string, label: string) {
  const dir = join(home, "skills");
  await mkdir(dir, { recursive: true });
  for (const name of await skillNames()) {
    const dest = join(dir, name);
    if (existsSync(dest) && !existsSync(join(dest, MARKER)) && !flag("force")) {
      warn(`${label}: kept your own ${dest} (pass --force to replace it)`);
      continue;
    }
    await rm(dest, { recursive: true, force: true });
    await cp(join(root, "skills", name), dest, { recursive: true });
    await writeFile(join(dest, MARKER), `${pkg.version}\n`);
  }
  ok(`${label}: skills ${(await skillNames()).join(", ")} in ${dir}`);
}

async function removeSkills(home: string, label: string) {
  for (const name of await skillNames()) {
    const dest = join(home, "skills", name);
    if (existsSync(join(dest, MARKER))) await rm(dest, { recursive: true, force: true });
  }
  ok(`${label}: skills removed`);
}

// ---------- Claude Code ----------

async function claudeCli(...a: string[]) {
  return run("claude", a, { timeout: 30000 });
}

async function installClaude() {
  await installSkills(claudeHome, "Claude Code");
  if (customHomes) return warn("Claude Code: custom home, so the MCP server was not registered");
  try {
    await claudeCli("mcp", "remove", "-s", "user", NAME).catch(() => {});
    await claudeCli("mcp", "add", "-s", "user", NAME, "--", server.command, ...server.args);
    ok(`Claude Code: MCP server "${NAME}" added for every project`);
  } catch (e: any) {
    warn(
      e?.code === "ENOENT"
        ? "Claude Code: the claude command is not on PATH, so add the server yourself:"
        : `Claude Code: could not add the server (${
            String(e?.stderr || e?.message)
              .trim()
              .split("\n")[0]
          }). Add it yourself:`,
    );
    console.log(`      claude mcp add -s user ${NAME} -- ${[server.command, ...server.args].join(" ")}`);
  }
}

async function uninstallClaude() {
  await removeSkills(claudeHome, "Claude Code");
  if (customHomes) return;
  await claudeCli("mcp", "remove", "-s", "user", NAME).then(
    () => ok("Claude Code: MCP server removed"),
    () => warn("Claude Code: no MCP server to remove"),
  );
}

// ---------- Codex ----------

async function installCodex() {
  await installSkills(codexHome, "Codex");
  const file = join(codexHome, "config.toml");
  const before = existsSync(file) ? await readFile(file, "utf8") : "";
  if (before) await writeFile(`${file}.screenstudio-mcp.bak`, before);
  const kept = withoutTable(before);
  await writeFile(file, `${kept ? `${kept}\n\n` : ""}${codexBlock(server)}\n`);
  ok(`Codex: MCP server "${NAME}" in ${file}`);
}

async function uninstallCodex() {
  await removeSkills(codexHome, "Codex");
  const file = join(codexHome, "config.toml");
  if (!existsSync(file)) return;
  await writeFile(file, `${withoutTable(await readFile(file, "utf8"))}\n`);
  ok("Codex: MCP server removed");
}

// ---------- doctor ----------

const appBundle =
  process.env.SCREENSTUDIO_APP_PATH ??
  [join(homedir(), "Applications/Screen Studio.app")].find((p) => existsSync(p)) ??
  "/Applications/Screen Studio.app";

async function plist(key: string) {
  const { stdout } = await run("plutil", ["-extract", key, "raw", join(appBundle, "Contents/Info.plist")]);
  return stdout.trim();
}

/** Checks everything a first recording needs. Returns false when something blocks it. */
async function doctor() {
  let blocked = false;
  console.log("Checking this Mac");
  if (process.platform !== "darwin") {
    bad("Screen Studio runs on macOS only");
    return false;
  }
  const node = Number(process.versions.node.split(".")[0]);
  if (node >= 22) ok(`Node ${process.versions.node}`);
  else (bad(`Node ${process.versions.node}: needs 22 or newer`), (blocked = true));

  try {
    const version = await plist("CFBundleVersion");
    if (!existsSync(appBundle)) throw new Error("missing");
    if (version === APP_BUILD) ok(`Screen Studio ${version}`);
    else
      warn(
        `Screen Studio ${version}: tested with ${APP_BUILD}. Reading works; recording and editing need SCREENSTUDIO_ALLOW_UNTESTED=1 to try this build.`,
      );
  } catch {
    bad(
      `Screen Studio is not at ${appBundle} (get it at https://screen.studio, or set SCREENSTUDIO_APP_PATH)`,
    );
    blocked = true;
  }

  const { findTool } = await import("../studio/media.js");
  for (const tool of ["ffmpeg", "ffprobe"] as const) {
    if (await has(await findTool(tool), ["-version"])) ok(tool);
    else (bad(`${tool} not found: brew install ffmpeg`), (blocked = true));
  }
  const { edgeTts } = await import("../studio/narration.js");
  if (await has(await edgeTts(), ["--help"])) ok("edge-tts (narration)");
  else warn("edge-tts not found; only narration needs it: pipx install edge-tts");

  const helper = join(root, "native/desktop-helper");
  if (!existsSync(helper)) await buildHelper();
  try {
    const { stdout } = await run(helper, process.stdout.isTTY ? ["trust", "prompt"] : ["trust"], {
      timeout: 15000,
    });
    const trust = JSON.parse(stdout);
    ok("native input helper");
    if (trust.accessibility) ok("Accessibility allowed");
    else
      warn(
        "Accessibility is off: System Settings › Privacy & Security › Accessibility, allow the app you run the agent in (Terminal, Claude, Codex), then relaunch it",
      );
    if (trust.screenRecording) ok("Screen Recording allowed");
    else
      warn(
        "Screen Recording is off: System Settings › Privacy & Security › Screen Recording, allow the app you run the agent in, then relaunch it",
      );
  } catch {
    bad("the native input helper does not run; reinstall, or build it with npm run build:native");
    blocked = true;
  }
  console.log(blocked ? "\nFix the ✗ items, then run npx screenstudio-mcp doctor again." : "\nReady.");
  return !blocked;
}

/** Builds the Swift helper when the package has none (a git checkout), if Xcode tools are there. */
async function buildHelper() {
  try {
    await run(
      "swiftc",
      [
        join(root, "native/Desktop.swift"),
        "-O",
        "-o",
        join(root, "native/desktop-helper"),
        "-framework",
        "Cocoa",
        "-framework",
        "ApplicationServices",
        "-framework",
        "Vision",
      ],
      { timeout: 300000 },
    );
    ok("built the native input helper");
  } catch {
    warn("could not build the native input helper: xcode-select --install");
  }
}

// ---------- commands ----------

function help() {
  console.log(`Screen Studio MCP ${pkg.version}: record and edit Screen Studio videos from your AI agent

Usage:
  npx screenstudio-mcp              install into Claude Code and Codex, then check this Mac
  npx screenstudio-mcp doctor       check Screen Studio, ffmpeg, permissions
  npx screenstudio-mcp update       reinstall the latest skills and server
  npx screenstudio-mcp uninstall    remove the server and skills
  npx screenstudio-mcp serve        run the MCP server over stdio (what clients launch)

Options:
  --target claude|codex|all   where to install (default: all that are present)
  --local                     register this checkout instead of the npm package
  --force                     replace skill folders with the same names
`);
}

async function install() {
  console.log(`Screen Studio MCP ${pkg.version}\n`);
  const t = targets();
  if (t.claude) await installClaude();
  if (t.codex) await installCodex();
  console.log("");
  await doctor();
  console.log(
    `\nRestart Claude Code or Codex, then ask: "Record a 30-second demo of <your app> in Screen Studio" or "Edit my latest Screen Studio recording".`,
  );
}

if (command === "serve" || (!command && !process.stdin.isTTY && !flag("help"))) {
  await import("../mcp/main.js");
} else if (flag("help") || command === "help") help();
else if (flag("version") || command === "version") console.log(pkg.version);
else {
  try {
    if (!command || command === "install" || command === "update") await install();
    else if (command === "doctor") process.exitCode = (await doctor()) ? 0 : 1;
    else if (command === "uninstall") {
      const t = targets();
      if (t.claude) await uninstallClaude();
      if (t.codex) await uninstallCodex();
    } else {
      help();
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}
