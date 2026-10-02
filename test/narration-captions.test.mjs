// Narration captions: edge-tts subtitles to timed words, caption lines, SRT and
// styled ASS for burn-in, and the transcript shape Screen Studio stores.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assCanvas,
  assColor,
  buildAss,
  buildSrt,
  captionLines,
  cueWords,
  estimateWords,
  parseSrt,
} from "../dist/studio/narration-captions.js";
import { captionFilePaths, hasMicrophone, ttsArgs } from "../dist/studio/narration.js";
import { narrationTranscript } from "../dist/studio/transcript.js";
import { toSource } from "../dist/studio/timeline.js";

// What edge-tts 7 writes with --write-subtitles: one cue per sentence.
const EDGE_SRT = `1
00:00:00,100 --> 00:00:01,600
Here is the dashboard.

2
00:00:01,800 --> 00:00:03,050
Three plans, billed monthly.
`;

test("edge-tts sentence cues split into words by length", () => {
  const cues = parseSrt(EDGE_SRT);
  assert.deepEqual(cues[0], { startMs: 100, endMs: 1600, text: "Here is the dashboard." });
  const words = cueWords(cues);
  assert.deepEqual(
    words.map((w) => w.text),
    ["Here", "is", "the", "dashboard.", "Three", "plans,", "billed", "monthly."],
  );
  // "Here is the dashboard." is 4+2+3+10 = 19 characters over 1500ms.
  assert.deepEqual(words[0], { text: "Here", startMs: 100, endMs: 416 });
  assert.equal(words[3].endMs, 1600);
  assert.equal(words[4].startMs, 1800);
  assert.equal(words.at(-1).endMs, 3050);
  for (let i = 1; i < 4; i++) assert.equal(words[i].startMs, words[i - 1].endMs);
});

test("per-word cues, CRLF line ends and dot milliseconds parse too", () => {
  const cues = parseSrt(
    "1\r\n00:00:00.050 --> 00:00:00.400\r\nHello\r\n\r\n2\r\n00:00:00,400 --> 00:00:00,900\r\nworld\r\n",
  );
  assert.deepEqual(cueWords(cues), [
    { text: "Hello", startMs: 50, endMs: 400 },
    { text: "world", startMs: 400, endMs: 900 },
  ]);
  assert.deepEqual(parseSrt(""), []);
  assert.deepEqual(
    estimateWords("ab cd", 1000).map((w) => [w.startMs, w.endMs]),
    [
      [0, 500],
      [500, 1000],
    ],
  );
});

test("caption lines break after a sentence, a long pause or 42 characters", () => {
  const words = cueWords(parseSrt(EDGE_SRT));
  const lines = captionLines(words);
  assert.deepEqual(
    lines.map((l) => l.text),
    ["Here is the dashboard.", "Three plans, billed monthly."],
  );
  const long = cueWords([
    {
      startMs: 0,
      endMs: 6000,
      text: "one two three four five six seven eight nine ten eleven twelve thirteen",
    },
  ]);
  assert.ok(captionLines(long).every((l) => l.text.length <= 42));
  assert.equal(captionLines(long).length, 2);
  const paused = [
    { text: "Wait", startMs: 0, endMs: 300 },
    { text: "now", startMs: 1200, endMs: 1500 },
  ];
  assert.equal(captionLines(paused).length, 2);
});

test("SRT output numbers cues with comma milliseconds", () => {
  const srt = buildSrt([{ startMs: 1234, endMs: 3723005, text: "Hello there." }]);
  assert.equal(srt, "1\n00:00:01,234 --> 01:02:03,005\nHello there.\n");
});

