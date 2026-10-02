// Cutting on the audio valley: sentences spoken back to back leave no pause in
// the transcript, but the microphone dips between them. A deep dip makes the
// boundary cuttable and the cut sits in its middle; a shallow one does not, and
// without microphone data the planner keeps to transcript pauses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planEdit } from "../dist/studio/plan.js";
import { checkPacing } from "../dist/studio/pacing.js";
import { findValleys, micLevels, parseLevels, quietValley, VALLEY_DB } from "../dist/studio/audio.js";
import { phrases, sentences } from "../dist/studio/transcript.js";

/** Words of each line, 320ms apart and 260ms long: 60ms between words, plus `pauseMs` after each line. */
function talk(lines, pauseMs = 0) {
  const words = [];
  let t = 600;
  for (const line of lines) {
    for (const w of line.split(" ")) {
      words.push({ session: 0, index: words.length, text: ` ${w}`, startMs: t, endMs: t + 260 });
      t += 320;
    }
    t += pauseMs;
  }
  const end = t + 2500;
  return {
    words,
    projectPath: "/x.screenstudio",
    sourceDurationMs: end,
    capture: { kind: "window", widthPt: 1440, heightPt: 900 },
    sessions: [{ startMs: 0, endMs: end, video: "" }],
    clicks: [],
    typing: [],
    shortcuts: [],
    movement: [],
    screen: { changes: [], active: [] },
    idle: [],
    speech: phrases(words, 600),
    sentences: sentences(words),
    hasCamera: false,
    hasMicrophone: true,
  };
}

/** A valley `quietDb` below speech in the middle of every sentence boundary. */
const withValleys = (a, quietDb) => ({
  ...a,
  valleys: a.sentences.slice(1).map((n, i) => {
    const p = a.sentences[i];
    return {
      afterMs: p.endMs,
      beforeMs: n.startMs,
      atMs: Math.round((p.endMs + n.startMs) / 2),
      quietDb,
      widthMs: 50,
    };
  }),
});

const LINES = [
  "Here is the dashboard our support team opens every morning.",
  "The queue on the left sorts every ticket by how urgent it is.",
  "Um so yeah basically.",
  "Each ticket shows the customer, the plan they pay for and the last reply.",
  "Replying from here sends the answer and closes the ticket in one step.",
];
const TARGET = 15000;
const dropsFiller = (plan) => plan.droppedBeats.some((d) => d.label.includes("Um so yeah"));

test("a 60ms pause with a deep audio valley becomes cuttable: fit-to-length drops the weak sentence there", () => {
  const a = withValleys(talk(LINES), -20);
  const filler = a.sentences.find((s) => s.text.startsWith("Um so"));
  const before = a.sentences[a.sentences.indexOf(filler) - 1];
  const after = a.sentences[a.sentences.indexOf(filler) + 1];
  assert.equal(filler.startMs - before.endMs, 60);
  // Without the audio no sentence can go: every boundary has only 60ms of pause.
  const deaf = planEdit(talk(LINES), { targetMs: 18500 });
  assert.equal(deaf.fit.fitted, false, deaf.summary);
  assert.deepEqual(deaf.droppedBeats, []);
  const plan = planEdit(a, { targetMs: 18500 });
  assert.deepEqual(
    plan.droppedBeats.map((d) => d.label),
    ['says "Um so yeah basically."'],
  );
  assert.ok(plan.fit.fitted, plan.summary);
  assert.ok(!plan.beats.find((b) => b.label.includes("Um so yeah")).kept);
  // The cut runs from the valley before the filler to the valley after it.
  const out = a.valleys.find((v) => v.beforeMs === filler.startMs).atMs;
  const back = a.valleys.find((v) => v.afterMs === filler.endMs).atMs;
  assert.equal(plan.slices.length, 2, JSON.stringify(plan.slices));
  assert.equal(plan.slices[0].endMs, out);
  assert.equal(plan.slices[1].startMs, back);
  assert.ok(out > before.endMs && back < after.startMs);
  assert.ok(
    plan.notes.some((n) =>
      /^0:08 cut in the breath after "\.\.\.urgent it is\." \(audio dips 20dB\) and back in the breath before "Each ticket shows\.\.\." \(audio dips 20dB\); the transcript shows only a 60ms pause/.test(
        n,
      ),
    ),
    plan.notes.join("\n"),
  );
  // The pacing check reads cuts on valleys as cuts between sentences.
  const codes = plan.pacing.issues.map((i) => i.code);
  assert.ok(!codes.includes("tight-cut") && !codes.includes("mid-phrase-cut"), JSON.stringify(codes));
  // Every word kept is whole: no cut lands inside a recognized word.
  for (const s of plan.slices)
    for (const w of a.words) {
      assert.ok(!(s.endMs > w.startMs && s.endMs < w.endMs), `cut out inside "${w.text}" at ${s.endMs}`);
      assert.ok(!(s.startMs > w.startMs && s.startMs < w.endMs), `cut in inside "${w.text}" at ${s.startMs}`);
    }
});

