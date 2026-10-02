export interface CDPPage {
  id: string;
  title: string;
  url: string;
  type?: string;
  webSocketDebuggerUrl: string;
}
export function assertLocalSocket(url: string, port: number): void {
  const target = new URL(url);
  if (
    target.protocol !== "ws:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    Number(target.port) !== port ||
    target.username ||
    target.password
  )
    throw new Error(
      "Screen Studio returned an unexpected debugging address. Only local connections are supported.",
    );
}
export async function listPages(port: number): Promise<CDPPage[]> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Debugging port must be an integer between 1024 and 65535.");
  try {
    // The app can stall for a few seconds while it processes audio; listing pages is
    // read-only, so wait longer and try once more before giving up.
    const get = () =>
      fetch(`http://127.0.0.1:${port}/json`, {
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
    const response = await get().catch(() => get());
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const pages = await response.json();
    if (!Array.isArray(pages)) throw new Error("Invalid target list");
    for (const p of pages) assertLocalSocket(p.webSocketDebuggerUrl, port);
    return pages;
  } catch (error) {
    throw new Error(
      `Cannot connect to Screen Studio on port ${port}. Start an automation session first. ${error instanceof Error ? error.message : ""}`,
    );
  }
}
/** Starts every renderer error that means "busy", so callers can tell it from "not running". */
export const RENDERER_BUSY = "Screen Studio's renderer did not respond";

type Probe = { studio?: boolean; worker?: boolean; version?: string } | null;

function probeRenderer(url: string, timeoutMs: number): { result: Promise<Probe>; close: () => void } {
  const ws = new WebSocket(url);
  const result = new Promise<Probe>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1000}s`)), timeoutMs);
    const fail = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression: `JSON.stringify({studio:!!window.bridge && !!window.electronEnv,worker:!!window.electronEnv?.IS_RENDER_WORKER,version:window.electronEnv?.APP_VERSION})`,
            returnByValue: true,
          },
        }),
      );
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data));
        if (m.id !== 1) return;
        clearTimeout(timer);
        resolve(JSON.parse(m.result?.result?.value ?? "null"));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    ws.onerror = () => fail(new Error("connection failed"));
    ws.onclose = () => fail(new Error("connection closed"));
  });
  return { result, close: () => ws.close() };
}

/** A page loaded from Screen Studio's own app bundle. */
export function isAppPage(url: string) {
  if (!url.startsWith("file://")) return false;
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return false;
  }
  return /\/Screen Studio\.app\/Contents\/Resources\/app\.asar\/dist\/index\.html$/.test(path);
}

export async function findRendererPage(
  port: number,
  options: { probeTimeoutMs?: number } = {},
): Promise<string> {
  // Only Screen Studio's own bundled page: a web page in another app on the same port could
  // carry the same words in its URL, but not a file:// URL inside a Screen Studio.app bundle.
  const pages = (await listPages(port)).filter((p) => isAppPage(p.url));
  // Export workers load the same index.html as the editor, so URL order is unsafe. A worker
  // busy rendering can take long to answer, so all candidates are probed at once.
  const probes = pages.map((p) => ({
    page: p,
    ...probeRenderer(p.webSocketDebuggerUrl, options.probeTimeoutMs ?? 10000),
  }));
  try {
    const failures: string[] = [];
    const found = await new Promise<string | null>((resolve) => {
      let pending = probes.length;
      if (!pending) resolve(null);
      for (const p of probes)
        p.result
          .then((probe) => {
            if (probe?.studio && !probe.worker) resolve(p.page.webSocketDebuggerUrl);
          })
          .catch((error) => failures.push(error instanceof Error ? error.message : String(error)))
          .finally(() => {
            if (--pending === 0) resolve(null);
          });
    });
    if (found) return found;
    if (failures.length)
      throw new Error(
        `${RENDERER_BUSY} (${[...new Set(failures)].join("; ")}). It may be busy exporting, recording or loading; retry shortly.`,
      );
    throw new Error("Screen Studio editor renderer was not found. Its export worker is not an editor.");
  } finally {
    for (const p of probes) p.close();
  }
}
