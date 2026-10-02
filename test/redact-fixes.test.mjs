// Auto-redact without gaps: a short term never shrinks a blur, secrets with
// slashes, links without a scheme, passwords in settings, phones without
// separators, long recordings read to the end, two missed frames bridged, and
// existing masks that grow, block or get reported.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  customDetectors,
  findSensitive,
  maskOps,
  maskRects,
  maskedPreview,
  samplePlan,
  scanNotes,
  trackFindings,
} from "../dist/studio/redact.js";

const kinds = (text, ...rest) => findSensitive(text, ...rest).map((m) => `${m.kind}:${m.value}`);

test("a term you add widens the blur to the secret around it, never shrinks it", () => {
  assert.deepEqual(kinds("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123", customDetectors(["ant"])), [
    "api-key:sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
  ]);
  assert.deepEqual(kinds("jane.doe@example.com", customDetectors(["jane"])), ["email:jane.doe@example.com"]);
  const token = "acme_Zq8Lr4Tx9Vb2Nw7Ks5Hd3Jf6Gm1Pc0Yt";
  assert.deepEqual(kinds(token, customDetectors(["acme"])), [`base64-secret:${token}`]);
  // A term that overlaps two findings joins them into one blur.
  assert.equal(findSensitive("a@b.io-c@d.io", customDetectors(["io-c"])).length, 1);
});

