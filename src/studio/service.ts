import { existsSync } from "node:fs";
import { withSession } from "../cdp/client.js";
import { APP_BUILD, PROJECT_SCHEMA } from "./compat.js";
import { exec, findTool, frameAt, probe } from "./media.js";
import { assertUuid, statePath } from "./util.js";
import {
  access,
  copyFile,
  cp,
  link,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
const j = JSON.stringify;

const DEFAULT_PORT = 9222;

/** SCREENSTUDIO_PORT, validated; null when unset or blank. */
export function configuredPort(env: NodeJS.ProcessEnv = process.env): number | null {
  const fixed = env.SCREENSTUDIO_PORT?.trim();
  if (!fixed) return null;
  const port = Number(fixed);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("SCREENSTUDIO_PORT must be an integer from 1024 to 65535.");
  return port;
}

/** The app's main process in `ps -o command=` output, with the debugging port it was started with. */
export function mainProcess(ps: string, appPath: string): { port: number | null } | null {
  const lines = ps.split("\n");
  // The configured copy first; otherwise any Screen Studio.app, wherever macOS put it.
  const line =
    lines.find((l) => l.startsWith(`${appPath}/Contents/MacOS/Screen Studio`)) ??
    lines.find((l) => /^\/.*\/Screen Studio\.app\/Contents\/MacOS\/Screen Studio( |$)/.test(l));
  if (line === undefined) return null;
  const port = Number(/--remote-debugging-port=(\d+)/.exec(line)?.[1]);
  return { port: port >= 1024 && port <= 65535 ? port : null };
}

/** Why launch cannot help with an app that is already running. */
export function runningAppError(
  running: { port: number | null },
  fixed: number | null,
  cause: unknown,
): string {
  const reason = cause instanceof Error ? cause.message : String(cause);
  if (running.port === null)
    return "Screen Studio is running without an automation connection. Ask the owner to quit it (Cmd+Q), then call screenstudio_launch again. Open projects reopen from the Projects folder.";
  if (fixed !== null && fixed !== running.port)
    return `Screen Studio is running with automation on port ${running.port}, but SCREENSTUDIO_PORT is ${fixed}. Set SCREENSTUDIO_PORT to ${running.port} or unset it.`;
  if (fixed === null && reason.includes("editor renderer was not found"))
    return `Port ${running.port} answers, but not as Screen Studio; another app may hold it. Ask the owner to quit Screen Studio (Cmd+Q), then call screenstudio_launch again; it picks a free port.`;
  return `Screen Studio is running with automation on port ${running.port} but did not respond (${reason}). It may be busy exporting, recording or loading; wait and call screenstudio_launch again.`;
}

/**
 * The environment for the spawned app. ELECTRON_RUN_AS_NODE would start it as plain Node,
 * and the app honours NODE_OPTIONS, so neither may leak in from the host running this server.
 */
export function appEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.ELECTRON_RUN_AS_NODE;
  delete out.NODE_OPTIONS;
  return out;
}

function listenOn(port: number): Promise<number | null> {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(null));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      const bound = (server.address() as { port: number }).port;
      server.close(() => done(bound));
    });
  });
}

