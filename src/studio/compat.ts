// Everything tied to one Screen Studio build. A new app version starts here.

export const APP_BUILD = "4.0.1-4897";
/** Builds this adapter has been exercised against; the first is the reference build. */
export const KNOWN_BUILDS = [APP_BUILD, "4.1.0-5005"];
export const PROJECT_SCHEMA = "4.0.0";
/**
 * Builds whose main process still serves recording over the bridge
 * (capture.currentSessionState, capture.inputDiscovery, capture.start, windows.capturableWindows).
 * 4.1.0 moved recording into the renderer's own stores, so those routes are gone there.
 */
export const RECORDING_BRIDGE_BUILDS = [APP_BUILD];
export const recordingUnavailable = (version: string) =>
  `Screen Studio ${version} keeps recording in renderer modules this adapter does not know yet, so it cannot start, inspect or control a recording on this build. Record in Screen Studio as usual; editing, analysis, transcripts and exports of the result work.`;

/** One module inside the app bundle: its chunk file under dist/ and the minified export name. */
export type ModuleRef = { chunk: string; exportName: string };
/**
 * Builds that record through renderer modules. The controller drives one recording
 * (start, pause, resume, marker, restart, cancel, finish); the native client lists
 * capturable windows and holds the live session; settings and devices feed the config.
 */
export type RecordingModules = {
  controller: ModuleRef;
  native: ModuleRef;
  settings: ModuleRef;
  devices: ModuleRef;
};
export const RECORDING_MODULES: Record<string, RecordingModules> = {
  "4.1.0-5005": {
    controller: { chunk: "26mpnmSu2.js", exportName: "g" },
    native: { chunk: "DLnk-cLt.js", exportName: "t" },
    settings: { chunk: "CF0eKRBO.js", exportName: "t" },
    devices: { chunk: "CVCogM-Y2.js", exportName: "t" },
  },
};

/** Bundle chunk holding the editor's transcript model, and its minified export. */
export const TRANSCRIPT_CHUNK = "RS8E8hrv2.js";
export const TRANSCRIPT_EXPORT = "t";

export const editorWindowTitle = (projectName: string) => `Project - ${projectName}`;

export const capabilities = {
  app: "Screen Studio",
  testedVersion: APP_BUILD,
  schema: PROJECT_SCHEMA,
  transport: "local stdio",
  features: {
    recording: true,
    windowCapture: true,
    pauseResume: true,
    markers: true,
    config: true,
    trimSpeed: true,
    screenAndLoupeZoom: true,
    liveEditorEditing: true,
    editorPreviewFrames: true,
    recordingAnalysis: true,
    editPlanning: true,
    pacingCheck: true,
    localExport: true,
    renderedPreview: true,
    desktopInput: true,
    transcriptRead: true,
    transcriptGeneration: true,
    transcriptEditing: true,
    voiceoverGeneration: false,
    backgroundMusic: true,
    presets: true,
    maskEditing: true,
    layoutTimelineEditing: true,
    fitToLength: true,
    recordingMarkers: true,
    directorsNotes: true,
    recipes: true,
    cameraDirector: true,
    brandKits: true,
    narrationCaptions: true,
    voiceLines: true,
    sensitiveTextRedaction: true,
    exportVariants: true,
    seamlessLoops: true,
    contactSheet: true,
  },
  /** Tools beyond the app's own commands. */
  tools: [
    "screenstudio_recipes",
    "screenstudio_plan_layouts",
    "screenstudio_brand",
    "screenstudio_voice_lines",
    "screenstudio_find_sensitive",
    "screenstudio_export_variants",
    "screenstudio_loop",
    "screenstudio_contact_sheet",
  ],
  notes: [
    "Unofficial integration. Screen Studio updates may change internal interfaces.",
    "Caption styling, webcam processing and layout defaults are available as config settings.",
    "Screen Studio AI and recorded voiceover tracks are disabled in this app build; narration uses the background audio track.",
    "Edits go through the open editor window: they appear live, use the app's undo history and save like Cmd+S.",
    "Exports render the open editor's live project (the saved project when no editor has it open; export results say which) through the local QA render destination to avoid a save dialog, then move the file to the requested destination. No sharing or upload.",
  ],
};
