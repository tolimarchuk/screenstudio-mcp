import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Context } from "../context.js";
import { ONLINE, WRITE, path, toolsOn } from "../tool.js";
import { music, narrate, narrationInput, voiceLines } from "../../studio/narration.js";

export function register(server: McpServer, { studio, editor }: Context) {
  const tool = toolsOn(server);

  tool(
    "screenstudio_narrate",
    "Voice over the video. Each line is spoken by a neural voice (edge-tts, an online Microsoft voice service, so the line text leaves this Mac) and pinned to a moment: sourceMs (stays on its moment through later edits) or playbackMs. pinToMarkers puts each line without a time 300ms after its recording marker (line i on marker i). Lines are mixed, optionally over Screen Studio library music ducked under speech (e.g. 'commercial/Product Uplift'), and attached as the project's audio track through the app. captions:true captions the voice: as Screen Studio's own captions when the recording has no microphone, otherwise as .srt and styled .ass files next to the project for burn-in. Returns each line's playback start/end, notes on what it chose and warnings when a line runs into the next or past the end. Call again without lines after changing the cut to re-sync. Screen Studio's own AI and recorded voiceover tracks are disabled in this app build. Re-sync keeps the last voice, rate, music, volumes and captions unless you pass new ones; music laid by screenstudio_music stays under the voice unless music is null. Write lines in the person's voice; never credit the agent or AI in them.",
    { projectPath: path, ...narrationInput },
    ONLINE,
    (a) => narrate(studio, editor, a.projectPath, a),
  );

  tool(
    "screenstudio_voice_lines",
    "Voice a script before recording, without a project: returns each line's spoken durationMs and beatMs (line plus 400ms) so every beat can be recorded to last as long as its line (screenstudio_desktop_perform minDurationMs, with markers:true). Uses edge-tts (online; the text leaves this Mac). The clips are cached, so screenstudio_narrate with the same text, voice and rate reuses them.",
    {
      lines: z
        .array(z.object({ text: z.string().min(1).max(1000) }).strict())
        .min(1)
        .max(60),
      voice: narrationInput.voice,
      rate: narrationInput.rate,
    },
    ONLINE,
    (a) => voiceLines(studio, a),
  );

  tool(
    "screenstudio_music",
    "Lay a track from Screen Studio's music library under the edited video, faded in and out. duckUnderSpeech dips it smoothly while anyone speaks (from the transcript). Uses the project's background audio track, shared with narration (narration has its own music option). If the track holds narration, the music is mixed under it instead of replacing it.",
    {
      projectPath: path,
      track: z.string().max(80),
      volume: z.number().min(0).max(1).default(0.08),
      duckUnderSpeech: z.boolean().default(true),
      duckTo: z.number().min(0).max(1).default(0.35),
    },
    WRITE,
    (a) => music(studio, editor, a.projectPath, a),
  );
}
