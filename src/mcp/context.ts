// State the tools share: one connection to the app, one editor driver, one
// desktop driver (observation tokens live there) and the analysis cache.
import { Studio } from "../studio/service.js";
import { Desktop } from "../studio/desktop.js";
import { Editor } from "../studio/editor/editor.js";
import { analyzeRecording, type Analysis } from "../studio/recording.js";
import { fillers, phrases, sentences, spokenWords } from "../studio/transcript.js";
import { checkPacing } from "../studio/pacing.js";
import { findValleys, micLevels, type Level } from "../studio/audio.js";
import type { Style } from "../studio/styles.js";

export type Timeline = Awaited<ReturnType<Context["timeline"]>>;

export class Context {
  readonly studio = new Studio();
  readonly desktop = new Desktop();
  readonly editor = new Editor(this.studio, this.desktop);
  private analyses = new Map<string, Analysis>();
  private levels = new Map<string, Level[]>();

  async analysisFor(projectPath: string, includeText = false) {
    const p = await this.studio.path(projectPath);
    const key = `${p}:${includeText}`;
    let a = this.analyses.get(key);
    if (!a) {
      a = await analyzeRecording(p, { includeText, cacheDir: this.studio.stateDir });
      // A degraded result (ffmpeg missing, unreadable video) is retried on the next call.
      if (!a.screen.unavailable) this.analyses.set(key, a);
    }
    // Speech comes from the transcript, which can change; read it fresh.
    const words = await spokenWords(this.studio, p).catch(() => []);
    a.speech = phrases(words, 600);
    a.sentences = sentences(words);
    a.fillers = fillers(words).map((w) => ({ startMs: w.startMs, endMs: w.endMs, text: w.text.trim() }));
    const audio = await this.levelsFor(p);
    a.valleys = findValleys(audio.levels, a.sentences);
    if (audio.unavailable) a.valleysUnavailable = audio.unavailable;
    else delete a.valleysUnavailable;
    return a;
  }

  /** The microphone's loudness envelope; kept once read, retried after a failure. */
  private async levelsFor(projectPath: string) {
    const known = this.levels.get(projectPath);
    if (known) return { levels: known };
    const read = await micLevels(projectPath).catch((e) => ({
      levels: [] as Level[],
      unavailable: String(e?.message ?? e),
    }));
    if (!read.unavailable) this.levels.set(projectPath, read.levels);
    return read;
  }

  /** An analysis already made for this project, without running a new one. */
  cachedAnalysis(projectPath: string) {
    return this.analyses.get(`${projectPath}:false`) ?? this.analyses.get(`${projectPath}:true`);
  }

  /** The scene as the editor shows it, or as saved when the project is not open. */
  async timeline(projectPath: string, sceneId?: string) {
    const p = await this.studio.path(projectPath);
    const live = await this.editor.liveProject(p);
    const project = live ?? (await this.studio.readProject(p)).project;
    const scene = sceneId ? project.scenes.find((s: any) => s.id === sceneId) : project.scenes[0];
    if (!scene) throw new Error("Scene does not exist.");
    return { project, scene, live: !!live, projectPath: p };
  }
}

/** Pacing and visual-settings check of a timeline, with its own spring, settings and camera layouts. */
export function pacingFor(
  t: Timeline,
  analysis: Analysis | undefined,
  style: Style,
  extra?: Parameters<typeof checkPacing>[3],
) {
  return checkPacing(
    {
      slices: t.scene.slices,
      zooms: t.scene.zooms,
      screenSpring: t.project.config.animations?.screenMovementSpring,
      config: t.project.config,
      layouts: t.scene.layouts,
    },
    analysis,
    style,
    extra,
  );
}
