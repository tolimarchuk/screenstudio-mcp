// Transcripts drive captions and speech-aware editing. Generation runs through
// Screen Studio (its on-device "system" recognizer by default); words are mapped
// to source time so cuts never land mid-sentence.
import { pathToFileURL } from "node:url";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Studio } from "./service.js";
import { readRecordingMeta } from "./recording.js";
import type { Span } from "./spans.js";
import { APP_BUILD, TRANSCRIPT_CHUNK, TRANSCRIPT_EXPORT } from "./compat.js";
import { shortHash } from "./util.js";

export interface Word {
  session: number;
  index: number;
  text: string;
  startMs: number; // source time
  endMs: number;
}
/** A word as Screen Studio stores it, in its microphone session's time. */
export interface SessionWord {
  index: number;
  text: string;
  startMs: number;
  endMs: number;
}
export interface WordEdit {
  index: number;
  text?: string;
  remove?: boolean;
}
/** "updated": the open editor shows the new transcript. "not-open": no editor has the project. */
export type EditorSync = "updated" | "not-open";

const FILLERS = /^(um+|uh+|erm+|ah+|hmm+|mm+)$/i;
const j = JSON.stringify;

async function sessionOffsets(projectPath: string): Promise<number[]> {
  return (await readRecordingMeta(projectPath)).sessions.map((s) => s.startMs);
}

/**
 * Applies caption edits to one session's words. Self-contained on purpose:
 * it also runs inside the editor page, so the edit and the write are one step.
 */
export function applyEdits(words: SessionWord[], edits: WordEdit[]) {
  const byIndex = new Map(edits.map((e) => [e.index, e]));
  const missing = edits.find((e) => !words.some((w) => w.index === e.index));
  if (missing) return { error: `Word ${missing.index} does not exist.` };
  const transcript = words
    .filter((w) => !byIndex.get(w.index)?.remove)
    .map((w) => {
      const text = byIndex.get(w.index)?.text;
      return text === undefined ? w : { ...w, text };
    });
  return { transcript, removed: words.filter((w) => byIndex.get(w.index)?.remove) };
}

// The editor's transcript model for the project (`m`), or null when no editor has it open.
function editorModel(studio: Studio, projectPath: string) {
  const url = pathToFileURL(join(studio.appPath, "Contents/Resources/app.asar/dist", TRANSCRIPT_CHUNK)).href;
  return `const p = [...(window.$projects ?? [])].find((x) => x.path === ${j(projectPath)});
    const m = p ? (await import(${j(url)}))[${j(TRANSCRIPT_EXPORT)}](p) : null;
    if (m && !('transcriptPromise' in m && typeof m.updateTranscriptUndoable === 'function'))
      throw new Error('The editor keeps its transcript somewhere else in this build.');`;
}

const firstLine = (e: any) => String(e?.message ?? e).split("\n")[0];

const staleEditor = (cause: string) =>
  new Error(
    `Transcript saved, but the open editor could not reload it (${cause}). Supported build: ${APP_BUILD}. Close and reopen the project before touching captions in the app.`,
  );

/**
 * Reloads the open editor's copy of the transcript so captions update live.
 * The model reads `transcriptPromise.data`, which only the bridge's MobxPromise
 * has; the raw tRPC client returns a plain Promise and blanks the captions.
 */
async function refreshEditor(studio: Studio, projectPath: string): Promise<EditorSync> {
  const state = await studio
    .evaluate<EditorSync | "empty">(
      `${editorModel(studio, projectPath)}
       if (!m) return 'not-open';
       const q = bridge.query('captions.getTranscript', { projectPath: p.path });
       m.transcriptPromise = q; m.dirtyTranscript = null;
       await q.promise.catch(() => {});
       return m.transcriptData ? 'updated' : 'empty';`,
    )
    .catch((e) => {
      throw staleEditor(firstLine(e));
    });
  if (state === "empty") throw staleEditor("it read no transcript back");
  return state;
}

// Words removed from the captions are still spoken. They are kept here, per
// project and session, so cuts keep protecting that speech.
const removedFile = (projectPath: string) => `transcript-removed-${shortHash(projectPath)}.json`;

async function readRemoved(studio: Studio, projectPath: string): Promise<Record<string, SessionWord[]>> {
  try {
    return JSON.parse(await readFile(join(studio.stateDir, removedFile(projectPath)), "utf8"));
  } catch {
    return {};
  }
}

async function keepRemoved(studio: Studio, projectPath: string, session: number, words: SessionWord[]) {
  const store = await readRemoved(studio, projectPath);
  const byIndex = new Map((store[session] ?? []).map((w) => [w.index, w]));
  for (const w of words)
    byIndex.set(w.index, { index: w.index, text: w.text, startMs: w.startMs, endMs: w.endMs });
  store[session] = [...byIndex.values()];
  await writeFile(await studio.statePath(removedFile(projectPath)), j(store), { mode: 0o600 });
}