test("a shallow valley keeps the boundary uncuttable", () => {
  const shallow = withValleys(talk(LINES), -(VALLEY_DB - 4));
  assert.ok(!quietValley(shallow.valleys[0]));
  const plan = planEdit(shallow, { targetMs: TARGET });
  assert.ok(!dropsFiller(plan), JSON.stringify(plan.droppedBeats));
  assert.equal(plan.fit.fitted, false);
  assert.ok(plan.summary.includes("no pause around it to cut in"), plan.summary);
  assert.ok(!plan.notes.some((n) => n.includes("breath")), plan.notes.join("\n"));
  // Exactly as if there were no valleys at all.
  const none = planEdit({ ...talk(LINES) }, { targetMs: TARGET });
  assert.deepEqual(plan.slices, none.slices);
});

test("without microphone data the planner keeps to transcript pauses", () => {
  const a = { ...talk(LINES), hasMicrophone: false, valleysUnavailable: "the recording has no microphone" };
  const plan = planEdit(a, { targetMs: TARGET });
  assert.ok(!dropsFiller(plan), JSON.stringify(plan.droppedBeats));
  assert.ok(plan.summary.includes("no audio valleys either: the recording has no microphone"), plan.summary);
  // A roomy pause still cuts with a breath, valleys or not.
  const roomy = talk(LINES, 300);
  const fitted = planEdit(roomy, { targetMs: 20000 });
  assert.ok(dropsFiller(fitted), JSON.stringify(fitted.droppedBeats));
  const deep = planEdit(withValleys(roomy, -30), { targetMs: 20000 });
  assert.deepEqual(deep.slices, fitted.slices, "a transcript pause with a breath keeps its cut");
});

test("the pacing check accepts a cut on a quiet valley and still flags one off it", () => {
  const speech = [{ startMs: 1000, endMs: 13000, text: "First line here. Second line there." }];
  const lines = [
    { startMs: 1000, endMs: 6000, text: "First line here.", words: 3 },
    { startMs: 6040, endMs: 13000, text: "Second line there.", words: 3 },
  ];
  const report = (out, back, valleys) =>
    checkPacing(
      {
        slices: [
          { sourceStartMs: 0, sourceEndMs: out, timeScale: 1 },
          { sourceStartMs: back, sourceEndMs: 15000, timeScale: 1 },
        ],
        zooms: [],
      },
      { clicks: [], typing: [], sourceDurationMs: 15000, speech, sentences: lines, valleys },
    ).issues.map((i) => i.code);
  const deep = [{ afterMs: 6000, beforeMs: 6040, atMs: 6020, quietDb: -22, widthMs: 40 }];
  const shallow = [{ ...deep[0], quietDb: -6 }];
  assert.ok(report(6020, 9000, []).includes("tight-cut"));
  assert.ok(!report(6020, 9000, deep).includes("tight-cut"));
  assert.ok(report(6020, 9000, shallow).includes("tight-cut"));
  // A cut back in on the valley before a sentence is fine too.
  assert.ok(!report(3000, 6020, deep).includes("tight-cut"));
  assert.ok(report(3000, 6020, []).includes("tight-cut"));
});

