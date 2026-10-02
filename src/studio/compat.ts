// Everything tied to one Screen Studio build. A new app version starts here.

export const APP_BUILD = "4.0.1-4897";
export const PROJECT_SCHEMA = "4.0.0";

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
