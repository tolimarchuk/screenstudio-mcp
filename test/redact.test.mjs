// Auto-redact: the text detectors, boxes inside OCR lines, following a finding
// across frames, laying findings onto a mask track that cannot overlap, and the
// native OCR on a rendered frame when the helper is built.
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  customDetectors,
  findSensitive,
  frameFindings,
  luhn,
  maskOps,
  maskedPreview,
  matchBox,
  recognizeText,
  reduceRects,
  sampleTimes,
  scanNotes,
  trackFindings,
} from "../dist/studio/redact.js";

const kinds = (text, ...rest) => findSensitive(text, ...rest).map((m) => `${m.kind}:${m.value}`);

test("keys and tokens are found by their shape", () => {
  assert.deepEqual(kinds("OPENAI_API_KEY=sk-proj-a8F3kQ9zLm2Xv7Rt5Wb1Yc4N"), [
    "api-key:sk-proj-a8F3kQ9zLm2Xv7Rt5Wb1Yc4N",
  ]);
  assert.deepEqual(kinds("token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"), [
    "api-key:ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
  ]);
  assert.deepEqual(kinds("AKIAIOSFODNN7EXAMPLE and xoxb-1234567890-abcdefghij"), [
    "api-key:AKIAIOSFODNN7EXAMPLE",
    "api-key:xoxb-1234567890-abcdefghij",
  ]);
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  assert.deepEqual(kinds(`Bearer ${jwt}`), [`jwt:${jwt}`]);
  assert.deepEqual(kinds("open https://app.example.com/cb?state=x&access_token=abc123def456 now"), [
    "url-token:https://app.example.com/cb?state=x&access_token=abc123def456",
  ]);
  assert.deepEqual(kinds("secret 3f9a2b7c1d4e5f60718293a4b5c6d7e8"), [
    "hex-secret:3f9a2b7c1d4e5f60718293a4b5c6d7e8",
  ]);
  assert.deepEqual(kinds("aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5"), [
    "base64-secret:aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5",
  ]);
});

test("people's details are found: emails, phones, cards and addresses", () => {
  assert.deepEqual(kinds("Contact jane.doe@example.com or +1 415 555 0132"), [
    "email:jane.doe@example.com",
    "phone:+1 415 555 0132",
  ]);
  assert.deepEqual(kinds("call (415) 555-0132"), ["phone:(415) 555-0132"]);
  assert.deepEqual(kinds("card 5555-5555-5555-4444"), ["card:5555-5555-5555-4444"]);
  assert.deepEqual(kinds("server 10.0.4.17"), ["ipv4:10.0.4.17"]);
  assert.ok(luhn("4242 4242 4242 4242"));
  assert.ok(!luhn("4242 4242 4242 4241"));
});

test("ordinary screen text is left alone", () => {
  for (const text of [
    "build 4.0.1-4897 on 2026-10-01 at 12:30:45",
    "ConfigurationManagerFactoryProviderImpl",
    "id 123e4567-e89b-12d3-a456-426614174000",
    "/Users/someone/Documents/projects/app",
    "listening on 127.0.0.1:3000 and 0.0.0.0",
    "card 4111 1111 1111 1112",
    "Total 1,234,567.89",
  ])
    assert.deepEqual(kinds(text), [], text);
});

test("extra terms are literal words or /regex/, and kinds can be ignored", () => {
  const extra = customDetectors(["Acme Corp", "/ACCT-\\d{4}/"]);
  assert.deepEqual(kinds("Invoice for ACME corp, ACCT-1234", extra), [
    "custom:ACME corp",
    "custom:ACCT-1234",
  ]);
  // A literal term is not a pattern.
  assert.deepEqual(kinds("a.b", customDetectors(["a*b"])), []);
  assert.throws(() => customDetectors(["/([/"]), /not a valid regular expression/);
  assert.deepEqual(kinds("mail jane@example.com from 10.0.0.1", [], ["email"]), ["ipv4:10.0.0.1"]);
});

test("results only ever show the first and last two characters", () => {
  assert.equal(maskedPreview("sk-proj-a8F3kQ9zLm2Xv7Rt5Wb1Yc4N"), "sk…4N");
  assert.equal(maskedPreview("10.0.0.1"), "1…1");
  assert.equal(maskedPreview("abcd"), "••••");
  const line = {
    text: "key sk-proj-a8F3kQ9zLm2Xv7Rt5Wb1Yc4N",
    confidence: 1,
    box: { x: 0, y: 0, width: 1, height: 0.05 },
  };
  const [found] = frameFindings([line]);
  const detections = trackFindings([{ atMs: 0, findings: [found] }], { durationMs: 1000 });
  assert.ok(!JSON.stringify(detections).includes("a8F3kQ9z"));
  assert.equal(detections[0].preview, "sk…4N");
});