test("the ASS file has a valid header, a style from the captions config and karaoke dialogue", () => {
  const words = [
    { text: "Here", startMs: 1000, endMs: 1300 },
    { text: "it", startMs: 1300, endMs: 1500 },
    { text: "is.", startMs: 1600, endMs: 2000 },
    { text: "{Done}", startMs: 2500, endMs: 3000 },
  ];
  const lines = captionLines(words);
  const ass = buildAss(
    lines,
    words,
    {
      font: "mono",
      sizeRatio: 0.05,
      color: "#ffffff",
      backgroundColor: "#11223380",
      position01: { x: 0.5, y: 1 },
      wordsReveal: "word-by-word",
    },
    assCanvas(16 / 9),
  );
  const rows = ass.split("\n");
  assert.equal(rows[0], "[Script Info]");
  assert.ok(rows.includes("PlayResX: 1920"));
  assert.ok(rows.includes("PlayResY: 1080"));
  const style = rows.find((r) => r.startsWith("Style: "));
  const fields = style.slice(7).split(",");
  assert.equal(fields.length, 23);
  assert.equal(fields[1], "Menlo");
  assert.equal(fields[2], "54");
  assert.equal(fields[3], "&H00FFFFFF");
  assert.equal(fields[5], "&H7F332211");
  assert.equal(fields[15], "3");
  const dialogue = rows.filter((r) => r.startsWith("Dialogue: "));
  assert.equal(dialogue.length, 2);
  assert.equal(
    dialogue[0],
    "Dialogue: 0,0:00:01.00,0:00:02.00,Narration,,0,0,0,,{\\an2\\pos(960,1015)}{\\k30}Here {\\k30}it {\\k40}is.",
  );
  assert.ok(dialogue[1].endsWith("{\\k50}Done"), "braces in text cannot open an override");
  const plain = buildAss(lines, words, { wordsReveal: "line-by-line" }, assCanvas(9 / 16));
  assert.ok(plain.includes("PlayResX: 1080\nPlayResY: 1920"));
  assert.ok(!plain.includes("\\k"));
  assert.ok(plain.includes("Helvetica Neue,96,"));
});

test("hex colours become ASS colours with inverted alpha", () => {
  assert.equal(assColor("#ff8000"), "&H000080FF");
  assert.equal(assColor("#000000b3"), "&H4C000000");
  assert.equal(assColor("#ffffff", 0.5), "&H80FFFFFF");
});

test("narration words are stored like Screen Studio transcript words", () => {
  assert.deepEqual(
    narrationTranscript([
      { text: "Here", startMs: 1000.4, endMs: 1300 },
      { text: " is", startMs: 1300, endMs: 1299 },
    ]),
    [
      { index: 0, text: "Here", startMs: 1000, endMs: 1300 },
      { index: 1, text: " is", startMs: 1300, endMs: 1300 },
    ],
  );
});

test("caption words map from playback to source time through a 2x slice", () => {
  const slices = [
    { sourceStartMs: 0, sourceEndMs: 2000, timeScale: 1 },
    { sourceStartMs: 4000, sourceEndMs: 8000, timeScale: 0.5 },
  ];
  const words = [
    { text: "a", startMs: 500, endMs: 1500 },
    { text: "b", startMs: 2500, endMs: 3000 },
  ];
  assert.deepEqual(
    words.map((w) => [toSource(slices, w.startMs), toSource(slices, w.endMs)]),
    [
      [500, 1500],
      [5000, 6000],
    ],
  );
});

test("only a recording with a microphone session keeps its transcript out of narration captions", () => {
  assert.equal(
    hasMicrophone([
      { type: "window", sessions: [{}] },
      { type: "input", sessions: [{}] },
    ]),
    false,
  );
  assert.equal(hasMicrophone([{ type: "microphone", sessions: [] }]), false);
  assert.equal(hasMicrophone([{ type: "display" }, { type: "microphone", sessions: [{}] }]), true);
});

test("subtitle files sit next to the project bundle, and edge-tts is asked for them", () => {
  assert.deepEqual(captionFilePaths("/Users/x/Projects/Launch demo.screenstudio"), {
    srt: "/Users/x/Projects/Launch demo-narration.srt",
    ass: "/Users/x/Projects/Launch demo-narration.ass",
  });
  const args = ttsArgs("hi", "v", 0, "/tmp/a.mp3", "/tmp/a.srt");
  assert.deepEqual(args.slice(-2), ["--write-subtitles", "/tmp/a.srt"]);
  assert.ok(!ttsArgs("hi", "v", 0, "/tmp/a.mp3").includes("--write-subtitles"));
});