test("secrets with slashes are found whole", () => {
  assert.deepEqual(kinds("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"), [
    "api-key:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  ]);
  const pem = "MIIEowIBAAKCAQEA3Tz2mr7SZiAMfQyuvBjM9Oi/ab+c/d9e8FgH1jK2lM3nO4pQ5rS6";
  assert.deepEqual(kinds(pem), [`base64-secret:${pem}`]);
  assert.deepEqual(kinds("-----BEGIN RSA PRIVATE KEY-----"), ["api-key:-----BEGIN RSA PRIVATE KEY-----"]);
  // File paths made of words are still left alone.
  assert.deepEqual(kinds("/Users/Sam/Projects2024/MyApp/src/components/Header"), []);
});

test("token links are found in an address bar, without https://", () => {
  assert.deepEqual(kinds("example.com/reset?token=8f3kd9s0a1b2c3d4"), [
    "url-token:example.com/reset?token=8f3kd9s0a1b2c3d4",
  ]);
  assert.deepEqual(kinds("app.example.com/auth/callback?code=4/0AY0e-g7abcdefgh"), [
    "url-token:app.example.com/auth/callback?code=4/0AY0e-g7abcdefgh",
  ]);
  assert.deepEqual(kinds("localhost:3000/magic?token=Zx81kPq0"), [
    "url-token:localhost:3000/magic?token=Zx81kPq0",
  ]);
});

test("passwords in .env lines and connection strings are found, not their names", () => {
  assert.deepEqual(kinds("DB_PASSWORD=Sup3rS3cret!"), ["credential:Sup3rS3cret!"]);
  assert.deepEqual(kinds("postgres://admin:hunter2pass@localhost:5432/app"), [
    "credential:admin:hunter2pass",
  ]);
  assert.deepEqual(kinds('"client_secret": "a1b2c3d4e5f6"'), ["credential:a1b2c3d4e5f6"]);
  for (const text of ["max_tokens: 4096", "password: ********", "Tokens remaining 12", "secret: true"])
    assert.deepEqual(kinds(text), [], text);
});

test("phone numbers without separators are found", () => {
  assert.deepEqual(kinds("+14155550123"), ["phone:+14155550123"]);
  assert.deepEqual(kinds("Phone: 4155550123"), ["phone:4155550123"]);
  assert.deepEqual(kinds("order 4155550123"), [], "ten digits without a phone label are an id");
});

test("a long recording is read to its end", () => {
  const plan = samplePlan(600000, 1000, [{ atMs: 550000, kind: "page" }], 400);
  assert.ok(plan.times.length <= 400);
  assert.equal(plan.times.at(-1), 599950);
  assert.ok(
    plan.times.some((t) => t > 549000 && t < 551000),
    "the late page change is read",
  );
  assert.ok(plan.stepMs > 1000);
  const notes = scanNotes({
    everyMs: 1000,
    stepMs: plan.stepMs,
    frames: plan.times.length,
    changes: 1,
    textLines: 3,
    detections: [],
    ops: [],
    skipped: [],
    applied: false,
    capped: plan.capped,
  });
  assert.ok(
    notes.some((n) => /ending included/.test(n)),
    notes.join("\n"),
  );
  // Short recordings keep the asked-for interval.
  assert.equal(samplePlan(30000, 1000).stepMs, 1000);
});

const finding = (key, box) => ({
  kind: "email",
  label: "email address",
  key,
  preview: maskedPreview(key),
  box,
  confidence: 0.9,
});
const at = (x, y = 0.2) => ({ x, y, width: 0.2, height: 0.03 });

test("a value OCR misses twice in a row stays one blur", () => {
  const samples = [
    { atMs: 0, findings: [finding("a@b.co", at(0.1))] },
    { atMs: 1000, findings: [] },
    { atMs: 2000, findings: [] },
    { atMs: 3000, findings: [finding("a@b.co", at(0.1))] },
  ];
  const spans = trackFindings(samples, { durationMs: 4000 });
  assert.equal(spans.length, 1);
  assert.equal(spans[0].startMs, 0);
  assert.equal(spans[0].endMs, 4000);
});

test("an existing blur grows to cover new findings; a highlight or disabled mask is reported", () => {
  const box = { x: 0.5, y: 0.5, width: 0.1, height: 0.05 };
  const d = [{ startMs: 1000, endMs: 5000, box }];
  const blur = maskOps(d, {
    existing: [
      {
        id: "m1",
        startMs: 2000,
        endMs: 3000,
        type: "sensitive-data",
        rects: [{ x: 0, y: 0, width: 0.1, height: 0.1 }],
      },
    ],
  });
  const update = blur.ops.find((o) => o.op === "updateItem");
  assert.equal(update.id, "m1");
  assert.equal(update.fields.rects.length, 2);
  assert.deepEqual(blur.skipped, []);
  // Already covered: nothing to grow.
  const covered = maskOps(d, {
    existing: [
      { id: "m1", startMs: 2000, endMs: 3000, rects: [{ x: 0.4, y: 0.4, width: 0.3, height: 0.3 }] },
    ],
  });
  assert.ok(!covered.ops.some((o) => o.op === "updateItem"));
  for (const [type, disabled, reason] of [
    ["highlight", false, "highlight"],
    ["sensitive-data", true, "disabled"],
  ]) {
    const blocked = maskOps(d, { existing: [{ id: "m2", startMs: 2000, endMs: 3000, type, disabled }] });
    assert.deepEqual(blocked.skipped, [{ startMs: 2000, endMs: 3000, maskId: "m2", reason }]);
    const notes = scanNotes({
      everyMs: 1000,
      frames: 5,
      changes: 0,
      textLines: 2,
      detections: [{ label: "email address", reason: "", confidence: 0.9 }],
      ops: blocked.ops,
      skipped: blocked.skipped,
      applied: false,
      capped: false,
    });
    assert.ok(notes.some((n) => /a blur cannot go there until that mask is removed/.test(n)));
  }
  assert.deepEqual(maskRects([{ x: 144, y: 90, width: 288, height: 45 }], { widthPt: 1440, heightPt: 900 }), [
    { x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
  ]);
  assert.equal(maskRects([{ x: 0.1 }], { widthPt: 1440, heightPt: 900 }), undefined);
});

test("a partial apply says what landed and how to undo it", () => {
  const notes = scanNotes({
    everyMs: 1000,
    frames: 3,
    changes: 0,
    textLines: 2,
    detections: [{ label: "email address", reason: "", confidence: 0.9 }],
    ops: [],
    skipped: [],
    applied: "partial",
    landed: 2,
    checkpointId: "c-1",
    capped: false,
  });
  assert.match(notes.at(-1), /the first 2 ops landed .* nothing was saved.*checkpoint c-1/);
  assert.ok(!notes.some((n) => /Nothing was changed/.test(n)));
});