/**
 * Caption words plus the removed words they no longer show. A removed word is
 * skipped when a caption word covers its time again (undo, or a new transcript).
 */
export function withRemoved(words: Word[], removed: Record<string, SessionWord[]>, offsets: number[]) {
  const out = [...words];
  for (const [key, list] of Object.entries(removed)) {
    const session = Number(key);
    const live = words.filter((w) => w.session === session);
    const offset = offsets[session] ?? 0;
    for (const w of list) {
      const word = {
        session,
        index: w.index,
        text: w.text,
        startMs: w.startMs + offset,
        endMs: w.endMs + offset,
      };
      if (!live.some((x) => x.startMs < word.endMs && x.endMs > word.startMs)) out.push(word);
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Every spoken word, including ones removed from the captions: the speech edits must not cut. */
export async function spokenWords(studio: Studio, projectPath: string) {
  const [{ words }, removed, offsets] = await Promise.all([
    readTranscript(studio, projectPath),
    readRemoved(studio, projectPath),
    sessionOffsets(projectPath),
  ]);
  return withRemoved(words, removed, offsets);
}

export async function readTranscript(studio: Studio, projectPath: string) {
  const offsets = await sessionOffsets(projectPath);
  const data = await studio.evaluate<any[]>(
    `const v = await bridge.client.query('captions.getTranscript', { projectPath: ${j(projectPath)} });
     if (!v) return [];
     return [...v.microphoneSessions.entries()].map(([k, x]) => ({ session: Number(k), generator: x.generator, generatedAt: x.generatedAt, words: x.transcript }));`,
  );
  const words: Word[] = [];
  for (const s of data)
    for (const w of s.words ?? [])
      words.push({
        session: s.session,
        index: w.index,
        text: w.text,
        startMs: w.startMs + (offsets[s.session] ?? 0),
        endMs: w.endMs + (offsets[s.session] ?? 0),
      });
  return { sessions: data.map(({ words: w, ...rest }) => ({ ...rest, words: w?.length ?? 0 })), words };
}

/** Phrases: runs of speech separated by pauses longer than `gapMs`, with trimmed text. */
export function phrases(words: Word[], gapMs = 600) {
  const out: (Span & { text: string; words: number })[] = [];
  for (const w of words) {
    const last = out.at(-1);
    if (last && w.startMs - last.endMs <= gapMs) {
      last.endMs = w.endMs;
      last.text += w.text;
      last.words++;
    } else out.push({ startMs: w.startMs, endMs: w.endMs, text: w.text.trimStart(), words: 1 });
  }
  return out.map((p) => ({ ...p, text: p.text.trim() }));
}

/** A word that ends a sentence: . ? ! an ellipsis or a full-width stop (。！？．), before any closing quote or bracket. */
const SENTENCE_END = /[.?!…。！？．]['"”’）」』)\]]*$/;
/** Abbreviations whose full stop ends nothing, and dotted initialisms (p.m., U.S.). */
const ABBREVIATION =
  /^(?:mr|mrs|ms|dr|st|vs|etc|e\.g|i\.e|inc|jr|sr|approx|(?:\p{L}\.){2,}|(?:\p{L}\.)+\p{L})\.?$/iu;
/** "No." is an abbreviation only before a number ("No. 5"). */
const NUMBER_SIGN = /^no\.$/i;

/**
 * Sentences: the unit of speech beats and camera changes follow. A sentence ends
 * at a word ending in . ? or ! (or a full-width stop), or at a pause of at least
 * `pauseMs`, whichever comes first. Phrases split only on longer pauses, so a
 * phrase boundary is always a sentence boundary too.
 */
export function sentences(words: Pick<Word, "text" | "startMs" | "endMs">[], pauseMs = 350) {
  const out: (Span & { text: string; words: number })[] = [];
  let ended = true;
  for (const [i, w] of words.entries()) {
    const last = out.at(-1);
    if (last && !ended && w.startMs - last.endMs < pauseMs) {
      last.endMs = Math.max(last.endMs, w.endMs);
      last.text += w.text;
      last.words++;
    } else out.push({ startMs: w.startMs, endMs: w.endMs, text: w.text.trimStart(), words: 1 });
    const text = w.text.trim();
    const next = words[i + 1]?.text.trim() ?? "";
    ended =
      SENTENCE_END.test(text) && !ABBREVIATION.test(text) && !(NUMBER_SIGN.test(text) && /^\d/.test(next));
  }
  return out.map((s) => ({ ...s, text: s.text.trim() }));
}

export function fillers(words: Word[]) {
  return words.filter((w) => FILLERS.test(w.text.trim().replace(/[.,!?]/g, "")));
}

export async function generateTranscript(
  studio: Studio,
  projectPath: string,
  generator: Record<string, unknown>,
) {
  await studio.requireVersion();
  await studio.call("mutation", "captions.generateAll", { projectPath, generator }, 600000);
  await rm(join(studio.stateDir, removedFile(projectPath)), { force: true });
  const editor = await refreshEditor(studio, projectPath);
  return { ...(await readTranscript(studio, projectPath)), editor };
}

/**
 * Fix words (spelling, names, punctuation) or drop words from the captions.
 * With the project open, the edit goes through the editor's own transcript
 * model: it lands in the app's undo history and on top of any caption fix the
 * person has not saved yet.
 */
export async function editTranscript(
  studio: Studio,
  projectPath: string,
  session: number,
  edits: WordEdit[],
) {
  await studio.requireVersion();
  const sessionIndex = Number(session);
  const missing = `No transcript for microphone session ${sessionIndex}. Generate one first.`;
  type Result = { error: string } | { removed: SessionWord[] } | null;
  let result = await studio
    .evaluate<Result>(
      `${editorModel(studio, projectPath)}
     if (!m) return null;
     if (!m.isReady) await m.transcriptPromise?.promise.catch(() => {});
     const words = m.maybeDirtyTranscriptData?.microphoneSessions.get(${sessionIndex})?.transcript;
     if (!words) return { error: ${j(missing)} };
     const applyEdits = ${applyEdits};
     const r = applyEdits(words, ${j(edits)});
     if (r.error) return r;
     m.updateTranscriptUndoable(r.transcript, { type: 'microphone-session', sessionIndex: ${sessionIndex} });
     await m.commitSessionTranscript(${sessionIndex});
     return { removed: r.removed };`,
    )
    .catch((e) => {
      throw new Error(
        `The open editor could not take the caption edit (${firstLine(e)}). Supported build: ${APP_BUILD}.`,
      );
    });
  const editor: EditorSync = result ? "updated" : "not-open";
  if (!result) {
    const raw = await studio.evaluate<{ transcript: SessionWord[] } | null>(
      `const v = await bridge.client.query('captions.getTranscript', { projectPath: ${j(projectPath)} });
       return v.microphoneSessions.get(${sessionIndex}) ?? null;`,
    );
    if (!raw) throw new Error(missing);
    const r = applyEdits(raw.transcript, edits);
    if (!("error" in r))
      await studio.call("mutation", "captions.updateTranscript", {
        projectPath,
        transcript: r.transcript,
        location: { type: "microphone-session", sessionIndex },
      });
    result = r;
  }
  if ("error" in result) throw new Error(result.error);
  if (result.removed.length) await keepRemoved(studio, projectPath, sessionIndex, result.removed);
  return { ...(await readTranscript(studio, projectPath)), editor };
}

/** Narration words as Screen Studio stores transcript words: indexed, a space before every word but the first. */
export function narrationTranscript(
  words: { text: string; startMs: number; endMs: number }[],
): SessionWord[] {
  return words.map((w, i) => ({
    index: i,
    text: i ? ` ${w.text.trim()}` : w.text.trim(),
    startMs: Math.round(w.startMs),
    endMs: Math.round(Math.max(w.startMs, w.endMs)),
  }));
}

/**
 * Writes narration words (source ms) as the transcript of microphone session 0,
 * so the app's own caption renderer shows the narration. Only for recordings
 * without a microphone, where no spoken transcript can be overwritten. The app
 * is asked to keep the words and they are read back; any failure throws, so the
 * caller can fall back to a burn-in subtitle file.
 */
export async function writeNarrationTranscript(
  studio: Studio,
  projectPath: string,
  words: { text: string; startMs: number; endMs: number }[],
) {
  await studio.requireVersion();
  const transcript = narrationTranscript(words);
  await studio
    .call("mutation", "captions.updateTranscript", {
      projectPath,
      transcript,
      location: { type: "microphone-session", sessionIndex: 0 },
    })
    .catch((error) => {
      // This build keeps captions only for a recorded microphone; a recording
      // without one has no transcript file for the words to go into.
      if (/transcript file not found/i.test(String(error?.message ?? error)))
        throw new Error("Screen Studio shows captions only for recordings with a microphone");
      throw error;
    });
  const back = await readTranscript(studio, projectPath);
  const kept = back.words.filter((w) => w.session === 0).length;
  if (kept !== transcript.length)
    throw new Error(`Screen Studio kept ${kept} of ${transcript.length} caption words.`);
  let editor: EditorSync | "stale" = "not-open";
  try {
    editor = await refreshEditor(studio, projectPath);
  } catch {
    editor = "stale";
  }
  return { words: transcript.length, editor };
}
