// Editor ops: Node-side checks, and the page script run against a small fake
// of Screen Studio's editor model so failures and rollbacks can be exercised.
import { test } from "node:test";
import assert from "node:assert/strict";
import { configPartial, prepareOps } from "../dist/studio/editor/ops.js";
import { PRELUDE, applyScript, clipFields } from "../dist/studio/editor/page.js";
import { Editor } from "../dist/studio/editor/editor.js";

test("the current project is the focused editor, or the only editor", async () => {
  const e = new Editor({ path: async (p) => p });
  e.list = async () => [
    { projectPath: "/original", focused: true },
    { projectPath: "/copy", focused: false },
  ];
  assert.equal(await e.current(), "/original");
  assert.equal(await e.current("/copy"), "/copy");
  e.list = async () => [{ projectPath: "/only", focused: false }];
  assert.equal(await e.current(), "/only");
  e.list = async () => [{ projectPath: "/a" }, { projectPath: "/b" }];
  await assert.rejects(e.current(), /Choose/);
  e.list = async () => [];
  await assert.rejects(e.current(), /No project/);
});

const scene = (tracks) => ({
  sourceMs: 10000,
  config: { cursor: { size: 48 }, styles: { screenBorderRadius: 10 } },
  captureSize: { width: 1000, height: 500 },
  tracks,
});
const zooms = [
  { id: "A", sourceStartMs: 1000, sourceEndMs: 3000 },
  { id: "B", sourceStartMs: 4000, sourceEndMs: 6000 },
];

test("item updates are checked against the scene before anything runs", () => {
  const s = scene({ zooms, layouts: [], masks: [] });
  assert.throws(() => prepareOps([{ op: "updateZoom", zoomId: "A", endMs: 5000 }], s), /overlap B/);
  assert.throws(
    () => prepareOps([{ op: "updateZoom", zoomId: "B", startMs: 9000 }], s),
    /end after it starts/,
  );
  assert.throws(
    () => prepareOps([{ op: "updateItem", track: "zooms", id: "A", endMs: 999999 }], s),
    /inside the 10000ms recording/,
  );
  assert.throws(() => prepareOps([{ op: "updateZoom", zoomId: "nope", zoom: 2 }], s), /does not exist/);
  assert.throws(() => prepareOps([{ op: "removeItem", track: "masks", id: "m" }], s), /does not exist/);
  // Ops earlier in the batch count: once B is gone, A may grow into its place.
  prepareOps(
    [
      { op: "removeZoom", zoomId: "B" },
      { op: "updateZoom", zoomId: "A", endMs: 5000 },
    ],
    s,
  );
  assert.throws(
    () =>
      prepareOps(
        [
          { op: "addZoom", startMs: 7000, endMs: 8000, zoom: 2, target: { x: 0.5, y: 0.5 } },
          { op: "updateZoom", zoomId: "B", endMs: 7500 },
        ],
        s,
      ),
    /added earlier in this batch/,
  );
  assert.throws(
    () =>
      prepareOps(
        [
          { op: "removeZoom", zoomId: "A" },
          { op: "removeZoom", zoomId: "A" },
        ],
        s,
      ),
    /does not exist/,
  );
  // Tracks whose contents become unknown are left to the editor.
  prepareOps([{ op: "restoreAutoZooms" }, { op: "updateZoom", zoomId: "auto", zoom: 2 }], s);
  prepareOps([{ op: "updateZoom", zoomId: "unknown", zoom: 2 }], scene());
});

test("mask updates take 0-1 rects like addMask", () => {
  const s = scene({ masks: [{ id: "m", sourceStartMs: 0, sourceEndMs: 1000 }] });
  const [op] = prepareOps(
    [
      {
        op: "updateItem",
        track: "masks",
        id: "m",
        fields: { rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.5 }], blur: 20 },
      },
    ],
    s,
  );
  assert.deepEqual(op.fields, { bounds: [{ x: 100, y: 100, width: 500, height: 250 }], blur: 20 });
  assert.throws(
    () =>
      prepareOps(
        [
          {
            op: "updateItem",
            track: "masks",
            id: "m",
            fields: { bounds: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.1 }] },
          },
        ],
        s,
      ),
    /fields.rects/,
  );
  const [raw] = prepareOps(
    [
      {
        op: "updateItem",
        track: "masks",
        id: "m",
        fields: { bounds: [{ x: 10, y: 10, width: 300, height: 100 }] },
      },
    ],
    s,
  );
  assert.equal(raw.fields.bounds[0].width, 300);
});

