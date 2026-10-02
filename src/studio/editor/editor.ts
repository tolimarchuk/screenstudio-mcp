// Edits happen in Screen Studio's open editor window, through the same model the
// UI uses: changes appear live, land in the app's undo history, and save the way
// Cmd+S does. Nothing rewrites project files behind the editor's back.
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Studio } from "../service.js";
import { Desktop } from "../desktop.js";
import { editorWindowTitle } from "../compat.js";
import { captureWindow, cropPng, exec } from "../media.js";
import { readRecordingMeta } from "../recording.js";
import { round } from "../timeline.js";
import { assertUuid } from "../util.js";
import { describeScene } from "./describe.js";
import { prepareOps, type EditOp } from "./ops.js";
import { PRELUDE, applyScript } from "./page.js";
const j = JSON.stringify;

/** Size of the captured window or display, in the points mask bounds use. */
async function captureSize(projectPath: string) {
  try {
    const b = (await readRecordingMeta(projectPath)).sessions[0].bounds;
    return { width: b.width, height: b.height };
  } catch {
    return { width: 1920, height: 1080 };
  }
}

export class Editor {
  private tails = new Map<string, Promise<unknown>>();
  constructor(
    private studio: Studio,
    private desktop = new Desktop(),
  ) {}

  /**
   * Runs one change to a project after the previous one finishes, so a paced
   * apply is never interleaved with another write, undo or playhead move. Per
   * project rather than Studio.lock, so a long apply never stalls recording or exports.
   */
  private async locked<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(path) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((r) => (release = r));
    this.tails.set(path, tail);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(path) === tail) this.tails.delete(path);
    }
  }

  private run<T = any>(body: string, timeout = 30000): Promise<T> {
    return this.studio.evaluate<T>(PRELUDE + body, timeout);
  }

  async list() {
    await this.studio.requireVersion("read");
    return this.run<any[]>(
      `return __ss.contexts().map((c) => ({ projectPath: c.project.path, name: c.project.name, dirty: c.project.isDirty, focused: c === window.$$focused, playbackDurationMs: Math.round(c.project.playbackDurationMs) }));`,
    );
  }

  async open(projectPath: string) {
    const path = await this.studio.path(projectPath);
    await this.studio.requireVersion("read");
    const already = (await this.list()).some((e) => e.projectPath === path);
    if (!already) {
      await exec("/usr/bin/open", ["-a", this.studio.appPath, path], { timeout: 15000 });
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if ((await this.list()).some((e) => e.projectPath === path)) break;
      }
    }
    await this.run(
      `const c = __ss.get(${j(path)}); try { c.view.targetWindow.focus(); } catch {} return true;`,
    ).catch(() => {
      throw new Error("Screen Studio did not open the project editor. Inspect the app before retrying.");
    });
    return this.state(path);
  }

  async raw(projectPath: string) {
    const path = await this.studio.path(projectPath);
    return this.run<any>(`return __ss.summary(__ss.get(${j(path)}));`);
  }

  async state(projectPath: string) {
    const s = await this.raw(projectPath);
    return {
      projectPath: s.projectPath,
      name: s.name,
      unsavedChanges: s.dirty,
      playheadMs: round(s.playheadMs),
      playing: s.playing,
      playbackDurationMs: round(s.playbackDurationMs),
      sourceDurationMs: round(s.sourceDurationMs),
      canUndo: s.canUndo,
      canRedo: s.canRedo,
      editRunning: s.editRunning,
      scenes: s.scenes.map((sc: any) => ({
        id: sc.id,
        name: sc.name,
        ...describeScene(sc),
        voiceOvers: sc.voiceOvers.length,
      })),
      style: {
        screenSpring: s.config.animations.screenMovementSpring,
        cursorSpring: s.config.animations.mouseMovementSpring,
        motionBlur: s.config.animations.motionBlurAmount,
        zoomsStartEarly: s.config.zooms.startAnimationEarly,
        cursor: {
          size: s.config.cursor.size,
          hide: s.config.cursor.hide,
          hideWhenStillMs: s.config.cursor.hideNotMovingAfterMs,
          clickEffect: s.config.cursor.clickEffect,
          stopMovementInLastPartMs: s.config.cursor.stopMovementInLastPartMs,
        },
        output: s.config.output,
        background: {
          type: s.config.styles.background.type,
          color: s.config.styles.background.color,
          systemName: s.config.styles.background.systemName,
        },
        padding: s.config.output.paddingRatio01,
        borderRadius: s.config.styles.screenBorderRadius,
      },
    };
  }

  /**
   * The editor's live project data, or null when the app is closed or the project is not
   * open. A failed lookup in a running app throws, so callers never fall back to a stale save.
   */
  async liveProject(projectPath: string): Promise<any | null> {
    if (!(await this.studio.isRunning())) return null;
    return this.run(
      `const c = __ss.contexts().find((c) => c.project.path === ${j(projectPath)});
       if (c && __ss.busy()[c.project.path]) throw new Error('An edit is still being applied to this project; try again when it finishes.');
       return c ? c.project.serialize() : null;`,
    );
  }

  /**
   * Applies ops after saving a checkpoint. When an op fails partway, the ops
   * before it stay applied and the result says so (partial, failedAt, error)
   * with the checkpointId that undoes the whole batch.
   */
  async apply(
    projectPath: string,
    sceneId: string | undefined,
    ops: EditOp[],
    show?: { stepMs: number },
    options: { save?: boolean; signal?: AbortSignal } = {},
  ) {
    const path = await this.studio.path(projectPath);
    await this.studio.requireVersion();
    return this.locked(path, async () => {
      const before = await this.raw(path);
      const scene = sceneId ? before.scenes.find((s: any) => s.id === sceneId) : before.scenes[0];
      if (!scene) throw new Error("Scene does not exist.");
      const source = Math.max(...scene.slices.map((s: any) => s.sourceEndMs), before.sourceDurationMs);
      // Validate everything before touching the editor.
      const prepared = prepareOps(ops, {
        sourceMs: source,
        config: before.config,
        captureSize: await captureSize(path),
        tracks: { zooms: scene.zooms, layouts: scene.layouts, masks: scene.masks },
      });
      const checkpointId = randomUUID();
      await writeFile(
        await this.studio.statePath(`editor-${checkpointId}.json`),
        j({
          projectPath: path,
          sceneId: scene.id,
          slices: scene.slices,
          zooms: scene.zooms,
          layouts: scene.layouts,
          masks: scene.masks,
          voiceOvers: scene.voiceOvers,
          config: before.config,
        }),
        { mode: 0o600, flag: "wx" },
      );
      let run: { results: any[]; failedAt?: number; error?: string };
      // Cancelling stops the batch between ops; the checkpoint still undoes what ran.
      const cancel = () => {
        this.run(`const b = __ss.busy()[${j(path)}]; if (b) b.cancel = true; return true;`).catch(() => {});
      };
      options.signal?.addEventListener("abort", cancel, { once: true });
      try {
        run = await this.run(applyScript(path, scene.id, prepared, show), show ? 600000 : 30000);
      } catch (e) {
        const err = new Error(
          `${e instanceof Error ? e.message : String(e)} Some ops may have been applied; screenstudio_editor_restore with checkpointId ${checkpointId} puts the editor back.`,
        );
        Object.assign(err, { checkpointId });
        throw err;
      } finally {
        options.signal?.removeEventListener("abort", cancel);
      }
      if (run.failedAt === undefined) {
        // Saved inside the same lock, so no other call's edit lands between apply and save.
        if (options.save) await this.saveNow(path);
        return { results: run.results, checkpointId, ...(options.save ? { saved: true } : {}) };
      }
      return {
        partial: true,
        failedAt: run.failedAt,
        error: `Op ${run.failedAt} (${ops[run.failedAt]?.op}) failed: ${run.error} The ops before it are applied; screenstudio_editor_restore with checkpointId ${checkpointId} undoes the whole batch.`,
        results: run.results,
        checkpointId,
      };
    });
  }

  async restore(checkpointId: string) {
    assertUuid(checkpointId, "Invalid checkpoint.");
    await this.studio.requireVersion();
    const saved = JSON.parse(
      await readFile(join(this.studio.stateDir, `editor-${checkpointId}.json`), "utf8"),
    );
    return this.locked(saved.projectPath, async () => {
      await this.run(`
        const c = __ss.edit(${j(saved.projectPath)});
        const sc = __ss.scene(c, ${j(saved.sceneId)});
        const voiceOvers = ${j(saved.voiceOvers ?? null)};
        if (voiceOvers && typeof sc.voiceOvers.replace !== 'function') {
          const now = c.project.serialize().scenes.find((s) => s.id === sc.id).voiceOvers;
          if (JSON.stringify(now) !== JSON.stringify(voiceOvers)) throw new Error('This Screen Studio build cannot put voiceovers back; nothing was restored.');
        }
        sc.slices.replace(${j(saved.slices)});
        sc.zooms.replace(${j(saved.zooms)});
        if (${j(!!saved.layouts)}) sc.layouts.replace(${j(saved.layouts ?? [])});
        if (${j(!!saved.masks)}) sc.masks.replace(${j(saved.masks ?? [])});
        if (voiceOvers && typeof sc.voiceOvers.replace === 'function') sc.voiceOvers.replace(voiceOvers);
        const cfg = ${j(saved.config)};
        c.project.projectConfig.update({ crop: cfg.crop, cursor: cfg.cursor, animations: cfg.animations, zooms: cfg.zooms, output: cfg.output, styles: cfg.styles, captions: cfg.captions, audio: cfg.audio, camera: cfg.camera, processing: cfg.processing, defaultLayout: cfg.defaultLayout, device: cfg.device });
        return true;
      `);
      return saved.projectPath as string;
    });
  }

  async history(projectPath: string, action: "undo" | "redo", steps: number) {
    const path = await this.studio.path(projectPath);
    await this.studio.requireVersion();
    return this.locked(path, () =>
      this.run(`
      const h = __ss.edit(${j(path)}).project.history;
      let done = 0;
      for (let i = 0; i < ${Number(steps)}; i++) {
        if (!(${action === "undo" ? "h.canUndo" : "h.canRedo"})) break;
        h.${action}(); done++;
      }
      return { done, canUndo: h.canUndo, canRedo: h.canRedo };
    `),
    );
  }

  async save(projectPath: string) {
    const path = await this.studio.path(projectPath);
    await this.studio.requireVersion();
    return this.locked(path, () => this.saveNow(path));
  }

  /** Same steps as the editor's own save: serialize, write through the app, mark saved. Caller holds the lock. */
  private saveNow(path: string) {
    return this.run(
      `
      const p = __ss.edit(${j(path)}).project;
      const generation = p.editGeneration;
      await bridge.client.mutation('project.updateProject', { projectPath: p.path, data: p.serialize() });
      p.markAsJustSaved(generation);
      return { saved: true, unsavedChanges: p.isDirty };
    `,
      60000,
    );
  }

  async seek(projectPath: string, at: { playbackMs?: number; sourceMs?: number }) {
    const path = await this.studio.path(projectPath);
    return this.locked(path, () =>
      this.run(`
      const pb = __ss.edit(${j(path)}).playback;
      pb.pause();
      ${at.sourceMs !== undefined ? `pb.goToSourceTime(${Number(at.sourceMs)});` : `pb.goTo(${Number(at.playbackMs ?? 0)});`}
      return { playheadMs: Math.round(pb.playbackTimeMs) };
    `),
    );
  }

  async play(projectPath: string, fromMs: number, toMs?: number) {
    const path = await this.studio.path(projectPath);
    return this.locked(path, () =>
      this.run(`
      const pb = __ss.edit(${j(path)}).playback;
      clearInterval(window.__ssmcpStop);
      pb.playAt(${Number(fromMs)});
      ${toMs !== undefined ? `window.__ssmcpStop = setInterval(() => { if (!pb.isPlaying || pb.playbackTimeMs >= ${Number(toMs)}) { clearInterval(window.__ssmcpStop); pb.pause(); } }, 30);` : ""}
      return { playing: true, fromMs: ${Number(fromMs)}, toMs: ${toMs ?? "null"} };
    `),
    );
  }

  /** Captures the editor's preview canvas at a playback time, as rendered by the app. */
  async frame(projectPath: string, playbackMs: number) {
    return (await this.frames(projectPath, [playbackMs]))[0];
  }

  /** Captures several playback times in one go: the window is looked up once for all of them. */
  async frames(projectPath: string, playbackMs: number[]) {
    const path = await this.studio.path(projectPath);
    return this.locked(path, async () => {
      const window = await this.frameWindow(path);
      const out = [];
      for (const t of playbackMs) out.push(await this.captureAt(path, window, t));
      return out;
    });
  }

  /** The editor window's id and where its preview canvas sits, in window points. */
  private async frameWindow(path: string) {
    const tag = `ssmcp-${randomUUID().slice(0, 8)}`;
    const info = await this.run<any>(`
      const c = __ss.edit(${j(path)});
      const w = c.view.targetWindow;
      // The preview draws at the display's pixel ratio; panel backdrops are canvases
      // too, drawn at 1x, and can be larger than the preview in a small window.
      const all = [...w.document.querySelectorAll('canvas')].map((el) => ({ el, r: el.getBoundingClientRect() })).filter((x) => x.r.width > 0 && x.r.height > 0).sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
      const sharp = all.filter((x) => x.el.width >= x.r.width * Math.min(1.5, w.devicePixelRatio || 1) - 1);
      const canvas = (w.devicePixelRatio > 1 && sharp.length ? sharp : all)[0];
      if (!canvas) throw new Error('The editor preview is not visible.');
      const title = w.document.title;
      w.document.title = ${j(tag)};
      return { title, x: canvas.r.x, y: canvas.r.y, width: canvas.r.width, height: canvas.r.height, outerWidth: w.outerWidth, outerHeight: w.outerHeight, innerHeight: w.innerHeight, name: c.project.name };
    `);
    let windowId: number;
    try {
      await new Promise((r) => setTimeout(r, 150));
      windowId = await this.desktop.findWindowByTitle(tag);
    } finally {
      await this.run(
        `__ss.get(${j(path)}).view.targetWindow.document.title = ${j(info.title ?? editorWindowTitle(info.name))}; return true;`,
      ).catch(() => {});
    }
    return { windowId, tag, canvas: info as Record<string, number> };
  }

  /** Moves the playhead, waits for the preview to draw, and crops the window shot to the canvas. */
  private async captureAt(
    path: string,
    window: Awaited<ReturnType<Editor["frameWindow"]>>,
    playbackMs: number,
  ) {
    const playheadMs = await this.run<number>(`
      const c = __ss.edit(${j(path)});
      c.playback.pause();
      c.playback.goTo(${Number(playbackMs)});
      await new Promise((r) => setTimeout(r, 700));
      return Math.round(c.playback.playbackTimeMs);
    `);
    const { tag, canvas: info } = window;
    const full = await this.studio.statePath(`editor-window-${tag}.png`);
    const out = join(this.studio.stateDir, `editor-frame-${tag}-${round(playbackMs)}.png`);
    try {
      await captureWindow(window.windowId, full);
      const png = await readFile(full);
      // PNG width sits at byte 16 of the header; it gives the screen's backing scale.
      const scale = png.readUInt32BE(16) / info.outerWidth;
      const top = info.outerHeight - info.innerHeight;
      const px = (v: number) => Math.round(v * scale);
      await cropPng(full, out, {
        x: px(info.x),
        y: px(info.y + top),
        width: px(info.width),
        height: px(info.height),
      });
    } finally {
      // The whole-window shot is only a step on the way to the cropped frame.
      await rm(full, { force: true }).catch(() => {});
    }
    return { path: resolve(out), playheadMs, data: await readFile(out) };
  }

  /** Editor interface: open a panel, select an item, zoom the timeline, show or hide parts. */
  async view(
    projectPath: string,
    v: {
      panel?: string;
      select?: { track: string; id: string };
      timelineMs?: number;
      sidebar?: boolean;
      timeline?: boolean;
      previewOnly?: boolean;
      close?: boolean;
    },
  ) {
    const path = await this.studio.path(projectPath);
    return this.locked(path, () =>
      this.run(`
      const c = __ss.edit(${j(path)}); const view = c.view; const v = ${j(v)};
      if (v.panel) view.setSidebarRoot(v.panel);
      if (v.select) { const kind = { zooms: ['zoom', 'zoomId'], masks: ['mask', 'maskId'], layouts: ['layout', 'layoutId'], slices: ['slice', 'sliceId'] }[v.select.track]; if (!kind) throw new Error('Unknown track ' + v.select.track); view.setSidebarItem({ type: kind[0], [kind[1]]: v.select.id }); }
      if (v.close) view.closeSidebarItem?.();
      if (v.timelineMs) view.setVisiblePlaybackDurationMs(v.timelineMs);
      if (v.sidebar !== undefined && view.shouldShowSidebar !== v.sidebar) view.toggleSidebar();
      if (v.timeline !== undefined && view.shouldShowTimeline !== v.timeline) view.toggleTimeline();
      if (v.previewOnly !== undefined) { const only = !view.shouldShowSidebar && !view.shouldShowTimeline; if (only !== v.previewOnly) view.togglePreview(); }
      await new Promise((r) => setTimeout(r, 600));
      return { panel: view.sidebarRoot, item: view.sidebarItem, timelineMs: Math.round(view.pendingVisiblePlaybackDurationMs ?? view.visiblePlaybackDurationMs), sidebar: view.shouldShowSidebar, timeline: view.shouldShowTimeline };
    `),
    );
  }

  /** Sets the project's audio track settings in the editor (used by narration). */
  async setAudio(projectPath: string, audio: Record<string, unknown>) {
    const path = await this.studio.path(projectPath);
    return this.locked(path, () =>
      this.run(`__ss.edit(${j(path)}).project.projectConfig.update({ audio: ${j(audio)} }); return true;`),
    );
  }
}
