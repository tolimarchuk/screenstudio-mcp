// Sentence beats: the payoff stays on the demo, a click keeps its result, a
// retake drops the whole take, dropped sentences keep a breath, and sentences
// split right in other scripts and around abbreviations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planEdit } from "../dist/studio/plan.js";
import { checkPacing } from "../dist/studio/pacing.js";
import { fillerLike } from "../dist/studio/beats.js";
import { phrases, sentences } from "../dist/studio/transcript.js";

/** Words of each line, `stride` ms apart and `stride - gap` long; `pause` is extra silence after the line. */
function speak(lines, { startMs = 600, stride = 320, gap = 60 } = {}) {
  const words = [];
  let t = startMs;
  for (const [line, pause] of lines) {
    for (const w of line.split(" ")) {
      words.push({ session: 0, index: words.length, text: ` ${w}`, startMs: t, endMs: t + stride - gap });
      t += stride;
    }
    t += pause;
  }
  return { words, endMs: t };
}

function talk(lines, { clicks = [], changes = [], markers, speakOptions } = {}) {
  const { words, endMs } = speak(lines, speakOptions);
  const end = endMs + 2500;
  return {
    words,
    projectPath: "/x.screenstudio",
    sourceDurationMs: end,
    capture: { kind: "window", widthPt: 1440, heightPt: 900 },
    sessions: [{ startMs: 0, endMs: end, video: "" }],
    clicks: clicks.map((atMs) => ({ atMs, endMs: atMs + 70, x: 0.5, y: 0.5, drag: false, button: "left" })),
    typing: [],
    shortcuts: [],
    movement: [],
    screen: { changes: changes.map((atMs) => ({ atMs, score: 0.5, kind: "page" })), active: [] },
    idle: [],
    speech: phrases(words, 600),
    sentences: sentences(words),
    ...(markers ? { markers } : {}),
    hasCamera: true,
  };
}

test("a sign-off after the last click is not the payoff: fitting keeps the demo, drops the goodbye", () => {
  const a = talk(
    [
      ["This is the release page for our mobile app builds.", 150],
      ["Pick the build you want and press the publish button now.", 150],
      ["Every customer gets the new version within a minute.", 150],
      ["That is all for today, thanks so much for watching, see you next time.", 0],
    ],
    { clicks: [7300], changes: [7800] },
  );
  const plan = planEdit(a, { targetMs: 9000, structure: "hook-demo-payoff" });
  const click = plan.beats.find((b) => b.actions.some((x) => x.startsWith("click")));
  const bye = plan.beats.find((b) => b.label.includes("That is all for today"));
  assert.equal(click.role, "payoff", JSON.stringify(plan.beats));
  assert.equal(bye.role, "signoff");
  assert.ok(click.kept, plan.summary);
  assert.ok(click.label.includes("page changes"), click.label);
  assert.ok(
    plan.droppedBeats.some((d) => d.label.includes("That is all for today")),
    JSON.stringify(plan.droppedBeats),
  );
  // The cold open is the click's settled result, not the goodbye.
  assert.ok(plan.coldOpen.reason.includes("click at"), plan.coldOpen.reason);
  assert.ok(plan.coldOpen.sourceStartMs < bye.sourceStartMs);
  // A talk with nothing on screen still ends on its last line.
  const plain = planEdit(
    talk([
      ["One thing to say here.", 150],
      ["And another thing to say.", 0],
    ]),
    {},
  );
  assert.equal(plain.beats.at(-1).role, "payoff");
});

test("a click whose page answers during the next sentence keeps the answer in its beat", () => {
  const a = talk(
    [
      ["This is the release page for every build we ship.", 150],
      ["Now I pick this build and press the publish button.", 150],
      ["The page reloads and shows the new version for every customer.", 150],
      ["Customers get it within a minute, with no changelog to write.", 0],
    ],
    // The click ends the second sentence; the page changes while the third is said.
    { clicks: [7300], changes: [8600] },
  );
  const third = a.sentences[2];
  assert.ok(8600 > third.startMs && 8600 < third.endMs, JSON.stringify(a.sentences));
  const plan = planEdit(a, { targetMs: 9000 });
  const click = plan.beats.find((b) => b.actions.some((x) => x.startsWith("click")));
  assert.ok(click.label.includes("page changes"), JSON.stringify(plan.beats));
  assert.ok(click.score >= 8, JSON.stringify(click));
  assert.ok(click.kept, plan.summary);
  // No talk-only beat takes the click's page change.
  assert.ok(!plan.beats.some((b) => b !== click && b.label.includes("page changes")));
});

test("retake mode drops the whole failed take, not just its last sentence", () => {
  const take = [
    ["Open the release page from the sidebar menu.", 150],
    ["Pick the build that passed the overnight checks.", 150],
    ["Publish sends the version to every customer at once.", 900],
  ];
  const first = speak(take);
  const markerAt = first.endMs + 300;
  const { words: again } = speak(take, { startMs: markerAt + 400 });
  const words = [...first.words, ...again];
  const end = again.at(-1).endMs + 2500;
  const a = {
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
    markers: [{ id: "m1", sourceMs: markerAt }],
    hasCamera: true,
  };
  const plan = planEdit(a, { markers: "retake" });
  const takeStart = first.words[0].startMs;
  const takeEnd = first.words.at(-1).endMs;
  // Nothing of the first take plays.
  for (const s of plan.slices)
    assert.ok(s.endMs <= takeStart || s.startMs >= takeEnd, JSON.stringify(plan.slices));
  assert.equal(plan.droppedBeats.length, 3, JSON.stringify(plan.droppedBeats));
  assert.ok(plan.droppedBeats.every((d) => d.reason.startsWith("retake")));
  // The second take plays whole.
  for (const w of again) assert.ok(plan.slices.some((s) => s.startMs <= w.startMs && s.endMs >= w.endMs));
});