/** True when something on this machine already serves the port. */
export async function portTaken(port: number): Promise<boolean> {
  // Binding 127.0.0.1 can succeed beside a wildcard listener, so ask whether anyone answers first.
  const answers = await new Promise<boolean>((done) => {
    const socket = connect({ port, host: "127.0.0.1" });
    socket.setTimeout(1000, () => {
      socket.destroy();
      done(false);
    });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
  return answers || (await listenOn(port)) === null;
}

/** The port to launch the app with: SCREENSTUDIO_PORT if free, else 9222, else any free port. */
export async function launchPort(fixed: number | null): Promise<number> {
  if (fixed !== null) {
    if (await portTaken(fixed))
      throw new Error(`Port ${fixed} is in use by another process; set SCREENSTUDIO_PORT to a free port.`);
    return fixed;
  }
  if (!(await portTaken(DEFAULT_PORT))) return DEFAULT_PORT;
  const free = await listenOn(0);
  if (free === null) throw new Error("No free local port for the automation connection.");
  return free;
}

/** Where a cross-volume delivery is copied before it is linked into place. */
export const partialPath = (outputPath: string, jobId: string) => `${outputPath}.partial-${jobId}`;

async function sameFile(a: string, b: string) {
  try {
    const [x, y] = await Promise.all([stat(a), stat(b)]);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/**
 * Puts a rendered file at `out` without ever replacing an existing file. A hard link moves it
 * at no cost; across volumes it is copied beside `out` first, so a partial copy never sits at
 * `out`. The caller removes partialPath() once delivery is recorded; until then a retry after
 * a crash recognises its own earlier link instead of failing on EEXIST.
 */
export async function deliverFile(src: string, out: string, jobId: string) {
  if (await sameFile(src, out)) return;
  try {
    return await link(src, out);
  } catch (e: any) {
    if (!["EXDEV", "EPERM", "ENOTSUP", "EMLINK"].includes(e.code)) throw e;
  }
  const tmp = partialPath(out, jobId);
  if (await sameFile(tmp, out)) return;
  await rm(tmp, { force: true });
  await copyFile(src, tmp, constants.COPYFILE_EXCL);
  await link(tmp, out);
}

/** Refuses an export destination that cannot be written, before any rendering starts. */
export async function assertOutputWritable(outputPath: string) {
  try {
    await stat(outputPath);
    throw new Error("Output already exists; choose a new destination.");
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  const dir = dirname(outputPath);
  if (!(await stat(dir).catch(() => null))?.isDirectory())
    throw new Error(`Output folder ${dir} does not exist.`);
  await access(dir, constants.W_OK).catch(() => {
    throw new Error(`Output folder ${dir} is not writable.`);
  });
}

/**
 * The seek time for a preview frame. An accurate seek drops frames that start before the
 * requested time, so anything after the last frame's start yields no image; times in the
 * final frame interval go back far enough to land on the last frame.
 */
export function previewSeconds(timeMs: number, video: { endSec: number; frameSec: number }) {
  if (!(timeMs >= 0) || timeMs > video.endSec * 1000)
    throw new Error("Preview time is outside the exported playback duration.");
  return Math.min(timeMs / 1000, Math.max(0, video.endSec - video.frameSec * 1.5));
}

const rate = (r?: string) => {
  const [n, d] = String(r ?? "")
    .split("/")
    .map(Number);
  return n > 0 && d > 0 ? n / d : 0;
};

/** When the video stream (not the longest stream) ends, and how long one frame lasts. */
export async function videoTiming(path: string) {
  const { stdout } = await exec(
    await findTool("ffprobe"),
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "format=duration:stream=duration,avg_frame_rate,r_frame_rate",
      "-of",
      "json",
      path,
    ],
    { timeout: 15000, maxBuffer: 1024 * 1024 },
  );
  const { format, streams } = JSON.parse(stdout);
  const v = streams?.[0] ?? {};
  const fps = rate(v.avg_frame_rate) || rate(v.r_frame_rate) || 60;
  return { endSec: Number(v.duration) || Number(format?.duration) || 0, frameSec: 1 / fps };
}

type ExportJob = {
  outputPath: string;
  format: string;
  /** Whether the render used the open editor's project or the saved one. */
  source?: "live" | "disk";
  keepRender?: boolean;
  /** Last status seen from the app; kept in memory only. */
  status?: string;
  renderedPath?: string;
  delivered?: boolean;
  completed?: any;
};
const RUNNING = [undefined, "starting", "rendering"];

export class Studio {
  readonly appPath = resolve(
    process.env.SCREENSTUDIO_APP_PATH ??
      [join(homedir(), "Applications/Screen Studio.app")].find((p) => existsSync(p)) ??
      "/Applications/Screen Studio.app",
  );
  readonly stateDir = resolve(process.env.SCREENSTUDIO_STATE_DIR ?? join(homedir(), ".screenstudio-mcp"));
  private tail: Promise<unknown> = Promise.resolve();
  private jobs = new Map<string, ExportJob>();
  /** The running app's main process, if any. */
  private async running() {
    const { stdout } = await exec("/bin/ps", ["-axww", "-o", "command="], {
      maxBuffer: 16 * 1024 * 1024,
    }).catch(() => ({ stdout: "" }));
    return mainProcess(stdout, this.appPath);
  }
  /** Whether the app is running at all; when it is not, no editor holds unsaved edits. */
  async isRunning() {
    return !!(await this.running());
  }
  /** A fixed port, or the one the running app was launched with. */
  async port(): Promise<number> {
    const fixed = configuredPort();
    if (fixed !== null) return fixed;
    const running = await this.running();
    if (!running) throw new Error("Screen Studio is not running. Call screenstudio_launch.");
    // Never guess a port: whatever answers there may not be Screen Studio.
    if (running.port === null)
      throw new Error(
        "Screen Studio is running without an automation connection. Ask the owner to quit it (Cmd+Q), then call screenstudio_launch.",
      );
    return running.port;
  }
  async evaluate<T = any>(body: string, timeout = 30000): Promise<T> {
    return withSession(await this.port(), (c) =>
      c.evaluateAwait<T>(`(async function(){${body}})()`, timeout),
    );
  }
  /** A file path in the private state directory, which is created on first use. */
  statePath(name: string) {
    return statePath(this.stateDir, name);
  }
  private async getJob(jobId: string) {
    assertUuid(jobId, "Invalid export job ID.");
    let job = this.jobs.get(jobId);
    if (job?.completed) return job;
    // Another server process may have delivered this job since it was cached.
    try {
      const saved: ExportJob = JSON.parse(
        await readFile(join(this.stateDir, `export-${jobId}.json`), "utf8"),
      );
      if (job) Object.assign(job, saved);
      else this.jobs.set(jobId, (job = saved));
    } catch {
      if (!job) throw new Error("Unknown export job.");
    }
    return job;
  }
  private async saveJob(jobId: string) {
    const { status, ...job } = this.jobs.get(jobId)!;
    await writeFile(await this.statePath(`export-${jobId}.json`), j(job), { mode: 0o600 });
  }
  async lock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  async call<T = any>(
    kind: "query" | "mutation",
    route: string,
    input?: unknown,
    timeout = 30000,
  ): Promise<T> {
    return withSession(await this.port(), (c) =>
      c.evaluateAwait<T>(`bridge.client.${kind}(${j(route)},${j(input) ?? "undefined"})`, timeout),
    );
  }
  async subscription<T = any>(route: string, input?: unknown): Promise<T> {
    return withSession(await this.port(), (c) =>
      c.evaluate<T>(
        `return new Promise((resolve,reject)=>{let stop;const timer=setTimeout(()=>{stop?.();reject(new Error('State subscription timed out'));},5000);stop=bridge.client.subscription(${j(route)},${j(input) ?? "undefined"},{onNext(v){if(v.type==='data'){clearTimeout(timer);stop?.();resolve(v.data);}},onError(e){clearTimeout(timer);stop?.();reject(e);}});});`,
      ),
    );
  }
  async version() {
    return this.call<string>("query", "app.version");
  }
  /**
   * The app build, checked. Reading works on any 4.x build. Changing the app
   * (recording, editing, exporting) needs the tested build, or
   * SCREENSTUDIO_ALLOW_UNTESTED=1 to try an untested 4.x build at your own risk.
   */
  async requireVersion(kind: "read" | "write" = "write") {
    const v = await this.version();
    if (v === APP_BUILD) return v;
    const major4 = typeof v === "string" && v.startsWith("4.");
    if (major4 && (kind === "read" || process.env.SCREENSTUDIO_ALLOW_UNTESTED === "1")) return v;
    throw new Error(
      `Unsupported Screen Studio build ${v}. Tested build: ${APP_BUILD}. ${major4 ? "Set SCREENSTUDIO_ALLOW_UNTESTED=1 in the MCP server's environment to try anyway, and turn off Screen Studio's auto-update once it works." : "This adapter supports Screen Studio 4."}`,
    );
  }
  async launch() {
    if (process.platform !== "darwin") throw new Error("Screen Studio requires macOS.");
    const fixed = configuredPort();
    let cause: unknown;
    try {
      return { version: await this.requireVersion("read"), connected: true };
    } catch (e) {
      if (String(e).includes("Unsupported")) throw e;
      cause = e;
    }
    const app = this.appPath;
    await access(join(app, "Contents/MacOS/Screen Studio"));
    // Never restart or kill a running app: Electron's singleton may ignore these flags.
    const running = await this.running();
    if (running) throw new Error(runningAppError(running, fixed, cause));
    const port = await launchPort(fixed);
    // Through LaunchServices, like a double-click: the app keeps its own Screen Recording
    // and microphone permissions instead of borrowing those of the terminal or agent app.
    await exec(
      "/usr/bin/open",
      ["-a", app, "--args", `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"],
      { timeout: 15000, env: appEnv() },
    );
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        return { version: await this.requireVersion("read"), connected: true, port };
      } catch (e) {
        if (String(e).includes("Unsupported")) throw e;
        cause = e;
      }
    }
    const started = await this.running();
    if (!started) throw new Error("Screen Studio quit right after launch.");
    throw new Error(
      `Screen Studio did not expose a connection on port ${port} (${cause instanceof Error ? cause.message : cause}). Inspect the running app; launch was not retried.`,
    );
  }
  /**
   * Quits Screen Studio the way Cmd+Q does, which also closes the automation
   * port. The app asks about unsaved changes itself. Refuses while recording.
   */
  async quit() {
    if (!(await this.running())) return { quit: false, note: "Screen Studio is not running." };
    if (await this.state().catch(() => null))
      throw new Error("A recording is active; finish or cancel it first.");
    await exec("/usr/bin/osascript", ["-e", 'tell application id "com.timpler.screenstudio" to quit'], {
      timeout: 30000,
    });
    for (let i = 0; i < 40; i++) {
      if (!(await this.running())) return { quit: true };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { quit: false, note: "Screen Studio is still open; it may be asking about unsaved changes." };
  }
  async state() {
    await this.requireVersion("read");
    return this.subscription("capture.currentSessionState");
  }
  async sources() {
    await this.requireVersion("read");
    return {
      devices: await this.subscription("capture.inputDiscovery"),
      windows: await this.call("query", "windows.capturableWindows"),
    };
  }
  async start(input: {
    windowId?: number;
    displayId?: number;
    area?: { x: number; y: number; width: number; height: number };
    name: string;
    microphoneDeviceId?: string;
    cameraDeviceId?: string;
    systemAudio?: boolean;
  }) {
    return this.lock(async () => {
      await this.requireVersion();
      if (await this.state()) throw new Error("A recording is already active. Inspect it before continuing.");
      if ((input.windowId === undefined) === (input.displayId === undefined))
        throw new Error("Select exactly one window or display.");
      const sources = await this.sources();
      if (input.windowId !== undefined && !sources.windows.some((w: any) => w.id === input.windowId))
        throw new Error("Recording window is no longer available.");
      if (
        input.displayId !== undefined &&
        !sources.devices.displays.some((d: any) => d.displayID === input.displayId)
      )
        throw new Error("Display is no longer available.");
      const config = {
        windowId: input.windowId ?? null,
        displayId: input.displayId ?? null,
        bounds: input.area ?? null,
        microphoneDeviceId: input.microphoneDeviceId ?? null,
        cameraDeviceId: input.cameraDeviceId ?? null,
        externalDeviceId: null,
        recordSystemAudio: input.systemAudio ? { type: "all" } : null,
        enableScreenCaptureKit: true,
        hideDesktopIcons: false,
        name: input.name,
      };
      const started = await this.call("mutation", "capture.start", { config, defaultConfig: {} }, 60000);
      return { started, state: await this.state() };
    });
  }
  async recordingAction(action: "pause" | "resume" | "finish" | "addMarker" | "restart" | "cancel") {
    return this.lock(async () => {
      await this.requireVersion();
      const state = await this.state();
      if (!state) throw new Error("No recording is active.");
      const type = state.type ?? state.recordingState?.type;
      if (action === "pause" && type !== "recording")
        throw new Error("Recording must be running before pausing.");
      if (action === "resume" && type !== "paused")
        throw new Error("Recording must be paused before resuming.");
      const result = await this.call("mutation", `capture.${action}`, undefined, 120000);
      if (action === "finish") {
        if (result?.type !== "success" || !result.projectPath)
          throw new Error(`Recording did not produce a project: ${j(result)}`);
        await this.path(result.projectPath);
        return result;
      }
      return { result, state: await this.state() };
    });
  }
  async path(path: string) {
    if (!isAbsolute(path) || !path.endsWith(".screenstudio"))
      throw new Error("Use an absolute .screenstudio project path.");
    const p = await realpath(path).catch(() => {
      throw new Error(`No Screen Studio project at ${path}.`);
    });
    if (!(await stat(p)).isDirectory()) throw new Error("Project must be a directory.");
    return p;
  }
  async readProject(path: string) {
    await this.requireVersion("read");
    const projectPath = await this.path(path);
    const data = await this.call("query", "project.readProject", {
      projectPath,
    });
    if (data.projectData?.version !== PROJECT_SCHEMA) throw new Error("Project schema is unsupported.");
    return { projectPath, project: data.projectData };
  }
  async duplicate(path: string, destination: string) {
    return this.lock(async () => {
      const source = await this.path(path);
      if (!isAbsolute(destination) || !destination.endsWith(".screenstudio"))
        throw new Error("Destination must be an absolute .screenstudio path.");
      if (resolve(destination).startsWith(source + "/"))
        throw new Error("Destination cannot be inside the source project.");
      await cp(source, destination, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      return this.readProject(destination);
    });
  }
  async exportStart(
    path: string,
    outputPath: string,
    options: { height: number; fps: number; format: string; quality: string; keepRender?: boolean },
    live?: (projectPath: string) => Promise<any | null>,
  ) {
    return this.lock(async () => {
      outputPath = this.checkOutput(outputPath, options.format);
      await assertOutputWritable(outputPath);
      const p = await this.readProject(path);
      // Render what the editor shows, including unsaved edits. A failed lookup must abort the
      // export rather than quietly render the saved copy.
      const current = live ? await live(p.projectPath) : null;
      if (current) p.project = current;
      return this.render(p, outputPath, options, current ? "live" : "disk");
    });
  }
  /**
   * Renders the given project data instead of the editor's or the saved project, for a
   * variant (another aspect, captions, zooms) that must not touch the editor's state.
   */
  async startRender(
    path: string,
    outputPath: string,
    options: { height: number; fps: number; format: string; quality: string; keepRender?: boolean },
    projectData: any,
    source: "live" | "disk",
  ) {
    return this.lock(async () => {
      outputPath = this.checkOutput(outputPath, options.format);
      await assertOutputWritable(outputPath);
      const p = await this.readProject(path);
      if (projectData?.version !== PROJECT_SCHEMA || !Array.isArray(projectData.scenes))
        throw new Error("Project data to render has an unsupported schema.");
      return this.render({ projectPath: p.projectPath, project: projectData }, outputPath, options, source);
    });
  }
  private checkOutput(outputPath: string, format: string) {
    if (!isAbsolute(outputPath) || !outputPath.endsWith("." + format))
      throw new Error("Output must be an absolute path with matching extension.");
    outputPath = resolve(outputPath);
    for (const job of this.jobs.values())
      if (job.outputPath === outputPath && !job.completed && RUNNING.includes(job.status))
        throw new Error("Another export is already writing to this output; choose a new destination.");
    return outputPath;
  }
  private async render(
    p: { projectPath: string; project: any },
    outputPath: string,
    options: { height: number; fps: number; format: string; quality: string; keepRender?: boolean },
    source: "live" | "disk",
  ) {
    const { keepRender, ...render } = options;
    const jobId = randomUUID();
    const config = {
      ...render,
      target: "file",
      qa: true,
      mp4Codec: "h264",
      projectPath: p.projectPath,
      projectData: p.project,
    };
    this.jobs.set(jobId, { outputPath, format: options.format, source, keepRender, status: "starting" });
    await this.saveJob(jobId);
    await withSession(await this.port(), (c) =>
      c.evaluate(
        `window.__screenstudioMcpJobs??=Object.create(null);const job={status:'starting',createdAt:Date.now()};window.__screenstudioMcpJobs[${j(jobId)}]=job;bridge.client.mutation('export.start',{config:${j(config)},onStarted:id=>{job.exportId=id;job.status='rendering';}}).then(result=>{job.result=result;job.status=result.status;}).catch(error=>{job.status='failed';job.error=String(error);});return {jobId:${j(jobId)}};`,
      ),
    );
    return {
      jobId,
      status: "starting",
      outputPath,
      source,
      ...(source === "disk" && {
        note: "No open editor has this project, so the saved project is rendered; unsaved edits are not included.",
      }),
    };
  }
  /**
   * Polls a job until it stops running (completed, failed, cancelled or delivery_failed).
   * Each poll takes the lock on its own, so recording and other exports are never held up.
   */
  async waitForExport(jobId: string, o: { pollMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}) {
    const pollMs = o.pollMs ?? 1000;
    const until = Date.now() + (o.timeoutMs ?? 20 * 60000);
    for (;;) {
      if (o.signal?.aborted) throw new Error(`Export ${jobId} was cancelled.`);
      const status = await this.exportStatus(jobId);
      if (!RUNNING.includes(status.status)) return status;
      if (Date.now() >= until)
        throw new Error(
          `Export ${jobId} is still ${status.status} after ${Math.round((o.timeoutMs ?? 20 * 60000) / 1000)}s. Poll screenstudio_export_status with this job.`,
        );
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  async exportStatus(jobId: string) {
    return this.lock(() => this.deliverExport(jobId));
  }
  private async deliverExport(jobId: string) {
    const local = await this.getJob(jobId);
    if (local.completed) return local.completed;
    const job = await withSession(await this.port(), (c) =>
      c.evaluate<any>(
        `const job=window.__screenstudioMcpJobs?.[${j(jobId)}];if(!job)throw new Error('Export state was lost. Inspect the app and temporary exports before retrying.');return {...job};`,
      ),
    );
    local.status = job.status;
    if (job.status !== "completed") return { jobId, ...job, source: local.source };
    if (!local.delivered) {
      const dir = await this.call<string>("query", "export.getTempQaExportsPath");
      const candidates = (await readdir(dir)).filter((f) => f.endsWith(`-${job.exportId}.${local.format}`));
      if (candidates.length !== 1) throw new Error("Completed export file could not be uniquely located.");
      const rendered = join(dir, candidates[0]);
      try {
        await deliverFile(rendered, local.outputPath, jobId);
      } catch (e: any) {
        // Terminal: retrying cannot fix a taken or unwritable destination, and the render is kept.
        local.completed = {
          jobId,
          status: "delivery_failed",
          error: e instanceof Error ? e.message : String(e),
          renderedPath: rendered,
          outputPath: local.outputPath,
          source: local.source,
        };
        await this.saveJob(jobId);
        return local.completed;
      }
      local.delivered = true;
      local.renderedPath = rendered;
      await this.saveJob(jobId);
      await rm(partialPath(local.outputPath, jobId), { force: true });
    }
    const media = await this.probe(local.outputPath);
    local.completed = {
      jobId,
      status: "completed",
      outputPath: local.outputPath,
      source: local.source,
      media,
    };
    await this.saveJob(jobId);
    if (!local.keepRender && local.renderedPath)
      await rm(local.renderedPath, { force: true }).catch(() => {});
    return local.completed;
  }
  async exportCancel(jobId: string) {
    await this.getJob(jobId);
    const job = await withSession(await this.port(), (c) =>
      c.evaluate<any>(`return window.__screenstudioMcpJobs?.[${j(jobId)}]??null;`),
    );
    if (!job?.exportId) throw new Error("Export has not started. Inspect its status before cancelling.");
    await this.call("mutation", "export.cancel", { exportId: job.exportId });
    return this.exportStatus(jobId);
  }
  async probe(path: string) {
    const media = await probe(path);
    if (!media.streams.some((s: any) => s.width && s.height) || Number(media.format.duration) <= 0)
      throw new Error("Export file has no playable video.");
    return media;
  }
  async preview(jobId: string, timeMs: number) {
    const job = await this.exportStatus(jobId);
    if (job.status !== "completed")
      throw new Error("Wait for the canonical export to complete before previewing.");
    const video = await videoTiming(job.outputPath);
    const seconds = previewSeconds(timeMs, video);
    const output = await this.statePath(`${jobId}-${Math.floor(timeMs)}.png`);
    await rm(output, { force: true });
    await frameAt(job.outputPath, seconds, output);
    const data = await readFile(output).catch(() => {
      throw new Error(
        `No video frame at ${seconds.toFixed(3)}s; the video ends at ${video.endSec.toFixed(3)}s.`,
      );
    });
    return { path: output, data };
  }
}