/** ffmpeg's ametadata print output for frame levels, 10ms apart. */
const ffmpegOutput = (dbs) =>
  dbs
    .map(
      (db, i) =>
        `frame:${i}    pts:${i * 80}      pts_time:${(i / 100).toFixed(2)}\nlavfi.astats.1.RMS_level=${db}`,
    )
    .join("\n") + "\n";

test("levels parse from ffmpeg's per-frame output, in source time", () => {
  const levels = parseLevels(ffmpegOutput(["-inf", "-88.5", "-20.25", "-19"]), 1000, 1030);
  assert.deepEqual(levels, [
    { t: 1000, db: -100 },
    { t: 1010, db: -88.5 },
    { t: 1020, db: -20.25 },
  ]);
  assert.deepEqual(parseLevels(""), []);
});

test("the valley search finds the quietest 40ms between two sentences, its depth and width", () => {
  // 0-1s speech at -20dB, a shallow dip in the first sentence's last word, a
  // 60ms dip to -50dB starting at 1.04s, then speech again.
  const dbs = Array.from({ length: 200 }, (_, i) => {
    if (i >= 104 && i < 110) return -50;
    if (i >= 90 && i < 94) return -27;
    return i % 2 ? -19 : -21;
  });
  const levels = parseLevels(ffmpegOutput(dbs), 5000);
  const said = [
    { startMs: 5000, endMs: 6000 },
    { startMs: 6020, endMs: 7000 },
  ];
  const [v] = findValleys(levels, said);
  assert.equal(v.afterMs, 6000);
  assert.equal(v.beforeMs, 6020);
  assert.equal(v.atMs, 6070);
  assert.equal(v.widthMs, 60);
  assert.ok(v.quietDb <= -29 && v.quietDb >= -31, `${v.quietDb}`);
  assert.ok(quietValley(v));
  // No levels over the boundary: no valley rather than a guess.
  assert.deepEqual(
    findValleys(
      levels.filter((l) => l.t < 5800 || l.t > 6300),
      said,
    ),
    [],
  );
  // A single sentence has no boundary.
  assert.deepEqual(findValleys(levels, said.slice(0, 1)), []);
});

test("microphone levels degrade to none with the reason", async () => {
  const dir = await mkdtemp(join(tmpdir(), "valleys-"));
  try {
    const project = join(dir, "p.screenstudio");
    await mkdir(join(project, "recording"), { recursive: true });
    const screen = { type: "display", sessions: [{ durationMs: 5000, outputFilename: "screen.mp4" }] };
    const write = (recorders) =>
      writeFile(join(project, "recording", "metadata.json"), JSON.stringify({ recorders }));
    await write([screen]);
    assert.deepEqual(await micLevels(project), {
      levels: [],
      unavailable: "the recording has no microphone",
    });
    await write([
      screen,
      { type: "microphone", sessions: [{ durationMs: 5000, outputFilename: "mic.m4a" }] },
    ]);
    const prev = process.env.SCREENSTUDIO_FFMPEG;
    process.env.SCREENSTUDIO_FFMPEG = join(dir, "no-ffmpeg");
    try {
      const read = await micLevels(project);
      assert.deepEqual(read.levels, []);
      assert.match(read.unavailable, /microphone audio could not be read \(ffmpeg not found\)/);
    } finally {
      if (prev === undefined) delete process.env.SCREENSTUDIO_FFMPEG;
      else process.env.SCREENSTUDIO_FFMPEG = prev;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