test("dropping a sentence keeps a breath on both sides, or does not cut there at all", () => {
  const lines = [
    ["Here is the dashboard our support team opens every morning.", 0],
    ["The queue on the left sorts every ticket by how urgent it is.", 0],
    ["Um so yeah basically.", 0],
    ["Each ticket shows the customer, the plan they pay for and the last reply.", 0],
    ["Replying from here sends the answer and closes the ticket in one step.", 0],
  ];
  const a = talk(lines);
  const plan = planEdit(a, { targetMs: 14000 });
  for (let i = 1; i < plan.slices.length; i++) {
    const out = plan.slices[i - 1].endMs;
    const back = plan.slices[i].startMs;
    for (const w of a.words) {
      assert.ok(!(out > w.startMs && out < w.endMs), `cut out inside "${w.text}" at ${out}`);
      assert.ok(!(back > w.startMs && back < w.endMs), `cut in inside "${w.text}" at ${back}`);
    }
    const lastSaid = a.words.filter((w) => w.endMs <= out).at(-1);
    const nextSaid = a.words.find((w) => w.startMs >= back);
    if (lastSaid) assert.ok(out - lastSaid.endMs >= 100, `no breath after "${lastSaid.text}" at ${out}`);
    if (nextSaid) assert.ok(nextSaid.startMs - back >= 60, `no breath before "${nextSaid.text}" at ${back}`);
  }
  // Wider pauses between sentences do leave room for the cut, with a breath.
  const roomy = talk(lines.map(([l]) => [l, 300]));
  const fitted = planEdit(roomy, { targetMs: 20000 });
  const filler = roomy.sentences.find((s) => s.text.startsWith("Um so"));
  assert.ok(
    fitted.droppedBeats.some((d) => d.label.includes("Um so yeah")),
    JSON.stringify(fitted.droppedBeats),
  );
  const before = roomy.words.filter((w) => w.endMs <= filler.startMs).at(-1);
  const after = roomy.words.find((w) => w.startMs >= filler.endMs);
  const outAt = fitted.slices.find((s) => s.endMs > before.startMs && s.endMs < filler.endMs)?.endMs;
  const inAt = fitted.slices.find((s) => s.startMs > filler.startMs && s.startMs <= after.startMs)?.startMs;
  assert.ok(outAt >= before.endMs + 100, `${outAt} vs ${before.endMs}`);
  assert.ok(inAt <= after.startMs - 60, `${inAt} vs ${after.startMs}`);
  assert.ok(!fitted.pacing.issues.some((i) => i.code === "tight-cut"), JSON.stringify(fitted.pacing.issues));
});

test("check_pacing flags a cut right on a word between two sentences of one phrase", () => {
  const speech = [{ startMs: 1000, endMs: 13000, text: "First line here. Second line there." }];
  const lines = [
    { startMs: 1000, endMs: 6000, text: "First line here.", words: 3 },
    { startMs: 6080, endMs: 13000, text: "Second line there.", words: 3 },
  ];
  const report = (out, back) =>
    checkPacing(
      {
        slices: [
          { sourceStartMs: 0, sourceEndMs: out, timeScale: 1 },
          { sourceStartMs: back, sourceEndMs: 15000, timeScale: 1 },
        ],
        zooms: [],
      },
      { clicks: [], typing: [], sourceDurationMs: 15000, speech, sentences: lines },
    ).issues.map((i) => i.code);
  assert.ok(report(6010, 9000).includes("tight-cut"));
  assert.ok(!report(6130, 9000).includes("tight-cut"));
});

test("sentences end at full-width stops", () => {
  const w = (text, i) => ({ text, startMs: i * 300, endMs: i * 300 + 250 });
  const out = sentences(["これは", "新しい", "画面です。", "ボタンを", "押すと", "公開されます。"].map(w));
  assert.deepEqual(
    out.map((s) => s.text),
    ["これは新しい画面です。", "ボタンを押すと公開されます。"],
  );
  assert.equal(sentences(["好的！", "「完了。」", "次"].map(w)).length, 3);
});

test("short punchy lines and sentences without spaces are not filler", () => {
  assert.ok(!fillerLike("It just works."));
  assert.ok(!fillerLike("Ship it!"));
  assert.ok(!fillerLike("It's live!"));
  assert.ok(!fillerLike("ボタンを押すと全員に新しいバージョンが届きます。"));
  assert.ok(fillerLike("Um, so, yeah."));
  assert.ok(fillerLike("Okay, right, so basically that's that."));
  assert.ok(fillerLike("Yeah."));
});

test("dotted abbreviations and titles do not end a sentence", () => {
  const w = (text, i) => ({ text: ` ${text}`, startMs: i * 300, endMs: i * 300 + 250 });
  const said = (line) => sentences(line.split(" ").map(w)).map((s) => s.text);
  assert.deepEqual(said("We deploy at 5 p.m. every day in the U.S. office"), [
    "We deploy at 5 p.m. every day in the U.S. office",
  ]);
  assert.deepEqual(said("Acme Inc. ships it with Jr. devs approx. twice"), [
    "Acme Inc. ships it with Jr. devs approx. twice",
  ]);
  assert.deepEqual(said("See No. 5 first. No. Not that one."), ["See No. 5 first.", "No.", "Not that one."]);
});
