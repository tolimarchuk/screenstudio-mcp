import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { DevToolsSession } from "../dist/cdp/client.js";
import { findRendererPage } from "../dist/cdp/page-finder.js";

async function fixture(t, respond) {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        ["worker", "editor"].map((id) => ({
          id,
          type: "page",
          url: "file:///Applications/Screen%20Studio.app/Contents/Resources/app.asar/dist/index.html",
          webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/${id}`,
        })),
      ),
    );
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) =>
    ws.on("message", (bytes) => {
      const msg = JSON.parse(bytes.toString());
      if (msg.params?.expression?.includes("IS_RENDER_WORKER")) {
        ws.send(
          JSON.stringify({
            id: msg.id,
            result: {
              result: {
                value: JSON.stringify({
                  studio: true,
                  worker: req.url === "/worker",
                  version: "4.0.1-4897",
                }),
              },
            },
          }),
        );
      } else respond(ws, msg);
    }),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close();
  });
  return server.address().port;
}

test("discovery skips the export worker even when it is first", async (t) => {
  const port = await fixture(t, () => {});
  assert.match(await findRendererPage(port), /\/editor$/);
});
test("top-level CDP failures reject instead of reporting success", async (t) => {
  const port = await fixture(t, (ws, msg) =>
    ws.send(
      JSON.stringify({
        id: msg.id,
        error: { code: -32602, message: "Invalid parameters" },
      }),
    ),
  );
  const client = new DevToolsSession(port);
  await client.open();
  t.after(() => client.close());
  await assert.rejects(client.evaluate("return 1;"), /Invalid parameters/);
});
test("disconnect rejects in-flight operations immediately", async (t) => {
  const port = await fixture(t, (ws) => ws.close());
  const client = new DevToolsSession(port);
  await client.open();
  await assert.rejects(client.evaluateAwait("Promise.resolve(1)"), /closed|disconnect/i);
});
test("evaluation timeout cleans up and leaves connection usable", async (t) => {
  let calls = 0;
  const port = await fixture(t, (ws, msg) => {
    if (++calls > 1)
      ws.send(
        JSON.stringify({
          id: msg.id,
          result: { result: { value: JSON.stringify(7) } },
        }),
      );
  });
  const client = new DevToolsSession(port, { timeoutMs: 30 });
  await client.open();
  t.after(() => client.close());
  await assert.rejects(client.evaluate("return 1;"), /timed out/i);
  assert.equal(await client.evaluate("return 7;"), 7);
});
test("renderer exceptions and async rejections reach the caller", async (t) => {
  const port = await fixture(t, (ws, msg) =>
    ws.send(
      JSON.stringify({
        id: msg.id,
        result: {
          exceptionDetails: {
            text: "Uncaught",
            exception: { description: "Error: recording failed" },
          },
        },
      }),
    ),
  );
  const client = new DevToolsSession(port);
  await client.open();
  t.after(() => client.close());
  await assert.rejects(client.evaluateAwait("Promise.reject(new Error())"), /recording failed/);
});
/** Lists a worker and an editor page; only renderers named in `answering` reply to the probe. */
async function stalledFixture(t, answering) {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        ["worker", "editor"].map((id) => ({
          id,
          type: "page",
          url: "file:///Applications/Screen%20Studio.app/Contents/Resources/app.asar/dist/index.html",
          webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/${id}`,
        })),
      ),
    );
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) =>
    ws.on("message", (bytes) => {
      if (!answering.includes(req.url.slice(1))) return;
      const msg = JSON.parse(bytes.toString());
      const value = JSON.stringify({ studio: true, worker: req.url === "/worker" });
      ws.send(JSON.stringify({ id: msg.id, result: { result: { value } } }));
    }),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close();
  });
  return server.address().port;
}
test("a stalled editor renderer is reported as busy, not missing", async (t) => {
  const port = await stalledFixture(t, ["worker"]);
  await assert.rejects(
    findRendererPage(port, { probeTimeoutMs: 50 }),
    /renderer did not respond \(no answer within 0.05s\)\. It may be busy/,
  );
});
test("a worker busy rendering does not delay finding the editor", async (t) => {
  const port = await stalledFixture(t, ["editor"]);
  const started = Date.now();
  assert.match(await findRendererPage(port, { probeTimeoutMs: 5000 }), /\/editor$/);
  assert.ok(Date.now() - started < 2000);
});