test("config changes need a dotted field, not a whole group", () => {
  const config = { styles: { screenBorderRadius: 10 } };
  assert.throws(() => configPartial(config, { styles: { screenBorderRadius: 4 } }), /dotted config keys/);
  assert.deepEqual(configPartial(config, { "styles.screenBorderRadius": 4 }), {
    styles: { screenBorderRadius: 4 },
  });
});

test("re-cut slices keep the per-clip settings of the footage they cover", () => {
  const existing = [
    { id: "a", sourceStartMs: 0, sourceEndMs: 4000, timeScale: 1, volume: 0, hideCursor: true },
    { id: "b", sourceStartMs: 5000, sourceEndMs: 9000, timeScale: 0.5, volume: 1, hideCursor: false },
  ];
  assert.deepEqual(clipFields(existing, { startMs: 3000, endMs: 8000 }), { volume: 1, hideCursor: false });
  assert.deepEqual(clipFields(existing, { startMs: 500, endMs: 3500 }), { volume: 0, hideCursor: true });
  // Footage no slice kept gets neutral settings, never slice 0's mute.
  const fresh = clipFields(existing, { startMs: 4000, endMs: 5000 });
  assert.equal(fresh.volume, 1);
  assert.equal(fresh.hideCursor, false);
  assert.equal(fresh.id, undefined);
});

// A fake of the editor's collections: add() assigns fresh ids and refuses overlaps.
let next = 0;
class Collection {
  constructor(items = []) {
    this.items = items.map((x) => this.wrap(x));
    this.refuse = () => false;
  }
  wrap(x) {
    const item = { ...x };
    Object.defineProperty(item, "update", { value: (ch) => Object.assign(item, ch) });
    return item;
  }
  get all() {
    return this.items;
  }
  get length() {
    return this.items.length;
  }
  serialize() {
    return this.items.map((x) => ({ ...x }));
  }
  add(x) {
    if (this.refuse(x)) return null;
    if (this.items.some((o) => o.sourceStartMs < x.sourceEndMs && o.sourceEndMs > x.sourceStartMs))
      return null;
    const item = this.wrap({ ...x, id: `new${++next}` });
    this.items.push(item);
    this.items.sort((a, b) => a.sourceStartMs - b.sourceStartMs);
    return item;
  }
  remove(id) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    return true;
  }
  removeAll() {
    this.items = [];
  }
  replace(list) {
    this.items = list.map((x) => this.wrap(x));
  }
  // Like the app, refuses a split that would leave a sliver shorter than 100ms.
  canSplitAt(ms) {
    return this.items.some((x) => ms > x.sourceStartMs + 100 && ms < x.sourceEndMs - 100);
  }
  splitAt(ms) {
    const i = this.items.findIndex((x) => ms > x.sourceStartMs && ms < x.sourceEndMs);
    const a = this.items[i];
    this.items.splice(
      i,
      1,
      this.wrap({ ...a, sourceEndMs: ms }),
      this.wrap({ ...a, id: `new${++next}`, sourceStartMs: ms }),
    );
  }
}

const PATH = "/p.screenstudio";
function editor({ slices = [], zooms = [], voiceOvers, config = {} } = {}) {
  const sc = {
    id: "s1",
    slices: new Collection(slices),
    zooms: new Collection(zooms),
    layouts: new Collection(),
    masks: new Collection(),
    voiceOvers: voiceOvers ?? new Collection(),
  };
  const busy = {};
  const c = {
    project: {
      playbackDurationMs: 10000,
      editGeneration: 0,
      serialize: () => ({ config }),
      projectConfig: {
        update(changes) {
          for (const [group, fields] of Object.entries(changes))
            Object.assign((config[group] ??= {}), fields);
          c.project.editGeneration++;
        },
      },
    },
    view: {},
    playback: {},
  };
  const ss = { busy: () => busy, edit: () => c, scene: () => sc };
  return {
    sc,
    busy,
    c,
    run: (ops, show, generation) =>
      new (async () => {}).constructor("__ss", applyScript(PATH, "s1", ops, show, generation))(ss),
  };
}

test("config batches preserve settings changed by earlier config ops", () => {
  const config = { camera: { background: { blurAmount01: 0, edgeFalloff01: 0.2 } } };
  const prepared = prepareOps(
    [
      { op: "config", changes: { "camera.background.edgeFalloff01": 0.4 } },
      { op: "config", changes: { "camera.background.blurAmount01": 0.3 } },
    ],
    { ...scene(), config },
  );
  assert.equal(prepared[1].partial.camera.background.edgeFalloff01, 0.4);
  assert.equal(config.camera.background.edgeFalloff01, 0.2);
});

test("a late invalid config is rejected before any scene edits run", () => {
  const s = scene({ zooms, layouts: [], masks: [] });
  assert.throws(() =>
    prepareOps(
      [
        { op: "clearZooms" },
        { op: "config", changes: { "cursor.size": 64, "styles.screenBorderRadius": -1 } },
      ],
      s,
    ),
  );
  assert.equal(s.tracks.zooms.length, 2);
});

