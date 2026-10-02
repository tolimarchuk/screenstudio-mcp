// Studio launch decisions, export delivery and preview timing, against a fake app.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import {
  Studio,
  appEnv,
  assertOutputWritable,
  configuredPort,
  deliverFile,
  launchPort,
  mainProcess,
  partialPath,
  previewSeconds,
  runningAppError,
} from "../dist/studio/service.js";

const APP = "/Applications/Screen Studio.app";

test("SCREENSTUDIO_PORT is validated, and blank means unset", () => {
  assert.equal(configuredPort({}), null);
  assert.equal(configuredPort({ SCREENSTUDIO_PORT: "  " }), null);
  assert.equal(configuredPort({ SCREENSTUDIO_PORT: " 9333 " }), 9333);
  assert.throws(() => configuredPort({ SCREENSTUDIO_PORT: "abc" }), /SCREENSTUDIO_PORT/);
  assert.throws(() => configuredPort({ SCREENSTUDIO_PORT: "80" }), /SCREENSTUDIO_PORT/);
});

test("the main process is found with or without its debugging port", () => {
  const helper = `${APP}/Contents/Frameworks/Screen Studio Helper.app/Contents/MacOS/Screen Studio Helper --type=renderer`;
  assert.equal(mainProcess(`/usr/bin/zsh\n${helper}\n`, APP), null);
  assert.deepEqual(mainProcess(`${helper}\n${APP}/Contents/MacOS/Screen Studio\n`, APP), { port: null });
  assert.deepEqual(
    mainProcess(`${APP}/Contents/MacOS/Screen Studio --remote-debugging-port=9333 --x\n`, APP),
    { port: 9333 },
  );
});

test("launch explains a running app instead of always asking to quit it", () => {
  const busy = new Error("Screen Studio's renderer did not respond (no answer within 10s).");
  assert.match(runningAppError({ port: null }, null, busy), /quit it \(Cmd\+Q\)/);
  const stalled = runningAppError({ port: 9222 }, null, busy);
  assert.match(stalled, /automation on port 9222 but did not respond/);
  assert.match(stalled, /no answer within 10s/);
  assert.doesNotMatch(stalled, /Cmd\+Q/);
  assert.match(runningAppError({ port: 9222 }, 9333, busy), /SCREENSTUDIO_PORT is 9333/);
  assert.match(
    runningAppError({ port: 9222 }, null, new Error("Screen Studio editor renderer was not found.")),
    /another app may hold it/,
  );
});

test("the spawned app never inherits run-as-node or node options", () => {
  const env = appEnv({ PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--inspect" });
  assert.deepEqual(env, { PATH: "/usr/bin" });
});

test("a configured port that is taken is refused before launching", async (t) => {
  const server = createTcpServer().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  const taken = server.address().port;
  await assert.rejects(launchPort(taken), new RegExp(`Port ${taken} is in use`));
  const probe = createTcpServer().listen(0, "127.0.0.1");
  await new Promise((r) => probe.once("listening", r));
  const free = probe.address().port;
  await new Promise((r) => probe.close(r));
  assert.equal(await launchPort(free), free);
});

test("preview times in the last frame interval land on the last frame", () => {
  const video = { endSec: 2, frameSec: 1 / 30 };
  assert.equal(previewSeconds(1000, video), 1);
  assert.ok(previewSeconds(1990, video) < 2 - 1 / 30);
  assert.ok(previewSeconds(2000, video) > 2 - 2 / 30);
  assert.throws(() => previewSeconds(2001, video), /outside/);
  assert.throws(() => previewSeconds(-1, video), /outside/);
  assert.equal(previewSeconds(0, { endSec: 0.01, frameSec: 1 / 30 }), 0);
});

test("delivery never replaces an existing file and recognises its own earlier link", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-deliver-"));
  const src = join(dir, "QA-1.mp4");
  await writeFile(src, "render");
  const out = join(dir, "out.mp4");
  await deliverFile(src, out, "job");
  await deliverFile(src, out, "job");
  assert.equal(await readFile(out, "utf8"), "render");
  const other = join(dir, "other.mp4");
  await writeFile(other, "someone else");
  await assert.rejects(deliverFile(src, other, "job"), /EEXIST/);
  assert.equal(await readFile(other, "utf8"), "someone else");
  assert.equal(partialPath(out, "job"), `${out}.partial-job`);
});

test("export destinations are checked before rendering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ss-out-"));
  await assert.rejects(assertOutputWritable(join(dir, "missing", "a.mp4")), /does not exist/);
  await writeFile(join(dir, "a.mp4"), "");
  await assert.rejects(assertOutputWritable(join(dir, "a.mp4")), /already exists/);
  await assertOutputWritable(join(dir, "b.mp4"));
});

