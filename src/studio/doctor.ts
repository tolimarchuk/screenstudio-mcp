// What a first recording needs from this Mac, for screenstudio_status and the installer's doctor.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { exec, locateTool } from "./media.js";
import { edgeTts } from "./narration.js";

const helper = fileURLToPath(new URL("../../native/desktop-helper", import.meta.url));

/** Missing tools are null; permissions are those of the app this server runs under. */
export async function dependencies() {
  const tts = await edgeTts();
  const edge = tts.includes("/") && existsSync(tts) ? tts : null;
  let permissions: { accessibility: boolean; screenRecording: boolean } | null = null;
  if (existsSync(helper))
    permissions = await exec(helper, ["trust"], { timeout: 15000 }).then(
      (r) => JSON.parse(r.stdout),
      () => null,
    );
  return {
    ffmpeg: await locateTool("ffmpeg"),
    ffprobe: await locateTool("ffprobe"),
    edgeTts: edge,
    inputHelper: existsSync(helper) ? helper : null,
    permissions,
  };
}