test("a stale edit generation refuses the whole batch", async () => {
  const e = editor({ zooms });
  e.c.project.editGeneration = 2;
  await assert.rejects(e.run([{ op: "clearZooms" }], undefined, 1), /changed/);
  assert.equal(e.sc.zooms.length, 2);
});

test("a manual edit during a shown config batch stops without overwriting it", async () => {
  const config = { cursor: { size: 48 }, camera: { sharpen01: 0 } };
  const e = editor({ config });
  e.c.view.setSidebarRoot = () => {
    config.cursor.size = 72;
    e.c.project.editGeneration++;
  };
  const r = await e.run([{ op: "config", partial: { cursor: { size: 64 }, camera: { sharpen01: 0.2 } } }], {
    stepMs: 1,
  });
  assert.equal(r.failedAt, 0);
  assert.match(r.error, /changed/);
  assert.equal(config.cursor.size, 72);
  assert.equal(config.camera.sharpen01, 0);
});

test("a manual change between paced steps leaves later settings untouched", async () => {
  const config = { cursor: { size: 48 }, camera: { sharpen01: 0 } };
  const e = editor({ config });
  let timer;
  e.c.view.setSidebarRoot = () => {
    timer = setTimeout(() => {
      config.cursor.size = 72;
      e.c.project.editGeneration++;
    }, 1);
  };
  try {
    const r = await e.run([{ op: "config", partial: { cursor: { size: 64 }, camera: { sharpen01: 0.2 } } }], {
      stepMs: 10,
    });
    assert.equal(r.failedAt, 0);
    assert.match(r.error, /changed/);
    assert.equal(config.cursor.size, 72);
    assert.equal(config.camera.sharpen01, 0);
  } finally {
    clearTimeout(timer);
  }
});

test("a setting the app changes or ignores is reported instead of claiming success", async () => {
  const e = editor({ config: { cursor: { size: 48 } } });
  e.c.project.projectConfig.update = () => {};
  const r = await e.run([{ op: "config", partial: { cursor: { size: 64 } } }]);
  assert.equal(r.failedAt, 0);
  assert.match(r.error, /cursor.size/);
});
const slice = (id, sourceStartMs, sourceEndMs, extra = {}) => ({
  id,
  sourceStartMs,
  sourceEndMs,
  timeScale: 1,
  volume: 1,
  hideCursor: false,
  ...extra,
});

test("a failing op stops the batch and reports what ran", async () => {
  const e = editor({ zooms: zooms.map((z) => ({ ...z, zoom: 1.5, type: "manual" })) });
  const r = await e.run([
    { op: "removeZoom", zoomId: "B" },
    { op: "removeZoom", zoomId: "B" },
    { op: "clearZooms" },
  ]);
  assert.deepEqual(r.results, [{ op: "removeZoom", zoomId: "B" }]);
  assert.equal(r.failedAt, 1);
  assert.match(r.error, /does not exist/);
  assert.equal(e.sc.zooms.length, 1);
  assert.deepEqual(e.busy, {});
});

test("a refused zoom update puts the original back and says its new id", async () => {
  const e = editor({ zooms: zooms.map((z) => ({ ...z, zoom: 1.5, type: "manual", isDisabled: true })) });
  const overlap = await e.run([{ op: "updateZoom", zoomId: "A", endMs: 5000 }]);
  assert.match(overlap.error, /overlap B.*nothing changed/);
  assert.deepEqual(
    e.sc.zooms.serialize().map((z) => z.id),
    ["A", "B"],
  );
  e.sc.zooms.refuse = (x) => x.zoom === 3;
  const refused = await e.run([{ op: "updateZoom", zoomId: "A", zoom: 3 }]);
  assert.match(refused.error, /kept as it was, now with id new\d+/);
  assert.equal(e.sc.zooms.length, 2);
  e.sc.zooms.refuse = () => false;
  const ok = await e.run([{ op: "updateZoom", zoomId: "B", zoom: 2 }]);
  assert.equal(ok.failedAt, undefined);
  const updated = e.sc.zooms.serialize().find((z) => z.id === ok.results[0].zoomId);
  assert.equal(updated.zoom, 2);
  assert.equal(updated.isDisabled, true);
});

test("a refused item update keeps the item", async () => {
  const e = editor();
  e.sc.masks.replace([{ id: "m", type: "highlight", sourceStartMs: 0, sourceEndMs: 1000 }]);
  e.sc.masks.refuse = (x) => x.blur === 50;
  const r = await e.run([{ op: "updateItem", track: "masks", id: "m", fields: { blur: 50 } }]);
  assert.match(r.error, /refused the updated masks item m; it was kept as it was, now with id/);
  assert.equal(e.sc.masks.length, 1);
});

