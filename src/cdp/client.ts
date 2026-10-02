import { findRendererPage, assertLocalSocket } from "./page-finder.js";

/** A command sent over the DevTools socket that is still waiting for its reply. */
interface InFlight {
  settle(error: Error | null, result?: unknown): void;
  deadline: NodeJS.Timeout;
}

const CLOSED_MID_COMMAND =
  "Screen Studio connection closed. Reconnect and inspect state before retrying a change.";

/**
 * One DevTools Protocol session with Screen Studio's editor renderer.
 * Commands are matched to replies by id; every command carries its own deadline.
 */
export class DevToolsSession {
  private socket: WebSocket | null = null;
  private lastId = 0;
  private readonly inFlight = new Map<number, InFlight>();
  private readonly defaultTimeoutMs: number;

  constructor(
    private readonly port = 9222,
    { timeoutMs = 30_000 }: { timeoutMs?: number } = {},
  ) {
    this.defaultTimeoutMs = timeoutMs;
  }

  /** Finds the editor renderer on the debugging port and opens a socket to it. */
  async open(): Promise<void> {
    const url = await findRendererPage(this.port);
    assertLocalSocket(url, this.port);
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.addEventListener("message", (event) => this.onReply(event.data));
    socket.addEventListener("close", () => this.abandonAll(new Error(CLOSED_MID_COMMAND)));
    socket.addEventListener("error", () => this.abandonAll(new Error("Screen Studio connection failed.")));
    await waitForOpen(socket, this.defaultTimeoutMs);
  }

  /** Sends one protocol command and resolves with its result. */
  async command<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.defaultTimeoutMs,
  ): Promise<T> {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) throw new Error("Screen Studio is not connected.");
    const id = ++this.lastId;
    return new Promise<T>((resolve, reject) => {
      const deadline = setTimeout(() => {
        this.inFlight.delete(id);
        reject(
          new Error(
            `${method} timed out after ${timeoutMs}ms. The operation may have completed; inspect state before retrying.`,
          ),
        );
      }, timeoutMs);
      this.inFlight.set(id, {
        deadline,
        settle: (error, result) => (error ? reject(error) : resolve(result as T)),
      });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(deadline);
        this.inFlight.delete(id);
        reject(error);
      }
    });
  }

  /** Runs a function body (which may `await` and `return`) in the renderer. */
  async evaluate<T = unknown>(body: string): Promise<T> {
    return this.evaluateAwait<T>(`(async function(){ ${body} })()`);
  }

  /** Evaluates an expression in the renderer, awaits it and returns its JSON value. */
  async evaluateAwait<T = unknown>(expression: string, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    const wrapped = `(async()=>{const value=await (${expression});return JSON.stringify(value===undefined?null:value);})()`;
    const reply = await this.command<any>(
      "Runtime.evaluate",
      { expression: wrapped, returnByValue: true, awaitPromise: true },
      timeoutMs,
    );
    const thrown = reply.exceptionDetails;
    if (thrown)
      throw new Error(thrown.exception?.description ?? thrown.text ?? "Screen Studio evaluation failed.");
    const value = reply.result?.value;
    return (typeof value === "string" ? JSON.parse(value) : value) as T;
  }

  /** Rejects anything still waiting and closes the socket. */
  close(): void {
    this.abandonAll(new Error("Screen Studio disconnected."));
    this.socket?.close();
    this.socket = null;
  }

  private onReply(data: unknown): void {
    let reply: any;
    try {
      reply = JSON.parse(String(data));
    } catch {
      return;
    }
    const entry = this.inFlight.get(reply.id);
    if (!entry) return;
    this.inFlight.delete(reply.id);
    clearTimeout(entry.deadline);
    if (reply.error) entry.settle(new Error(`CDP: ${reply.error.message}`));
    else entry.settle(null, reply.result);
  }

  private abandonAll(reason: Error): void {
    for (const entry of this.inFlight.values()) {
      clearTimeout(entry.deadline);
      entry.settle(reason);
    }
    this.inFlight.clear();
  }
}

/** Resolves once the socket opens; rejects if it errors, closes or takes longer than `timeoutMs`. */
function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const outcomes: Array<[string, Error | null]> = [
      ["open", null],
      ["error", new Error("Failed to connect to Screen Studio.")],
      ["close", new Error("Screen Studio connection closed.")],
    ];
    const giveUp = setTimeout(() => {
      socket.close();
      reject(new Error("Screen Studio connection timed out."));
    }, timeoutMs);
    for (const [name, failure] of outcomes)
      socket.addEventListener(
        name,
        () => {
          clearTimeout(giveUp);
          if (failure) reject(failure);
          else resolve();
        },
        { once: true },
      );
  });
}

/** Opens a session on `port`, runs `work` with it and always closes it afterwards. */
export async function withSession<T>(
  port: number,
  work: (session: DevToolsSession) => Promise<T>,
): Promise<T> {
  const session = new DevToolsSession(port);
  try {
    await session.open();
    return await work(session);
  } finally {
    session.close();
  }
}
