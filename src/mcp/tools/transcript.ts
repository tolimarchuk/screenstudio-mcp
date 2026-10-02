import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Context } from "../context.js";
import { ONLINE, READ, WRITE, path, toolsOn } from "../tool.js";
import {
  editTranscript,
  fillers,
  generateTranscript,
  phrases,
  readTranscript,
} from "../../studio/transcript.js";

export function register(server: McpServer, { studio }: Context) {
  const tool = toolsOn(server);

  tool(
    "screenstudio_transcript_generate",
    "Transcribe the microphone with Screen Studio's own recognizer. Default is the on-device system recognizer (no upload); pass a generator like {type:'whisper', model} only when the person wants it (it can download a model). Captions come from this transcript. Replaces the current transcript, including caption fixes made with screenstudio_transcript_edit. editor is 'updated' when the open editor now shows it, or 'not-open'.",
    {
      projectPath: path,
      locale: z
        .string()
        .transform((l) => l.replace("-", "_"))
        .pipe(z.string().regex(/^[a-z]{2}_[A-Z]{2}$/))
        .default("en_US"),
      generator: z.record(z.string(), z.unknown()).optional(),
    },
    { ...ONLINE, destructiveHint: true },
    async (a) => {
      const t = await generateTranscript(
        studio,
        await studio.path(a.projectPath),
        a.generator ? { locale: a.locale, ...a.generator } : { type: "system", locale: a.locale },
      );
      return { sessions: t.sessions, words: t.words.length, phrases: phrases(t.words), editor: t.editor };
    },
  );

  tool(
    "screenstudio_transcript_read",
    "Read the transcript: every word with its index and source ms, phrases (speech separated by pauses), filler words. Does not generate or upload anything.",
    { projectPath: path },
    READ,
    async (a) => {
      const t = await readTranscript(studio, await studio.path(a.projectPath));
      return { ...t, phrases: phrases(t.words), fillers: fillers(t.words) };
    },
  );

  tool(
    "screenstudio_transcript_edit",
    "Fix the transcript the captions show: correct a misheard word or name (keep the word's leading space), or remove words from the captions. Indexes come from screenstudio_transcript_read. Updates the open editor live; editor is 'updated' when it now shows the change, or 'not-open'.",
    {
      projectPath: path,
      session: z.number().int().min(0).default(0),
      edits: z
        .array(
          z
            .object({
              index: z.number().int().min(0),
              text: z.string().max(200).optional(),
              remove: z.boolean().optional(),
            })
            .strict(),
        )
        .min(1)
        .max(500),
    },
    WRITE,
    async (a) => {
      const t = await editTranscript(studio, await studio.path(a.projectPath), a.session, a.edits);
      return {
        words: t.words.length,
        text: t.words
          .map((w) => w.text)
          .join("")
          .trim(),
        editor: t.editor,
      };
    },
  );
}