test("setSlices without show still writes per-clip settings", async () => {
  const e = editor({ slices: [slice("a", 0, 4000), slice("b", 5000, 9000)] });
  const r = await e.run([
    {
      op: "setSlices",
      slices: [
        { startMs: 0, endMs: 4000, speed: 1 },
        { startMs: 5000, endMs: 9000, speed: 1, volume: 0 },
      ],
    },
  ]);
  assert.deepEqual(r.results, [{ op: "setSlices", slices: 2 }]);
  assert.deepEqual(
    e.sc.slices.serialize().map((s) => [s.id, s.volume]),
    [
      ["a", 1],
      ["b", 0],
    ],
  );
});

test("setSlices re-cuts with fresh ids and each clip's own settings", async () => {
  const e = editor({
    slices: [slice("a", 0, 4000, { volume: 0 }), slice("b", 5000, 9000, { hideCursor: true })],
  });
  await e.run([
    {
      op: "setSlices",
      slices: [
        { startMs: 0, endMs: 2000, speed: 1 },
        { startMs: 6000, endMs: 8000, speed: 2 },
      ],
    },
  ]);
  const now = e.sc.slices.serialize();
  assert.equal(new Set(now.map((s) => s.id)).size, 2);
  assert.ok(!now.some((s) => s.id === "a"));
  assert.deepEqual(
    now.map((s) => [s.volume, s.hideCursor, s.timeScale]),
    [
      [0, false, 1],
      [1, true, 0.5],
    ],
  );
});

test("cutRange flags footage that was already cut and refuses a partial cut", async () => {
  const e = editor({ slices: [slice("a", 0, 4000), slice("b", 8000, 10000)] });
  const gone = await e.run([{ op: "cutRange", startMs: 5000, endMs: 7000 }]);
  assert.deepEqual(gone.results, [{ op: "cutRange", removedPieces: 0, alreadyCut: true }]);
  const cut = await e.run([{ op: "cutRange", startMs: 1000, endMs: 2000 }]);
  assert.deepEqual(cut.results, [{ op: "cutRange", removedPieces: 1 }]);
  // 3950 is too close to the cut at 4000 to split, so 3950-4000 would stay.
  const partial = await e.run([{ op: "cutRange", startMs: 3950, endMs: 9000 }]);
  assert.equal(partial.failedAt, 0);
  assert.match(partial.error, /still overlaps it at 3950-4000ms/);
});

test("voiceover edits are refused when they could not be restored", async () => {
  const e = editor({ voiceOvers: { removeAll() {} } });
  await assert.rejects(e.run([{ op: "clearTrack", track: "voiceOvers" }]), /cannot restore voiceovers/);
});

test("writes wait out an edit that is still running in the editor", async () => {
  globalThis.window = { __ssmcpBusy: { [PATH]: { since: Date.now() - 5000 } } };
  try {
    const ss = new Function(`${PRELUDE}; return __ss;`)();
    assert.throws(() => ss.edit(PATH), /still running on this project \(started 5s ago\)/);
  } finally {
    delete globalThis.window;
  }
});

test("writes to one project run one at a time, other projects do not wait", async () => {
  const log = [];
  const studio = {
    path: async (p) => p,
    requireVersion: async () => {},
    evaluate: async (body) => {
      const project = /__ss\.edit\("([^"]+)"\)/.exec(body)[1];
      log.push(`start ${project}`);
      await new Promise((r) => setTimeout(r, project === "/a" ? 30 : 5));
      log.push(`end ${project}`);
      return {};
    },
  };
  const editor = new Editor(studio);
  await Promise.all([
    editor.history("/a", "undo", 1),
    editor.seek("/a", { playbackMs: 0 }),
    editor.seek("/b", { playbackMs: 0 }),
  ]);
  assert.deepEqual(log, ["start /a", "start /b", "end /b", "end /a", "start /a", "end /a"]);
});

test("live project lookups fail loudly in a running app and are null when it is closed", async () => {
  const studio = (running, evaluate) => ({ isRunning: async () => running, evaluate });
  const closed = new Editor(studio(false, async () => assert.fail("closed app was queried")));
  assert.equal(await closed.liveProject("/a"), null);
  const notOpen = new Editor(studio(true, async () => null));
  assert.equal(await notOpen.liveProject("/a"), null);
  const broken = new Editor(
    studio(true, async () => {
      throw new Error("renderer went away");
    }),
  );
  await assert.rejects(broken.liveProject("/a"), /renderer went away/);
});