const line = {
  text: "Contact jane@example.com today",
  confidence: 0.9,
  box: { x: 0.1, y: 0.2, width: 0.6, height: 0.04 },
  words: [
    { start: 0, end: 7, box: { x: 0.1, y: 0.2, width: 0.14, height: 0.04 } },
    { start: 8, end: 24, box: { x: 0.26, y: 0.2, width: 0.32, height: 0.04 } },
    { start: 25, end: 30, box: { x: 0.6, y: 0.2, width: 0.1, height: 0.04 } },
  ],
};

test("a finding is boxed by its own words, or by a slice when Vision did not split the line", () => {
  assert.deepEqual(matchBox(line, 8, 24), line.words[1].box);
  // Vision returns the whole line for "KEY=sk-..." as one word: fall back to an even slice, a character wider each side.
  const joined = {
    text: "KEY=sk-0123456789abcdef",
    confidence: 1,
    box: { x: 0, y: 0.5, width: 0.46, height: 0.04 },
    words: [{ start: 0, end: 23, box: { x: 0, y: 0.5, width: 0.46, height: 0.04 } }],
  };
  const b = matchBox(joined, 4, 23);
  assert.ok(Math.abs(b.x - 0.06) < 1e-9, String(b.x));
  assert.ok(Math.abs(b.x + b.width - 0.46) < 1e-9);
  // Part of a real word is sliced inside that word.
  const part = matchBox(line, 8, 16);
  assert.ok(part.x >= 0.26 && part.x + part.width < 0.26 + 0.32);
});

const finding = (key, box, extra = {}) => ({
  kind: "email",
  label: "email address",
  key,
  preview: maskedPreview(key),
  box,
  confidence: 0.9,
  ...extra,
});
const at = (x, y = 0.2) => ({ x, y, width: 0.2, height: 0.03 });

test("a finding is followed across frames, through OCR misreads, into one padded span", () => {
  const samples = [
    { atMs: 0, findings: [] },
    { atMs: 1000, findings: [finding("jane@example.com", at(0.3))] },
    { atMs: 2000, findings: [finding("jane@exarnple.com", at(0.3))] }, // misread, same place
    { atMs: 3000, findings: [] }, // missed once (cursor over it)
    { atMs: 4000, findings: [finding("jane@example.com", at(0.3, 0.4))] }, // scrolled down
    { atMs: 5000, findings: [] },
    { atMs: 6000, findings: [] },
  ];
  const [d, ...rest] = trackFindings(samples, { durationMs: 8000 });
  assert.equal(rest.length, 0);
  assert.equal(d.frames, 3);
  // From the last frame without it to the first frame after it, plus a little.
  assert.equal(d.startMs, 0);
  assert.equal(d.endMs, 5050);
  assert.equal(d.firstSeenMs, 1000);
  assert.equal(d.lastSeenMs, 4000);
  // The box covers every place it was seen, padded beyond the text.
  assert.ok(d.box.y < 0.2 && d.box.y + d.box.height > 0.43);
  assert.ok(d.box.x < 0.3 && d.box.x + d.box.width > 0.5);
});

test("the same value in two places, or seen again much later, is a separate finding", () => {
  const twice = [{ atMs: 0, findings: [finding("a@b.co", at(0.1)), finding("a@b.co", at(0.6, 0.7))] }];
  assert.equal(trackFindings(twice, { durationMs: 1000 }).length, 2);
  const later = [
    { atMs: 0, findings: [finding("a@b.co", at(0.1))] },
    { atMs: 1000, findings: [] },
    { atMs: 2000, findings: [] },
    { atMs: 3000, findings: [] },
    { atMs: 4000, findings: [finding("a@b.co", at(0.1))] },
  ];
  const spans = trackFindings(later, { durationMs: 5000 });
  assert.deepEqual(
    spans.map((d) => [d.startMs, d.endMs]),
    [
      [0, 1050],
      [2950, 5000],
    ],
  );
});

test("a value that was typed in is blurred from the first keystroke", () => {
  const samples = [
    { atMs: 0, findings: [] },
    { atMs: 4000, findings: [finding("jane@example.com", at(0.3))] },
  ];
  const [d] = trackFindings(samples, {
    durationMs: 5000,
    typing: [{ startMs: 2500, endMs: 3600, y: 0.21 }],
  });
  assert.equal(d.startMs, 0);
  const [typed] = trackFindings([{ atMs: 3000, findings: [] }, ...samples.slice(1)], {
    durationMs: 5000,
    typing: [{ startMs: 1200, endMs: 3600, y: 0.21 }],
  });
  assert.equal(typed.startMs, 1150);
  assert.match(typed.reason, /typed/);
  // Typing elsewhere on screen does not stretch the blur.
  const [other] = trackFindings([{ atMs: 3000, findings: [] }, ...samples.slice(1)], {
    durationMs: 5000,
    typing: [{ startMs: 1200, endMs: 3600, y: 0.9 }],
  });
  assert.equal(other.startMs, 2950);
});