/** A fake Screen Studio: one editor renderer answering bridge calls from `state`. */
async function fakeApp(t) {
  const root = await mkdtemp(join(tmpdir(), "ss-app-"));
  const state = { qaDir: join(root, "qa"), exportId: "e1", status: "rendering", calls: [] };
  await mkdir(state.qaDir);
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify([
        {
          id: "editor",
          type: "page",
          url: "file:///Applications/Screen%20Studio.app/Contents/Resources/app.asar/dist/index.html",
          webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/editor`,
        },
      ]),
    );
  });
  const answer = (expression) => {
    if (expression.includes("IS_RENDER_WORKER")) return { studio: true, worker: false };
    if (expression.includes('"app.version"')) return "4.0.1-4897";
    if (expression.includes('"project.readProject"')) return { projectData: { version: "4.0.0" } };
    if (expression.includes("export.getTempQaExportsPath")) return state.qaDir;
    if (expression.includes("__screenstudioMcpJobs??=")) {
      state.calls.push(expression);
      return { started: true };
    }
    if (expression.includes("__screenstudioMcpJobs?.["))
      return { status: state.status, exportId: state.exportId };
    throw new Error(`Unexpected evaluation: ${expression.slice(0, 80)}`);
  };
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) =>
    ws.on("message", (bytes) => {
      const msg = JSON.parse(bytes.toString());
      ws.send(
        JSON.stringify({
          id: msg.id,
          result: { result: { value: JSON.stringify(answer(msg.params.expression)) } },
        }),
      );
    }),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const ffprobe = join(root, "ffprobe");
  await writeFile(
    ffprobe,
    `#!/bin/sh\necho '{"format":{"duration":"2"},"streams":[{"width":2,"height":2}]}'\n`,
  );
  await chmod(ffprobe, 0o755);
  const saved = { ...process.env };
  process.env.SCREENSTUDIO_PORT = String(server.address().port);
  process.env.SCREENSTUDIO_STATE_DIR = join(root, "state");
  process.env.SCREENSTUDIO_FFPROBE = ffprobe;
  t.after(() => {
    process.env = saved;
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close();
  });
  const project = join(root, "demo.screenstudio");
  await mkdir(project);
  const out = join(root, "out");
  await mkdir(out);
  const render = async () => {
    state.status = "completed";
    const file = join(state.qaDir, `QA-demo-${state.exportId}.mp4`);
    await writeFile(file, "rendered video");
    return file;
  };
  return { root, state, studio: new Studio(), project, out, render };
}

const options = { height: 240, fps: 24, format: "mp4", quality: "studio" };

test("a failed live-editor lookup aborts the export instead of rendering the saved project", async (t) => {
  const app = await fakeApp(t);
  const live = async () => {
    throw new Error("Runtime.evaluate timed out");
  };
  await assert.rejects(
    app.studio.exportStart(app.project, join(app.out, "a.mp4"), options, live),
    /timed out/,
  );
  assert.equal(app.state.calls.length, 0);
});

test("exports say which project they render and move the render out of the temp folder", async (t) => {
  const app = await fakeApp(t);
  const disk = await app.studio.exportStart(app.project, join(app.out, "a.mp4"), options, async () => null);
  assert.equal(disk.source, "disk");
  assert.match(disk.note, /unsaved edits are not included/);
  assert.doesNotMatch(app.state.calls[0], /"outputPath"/);
  assert.equal((await app.studio.exportStatus(disk.jobId)).source, "disk");
  const rendered = await app.render();
  const done = await app.studio.exportStatus(disk.jobId);
  assert.equal(done.status, "completed");
  assert.equal(await readFile(join(app.out, "a.mp4"), "utf8"), "rendered video");
  await assert.rejects(stat(rendered), /ENOENT/);
  assert.deepEqual(await app.studio.exportStatus(disk.jobId), done);

  app.state.exportId = "e2";
  app.state.status = "rendering";
  const kept = await app.studio.exportStart(
    app.project,
    join(app.out, "b.mp4"),
    { ...options, keepRender: true },
    async () => ({ version: "4.0.0", live: true }),
  );
  assert.equal(kept.source, "live");
  assert.equal(kept.note, undefined);
  assert.match(app.state.calls[1], /"live":true/);
  const keptRender = await app.render();
  assert.equal((await app.studio.exportStatus(kept.jobId)).status, "completed");
  await stat(keptRender);
});

test("an output path in use or taken before delivery ends the job with the render's location", async (t) => {
  const app = await fakeApp(t);
  const target = join(app.out, "a.mp4");
  const job = await app.studio.exportStart(app.project, target, options);
  await assert.rejects(app.studio.exportStart(app.project, target, options), /already writing/);
  await assert.rejects(
    app.studio.exportStart(app.project, join(app.out, "nope", "a.mp4"), options),
    /does not exist/,
  );
  await writeFile(target, "someone else's file");
  const rendered = await app.render();
  const failed = await app.studio.exportStatus(job.jobId);
  assert.equal(failed.status, "delivery_failed");
  assert.equal(failed.renderedPath, rendered);
  assert.match(failed.error, /EEXIST/);
  assert.equal(await readFile(target, "utf8"), "someone else's file");
  await stat(rendered);
  assert.deepEqual(await app.studio.exportStatus(job.jobId), failed);
  assert.deepEqual(
    (await readdir(app.out)).sort(),
    ["a.mp4"],
    "no partial copies are left beside the output",
  );
});
