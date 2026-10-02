// Talking videos: sentences are the unit of speech. Beats split between them,
// fit-to-length drops the weakest ones, and the camera director widens and
// bookends on them instead of on long phrases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planEdit } from "../dist/studio/plan.js";
import { checkPacing } from "../dist/studio/pacing.js";
import { planLayouts } from "../dist/studio/camera.js";
import { fillerLike, setupLine } from "../dist/studio/beats.js";
import { phrases, sentences } from "../dist/studio/transcript.js";

/** Words of each line, 320ms apart; `pause` is the silence after the line. */
function speak(lines, startMs = 600) {
  const words = [];
  let t = startMs;
  for (const [line, pause] of lines) {
    for (const w of line.split(" ")) {
      words.push({ session: 0, index: words.length, text: ` ${w}`, startMs: t, endMs: t + 260 });
      t += 320;
    }
    t += pause;
  }
  return { words, endMs: t };
}

/** A 32s talk that never pauses for 600ms: one phrase, eight sentences, one stray click. */
const LINES = [
  ["Hey, I'm going to show you how our team ships a release in under a minute.", 150],
  ["Um, so, yeah.", 400],
  ["The release page lists every build that passed the checks overnight.", 150],
  ["You pick the build, and the notes fill themselves in from the merged pull requests.", 150],
  ["Okay, right, so basically that's that.", 400],
  ["Before we publish, the page shows who will get the update and when.", 150],
  ["Nobody has to write a changelog by hand anymore.", 150],
  ["Hit publish, and every customer has the new version within a minute.", 0],
];

function talkingHead() {
  const { words, endMs } = speak(LINES);
  const end = endMs + 2500;
  return {
    projectPath: "/x.screenstudio",
    sourceDurationMs: end,
    capture: { kind: "window", widthPt: 1440, heightPt: 900 },
    sessions: [{ startMs: 0, endMs: end, video: "" }],
    // A stray click 2.8s into the first sentence: nothing on screen answers it.
    clicks: [{ atMs: 3400, endMs: 3480, x: 0.3, y: 0.4, drag: false, button: "left" }],
    typing: [],
    shortcuts: [],
    movement: [],
    screen: { changes: [], active: [] },
    idle: [
      { startMs: 0, endMs: 3250 },
      { startMs: 3650, endMs: end },
    ],
    speech: phrases(words, 600),
    sentences: sentences(words),
    hasCamera: true,
  };
}

const inside = (t, spans, pad = 0) => spans.some((s) => t > s.startMs + pad && t < s.endMs - pad);

test("sentences end at . ? ! and at pauses of 350ms, never at an abbreviation", () => {
  const w = (text, startMs, endMs) => ({ text, startMs, endMs });
  const out = sentences([
    w(" Open", 0, 200),
    w(" the", 250, 400),
    w(" page.", 450, 700),
    w(" Is", 750, 900),
    w(" it", 950, 1100),
    w(' "ready?"', 1150, 1400),
    w(" Ask", 1450, 1600),
    w(" Dr.", 1650, 1800),
    w(" Lee", 1850, 2000),
    // 400ms of silence ends a sentence without punctuation.
    w(" then", 2400, 2600),
    w(" ship", 2650, 2900),
  ]);
  assert.deepEqual(
    out.map((s) => [s.text, s.startMs, s.endMs, s.words]),
    [
      ["Open the page.", 0, 700, 3],
      ['Is it "ready?"', 750, 1400, 3],
      ["Ask Dr. Lee", 1450, 2000, 3],
      ["then ship", 2400, 2900, 2],
    ],
  );
  // Every phrase boundary is a sentence boundary too.
  const { words } = speak(LINES);
  const ends = new Set(sentences(words).map((s) => s.endMs));
  for (const p of phrases(words, 600)) assert.ok(ends.has(p.endMs));
});

test("filler and announcements are told apart from lines that say something", () => {
  assert.ok(fillerLike("Um, so, yeah."));
  assert.ok(fillerLike("Okay, right, so basically that's that."));
  assert.ok(!fillerLike("The release page lists every build that passed the checks overnight."));
  assert.ok(setupLine("Hey, I'm going to show you how our team ships a release."));
  assert.ok(setupLine("So in this video we look at releases."));
  assert.ok(!setupLine("Nobody has to write a changelog by hand anymore."));
});

