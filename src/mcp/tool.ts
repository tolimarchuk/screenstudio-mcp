// The one way tools are registered: typed arguments, JSON text results, images
// as MCP image content, and errors as tool errors instead of protocol failures.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DEFAULT_STYLE, STYLE_NAMES } from "../studio/styles.js";

const annotate = ({ readOnly = false, destructive = false, openWorld = false } = {}): ToolAnnotations => ({
  readOnlyHint: readOnly,
  destructiveHint: destructive,
  openWorldHint: openWorld,
});
export const READ = annotate({ readOnly: true });
export const WRITE = annotate();
/** Writes that can throw away work for good, like discarding a recording. */
export const DESTRUCTIVE = annotate({ destructive: true });
/** Writes that send data to, or download from, an online service. */
export const ONLINE = annotate({ openWorld: true });
/** Real mouse and keyboard input on the person's desktop. */
export const DESKTOP_INPUT = annotate({ destructive: true, openWorld: true });

export interface Image {
  data: string;
  label: string;
}
/** A PNG for the tool result, shown after its label. */
export const image = (png: Buffer, label: string): Image => ({ data: png.toString("base64"), label });
type ImageResult = { images: Image[]; text?: unknown };

// Argument shapes shared across tools.
export const path = z.string().min(1);
export const id = z.number().int().positive();
export const span = z
  .object({ startMs: z.number().min(0), endMs: z.number().min(0) })
  .strict()
  .refine((s) => s.endMs > s.startMs, { message: "endMs must be after startMs" });
export const style = z.enum(STYLE_NAMES).default(DEFAULT_STYLE);

/** What the SDK passes a tool call besides its arguments: the request's progress token, cancel signal and a way to notify. */
export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Progress reports for a long call, as MCP progress notifications. Clients that
 * sent a progress token reset their request timeout on each one; without a
 * token it does nothing.
 */
export function progressOf(extra?: ToolExtra) {
  const token = extra?._meta?.progressToken;
  return (progress: number, total: number, message: string) => {
    if (token === undefined) return;
    extra!
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, total, message },
      })
      .catch(() => {});
  };
}

export type Tool = <S extends z.ZodRawShape>(
  name: string,
  description: string,
  input: S,
  annotations: ToolAnnotations,
  fn: (args: z.infer<z.ZodObject<S>>, extra: ToolExtra) => unknown,
) => void;

export function toolsOn(server: McpServer): Tool {
  return (name, description, input, annotations, fn) => {
    const shape: z.ZodRawShape = input;
    server.registerTool(
      name,
      { description, inputSchema: shape, annotations },
      async (args, extra): Promise<CallToolResult> => {
        try {
          // The SDK has already parsed args against `input`.
          const value = await fn(args as z.infer<z.ZodObject<typeof input>>, extra);
          if ((value as ImageResult | null)?.images) {
            const out = value as ImageResult;
            return {
              content: [
                ...out.images.flatMap((img) => [
                  { type: "text" as const, text: img.label },
                  { type: "image" as const, data: img.data, mimeType: "image/png" as const },
                ]),
                ...(out.text !== undefined
                  ? [{ type: "text" as const, text: JSON.stringify(out.text) }]
                  : []),
              ],
            };
          }
          return { content: [{ type: "text" as const, text: JSON.stringify(value ?? null) }] };
        } catch (error) {
          return {
            isError: true,
            content: [
              { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
            ],
          };
        }
      },
    );
  };
}