test("findings become masks that never overlap, without flicker", () => {
  const box = (x) => ({ x, y: 0.1, width: 0.1, height: 0.05 });
  const { ops, skipped } = maskOps([
    { startMs: 1000, endMs: 5000, box: box(0.1) },
    { startMs: 3000, endMs: 8000, box: box(0.5) },
    { startMs: 7900, endMs: 9000, box: box(0.8) }, // 100ms overlap folds into a neighbour
  ]);
  assert.deepEqual(skipped, []);
  for (let i = 1; i < ops.length; i++) assert.ok(ops[i].startMs >= ops[i - 1].endMs);
  assert.deepEqual(
    ops.map((o) => [o.startMs, o.endMs, o.rects.length]),
    [
      [1000, 3000, 1],
      [3000, 5000, 2],
      [5000, 7900, 1],
      [7900, 9000, 2],
    ],
  );
  for (const o of ops) assert.equal(o.type, "sensitive-data");
});

test("time an existing mask holds is left out and reported", () => {
  const { ops, skipped } = maskOps(
    [{ startMs: 1000, endMs: 5000, box: { x: 0, y: 0, width: 0.1, height: 0.1 } }],
    {
      existing: [{ id: "m1", startMs: 2000, endMs: 3000 }],
    },
  );
  assert.deepEqual(
    ops.map((o) => [o.startMs, o.endMs]),
    [
      [1000, 2000],
      [3000, 5000],
    ],
  );
  assert.deepEqual(skipped, [{ startMs: 2000, endMs: 3000, maskId: "m1" }]);
});

test("a mask holds at most ten rects, and overlapping rects merge", () => {
  const many = Array.from({ length: 14 }, (_, i) => ({
    x: (i % 7) * 0.12,
    y: Math.floor(i / 7) * 0.5,
    width: 0.1,
    height: 0.04,
  }));
  const reduced = reduceRects(many, 10);
  assert.equal(reduced.length, 10);
  for (const r of many)
    assert.ok(
      reduced.some(
        (x) => x.x <= r.x && x.y <= r.y && x.x + x.width >= r.x + r.width && x.y + x.height >= r.y + r.height,
      ),
    );
  assert.equal(
    reduceRects([
      { x: 0, y: 0, width: 0.2, height: 0.1 },
      { x: 0.1, y: 0.05, width: 0.2, height: 0.1 },
    ]).length,
    1,
  );
});

test("frames are read on a grid and around screen changes, page changes first", () => {
  const times = sampleTimes(3000, 1000, [
    { atMs: 1500, kind: "page" },
    { atMs: 2040, kind: "region" },
  ]);
  assert.deepEqual(times, [0, 1000, 1380, 1750, 2000, 2290, 2950]);
  const capped = sampleTimes(
    3000,
    1000,
    [
      { atMs: 1500, kind: "region" },
      { atMs: 2500, kind: "page" },
    ],
    6,
  );
  assert.deepEqual(capped, [0, 1000, 2000, 2380, 2750, 2950]);
});

test("notes explain the choices and never repeat a value", () => {
  const detections = trackFindings(
    [
      { atMs: 0, findings: [] },
      { atMs: 1000, findings: [finding("jane@example.com", at(0.3))] },
    ],
    { durationMs: 2000 },
  );
  const { ops, skipped } = maskOps(detections);
  const notes = scanNotes({
    everyMs: 1000,
    frames: 2,
    changes: 0,
    textLines: 4,
    detections,
    ops,
    skipped,
    applied: false,
    capped: false,
  });
  assert.ok(notes.some((n) => /Found 1 thing to hide: 1 email address/.test(n)));
  assert.ok(notes.some((n) => /screenstudio_editor_apply/.test(n)));
  assert.ok(!notes.join(" ").includes("jane@"));
  const none = scanNotes({
    ...{ everyMs: 1000, frames: 2, changes: 0, textLines: 0 },
    detections: [],
    ops: [],
    skipped: [],
    applied: false,
    capped: false,
  });
  assert.ok(none.some((n) => /faces/.test(n)));
});

const helper = new URL("../native/desktop-helper", import.meta.url).pathname;
const nativeReady =
  process.platform === "darwin" &&
  (await access(helper).then(
    () => true,
    () => false,
  ));

test(
  "the native OCR reads a rendered frame with boxes in place",
  { skip: !nativeReady, timeout: 180000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "redact-"));
    try {
      const png = join(dir, "frame.png");
      try {
        await promisify(execFile)("ffmpeg", [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=white:s=1600x900",
          "-frames:v",
          "1",
          "-vf",
          "drawtext=fontfile=/System/Library/Fonts/Menlo.ttc:text='mail jane.doe@example.com now':x=160:y=450:fontsize=40:fontcolor=black",
          png,
        ]);
      } catch {
        return t.skip("ffmpeg with drawtext is not available");
      }
      const [lines] = await recognizeText([png]);
      const [found] = frameFindings(lines);
      assert.equal(found?.kind, "email");
      assert.ok(found.box.x > 0.15 && found.box.x < 0.3, JSON.stringify(found.box));
      assert.ok(found.box.y > 0.45 && found.box.y < 0.52, JSON.stringify(found.box));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