test("a long continuous talk splits into a beat per sentence", () => {
  const a = talkingHead();
  assert.equal(a.speech.length, 1, "one 600ms phrase covers the whole talk");
  const plan = planEdit(a, {});
  assert.equal(plan.beats.length, LINES.length, JSON.stringify(plan.beats));
  assert.ok(plan.summary.includes(`${LINES.length} of ${LINES.length} beats`), plan.summary);
  // The stray click belongs to the sentence it lands in.
  assert.ok(plan.beats[0].actions.some((x) => x.startsWith("click")));
  // Filler lines are worth least; the last line is the payoff.
  const byText = (t) => plan.beats.find((b) => b.actions.some((x) => x.includes(t)));
  assert.ok(byText("Um, so, yeah").score < byText("The release page").score);
  assert.equal(plan.beats.at(-1).role, "payoff");
});

test("fitting a talk to a length drops the weakest sentences and cuts between sentences", () => {
  const a = talkingHead();
  const plan = planEdit(a, { targetMs: 25000 });
  assert.ok(plan.fit.fitted, plan.summary);
  assert.ok(plan.droppedBeats.length >= 2, plan.summary);
  const dropped = plan.droppedBeats.map((d) => d.label);
  assert.ok(
    dropped.some((l) => l.includes("Um, so, yeah")),
    JSON.stringify(dropped),
  );
  assert.ok(
    dropped.some((l) => l.includes("Okay, right")),
    JSON.stringify(dropped),
  );
  // Never the payoff.
  assert.ok(plan.beats.at(-1).kept);
  // Every cut lands in the pause between two sentences, never inside one.
  for (let i = 1; i < plan.slices.length; i++) {
    assert.ok(!inside(plan.slices[i - 1].endMs, a.sentences), `cut out at ${plan.slices[i - 1].endMs}`);
    assert.ok(!inside(plan.slices[i].startMs, a.sentences), `cut in at ${plan.slices[i].startMs}`);
  }
  // Every kept sentence plays whole; every dropped one is gone.
  for (const s of a.sentences) {
    const shown = plan.slices.filter((x) => x.startMs < s.endMs && x.endMs > s.startMs);
    assert.ok(
      !shown.length || shown.some((x) => x.startMs <= s.startMs && x.endMs >= s.endMs),
      `"${s.text}" plays in part`,
    );
  }
  assert.ok(!plan.pacing.issues.some((i) => i.code === "mid-phrase-cut"), JSON.stringify(plan.pacing.issues));
});

test("the opening line covers a stray click; a click the screen answers trims it", () => {
  const a = talkingHead();
  const first = a.sentences[0];
  const whole = { slices: [{ sourceStartMs: 0, sourceEndMs: a.sourceDurationMs, timeScale: 1 }], zooms: [] };
  const open = planLayouts(a, whole).stretches[0];
  assert.equal(open.type, "fullscreen-camera");
  assert.equal(open.sourceStartMs, 0);
  assert.ok(open.sourceEndMs >= first.endMs && !inside(open.sourceEndMs, a.sentences), JSON.stringify(open));
  assert.match(open.reason, /stray click at 0:03/);

  // The page reacts to the click: the opening ends just before it, still 3.3s long.
  const answered = { ...a, screen: { changes: [{ atMs: 3700, score: 0.5, kind: "page" }], active: [] } };
  const trimmed = planLayouts(answered, whole);
  const cut = trimmed.stretches[0];
  assert.equal(cut.type, "fullscreen-camera");
  assert.equal(cut.sourceStartMs, 0);
  assert.equal(cut.sourceEndMs, 3300);
  assert.match(cut.reason, /until just before the first click/);

  // Too little before the click to hold a shot: no opening, and a note says why.
  const early = { ...answered, clicks: [{ ...a.clicks[0], atMs: 2000, endMs: 2080 }] };
  const none = planLayouts(early, whole);
  assert.ok(!none.stretches.some((s) => s.sourceStartMs === 0 && s.type === "fullscreen-camera"));
  assert.ok(none.notes.some((n) => n.startsWith("No full-screen opening: the first line runs over a click")));
});

test("the sign-off is the last sentences after the last click, not the whole last phrase", () => {
  const a = talkingHead();
  const plan = planLayouts(a, {
    slices: [{ sourceStartMs: 0, sourceEndMs: a.sourceDurationMs, timeScale: 1 }],
    zooms: [],
  });
  const signOff = plan.stretches.at(-1);
  assert.equal(signOff.sourceEndMs, a.sourceDurationMs);
  const last = a.sentences.at(-1);
  assert.ok(signOff.sourceStartMs > a.sentences.at(-2).endMs, JSON.stringify(signOff));
  assert.ok(signOff.sourceStartMs <= last.startMs, JSON.stringify(signOff));
});

const phrase = (startMs, endMs, text = "a sentence that goes on for a while") => ({
  startMs,
  endMs,
  text,
  words: text.split(" ").length,
});

test("screen only around a zoom widens to a nearby pause, never to a 20s sentence", () => {
  const whole = (end) => ({ slices: [{ sourceStartMs: 0, sourceEndMs: end, timeScale: 1 }] });
  // One 20s line with no pause near the zoom: the stretch stays on the zoom.
  const long = { sourceDurationMs: 30000, clicks: [], speech: [phrase(1000, 21000)] };
  const zoom = { sourceStartMs: 8000, sourceEndMs: 14000 };
  const held = planLayouts(long, { ...whole(30000), zooms: [zoom] }, { bookends: false });
  const only = held.stretches.find((s) => s.type === "screen-only");
  assert.deepEqual([only.sourceStartMs, only.sourceEndMs], [8000, 14000], JSON.stringify(held.stretches));
  assert.match(only.reason, /no pause between sentences is within 1\.5s/);

  // Pauses 1.4s outside both edges: widening both would add 3.5s, so one edge stays put.
  const near = {
    sourceDurationMs: 30000,
    clicks: [],
    speech: [phrase(1000, 25000)],
    sentences: [
      phrase(2000, 8000),
      phrase(8600, 12000),
      phrase(12200, 13800),
      phrase(14000, 17400),
      phrase(17900, 25000),
    ],
  };
  const capped = planLayouts(
    near,
    { ...whole(30000), zooms: [{ sourceStartMs: 10000, sourceEndMs: 16000 }] },
    { bookends: false },
  );
  const s = capped.stretches.find((x) => x.type === "screen-only");
  assert.ok(s.sourceEndMs - s.sourceStartMs <= 6000 + 3000, JSON.stringify(s));
  assert.ok(s.sourceStartMs < 8600 && s.sourceStartMs > 8000, JSON.stringify(s));

  // One pause within reach on each side, adding under 3s: both edges land in pauses.
  const both = planLayouts(
    near,
    { ...whole(30000), zooms: [{ sourceStartMs: 9500, sourceEndMs: 16500 }] },
    { bookends: false },
  );
  const w = both.stretches.find((x) => x.type === "screen-only");
  assert.ok(
    !inside(w.sourceStartMs, near.sentences) && !inside(w.sourceEndMs, near.sentences),
    JSON.stringify(w),
  );
  assert.ok(w.sourceEndMs - w.sourceStartMs <= 7000 + 3000, JSON.stringify(w));
  assert.match(w.reason, /widened to the pauses between sentences/);
});

test("check_pacing judges cuts and layout changes against sentences when the analysis has them", () => {
  // One 12s phrase holding two sentences, with a 500ms pause between them at 6-6.5s.
  const speech = [{ startMs: 1000, endMs: 13000, text: "First line here. Second line there." }];
  const lines = [
    { startMs: 1000, endMs: 6000, text: "First line here.", words: 3 },
    { startMs: 6500, endMs: 13000, text: "Second line there.", words: 3 },
  ];
  const input = {
    slices: [
      { sourceStartMs: 0, sourceEndMs: 6100, timeScale: 1 },
      { sourceStartMs: 6400, sourceEndMs: 15000, timeScale: 1 },
    ],
    zooms: [],
    layouts: [{ sourceStartMs: 6200, sourceEndMs: 15000, type: "screen-only" }],
  };
  const base = { clicks: [], typing: [], sourceDurationMs: 15000, speech };
  const codes = (a) => checkPacing(input, a).issues.map((i) => i.code);
  // Phrases alone: the cut and the layout change both land inside the phrase.
  assert.ok(codes(base).includes("mid-phrase-cut"), codes(base).join());
  assert.ok(codes(base).includes("layout-mid-phrase"), codes(base).join());
  // With sentences: both land in the pause between them.
  const withSentences = codes({ ...base, sentences: lines });
  assert.ok(!withSentences.includes("mid-phrase-cut"), withSentences.join());
  assert.ok(!withSentences.includes("layout-mid-phrase"), withSentences.join());
  // A cut inside a sentence is still caught.
  const inside = checkPacing(
    {
      slices: [
        { sourceStartMs: 0, sourceEndMs: 3000, timeScale: 1 },
        { sourceStartMs: 3500, sourceEndMs: 15000, timeScale: 1 },
      ],
      zooms: [],
    },
    { ...base, sentences: lines },
  );
  assert.ok(inside.issues.some((i) => i.code === "mid-phrase-cut"));
});
