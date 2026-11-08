// Recording on builds that keep it in renderer modules (Screen Studio 4.1.0 and later).
//
// The app's own recording picker builds one config object and hands it to its recording
// controller. This file builds that same object from the adapter's inputs, loads the app's
// modules inside the renderer by URL (ES modules are singletons, so the import returns the
// live instances), and reads sessions and sources back into the adapter's own shapes.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModuleRef, RecordingModules } from "./compat.js";

const j = JSON.stringify;

export type Rect = { x: number; y: number; width: number; height: number };

export interface StartInput {
  windowId?: number;
  displayId?: number;
  area?: Rect;
  name: string;
  microphoneDeviceId?: string;
  cameraDeviceId?: string;
  systemAudio?: boolean;
}

/** A window as the native client lists it. */
export interface CapturableWindow {
  id: number;
  pid?: number;
  appName: string;
  bundleId: string;
  title: string;
  bounds: Rect;
  borderRadius?: number;
}

/** A display as the app's `displays.allDisplays` subscription reports it. */
export interface Display {
  id: number;
  label: string;
  bounds: Rect;
  scaleFactor?: number;
}

/** The app settings the recording config copies. */
export interface RecordingSettings {
  maximumWebcamHeight: number;
  recordingUseScreenCaptureKit: unknown;
  hideDesktopContentWhileRecording: boolean;
}

export interface MediaDevice {
  deviceId: string;
  name: string;
  isDefault?: boolean;
}

/**
 * The config the app's picker gives `capture.prepareRecording`, built the same way the
 * picker builds it. A window is recorded as its screen area, tagged with the app behind it;
 * an area is given in points of its display and becomes screen points here.
 */
export function recordingConfig(
  input: StartInput,
  source: { window?: CapturableWindow; display?: Display },
  settings: RecordingSettings,
) {
  const config = {
    microphoneDeviceId: input.microphoneDeviceId ?? null,
    cameraDeviceId: input.cameraDeviceId ?? null,
    cameraMaximumHeight: settings.maximumWebcamHeight,
    bounds: null as Rect | null,
    displayId: null as number | null,
    externalDeviceId: null,
    windowId: null,
    enableScreenCaptureKit: settings.recordingUseScreenCaptureKit,
    hideDesktopIcons: settings.hideDesktopContentWhileRecording,
    recordSystemAudio: input.systemAudio ? { type: "all" } : null,
    recordingFlags: [] as string[],
    recordedWindowBorderRadius: null as number | null,
    windowInfo: null as { bundleId: string; appName: string; title: string } | null,
    name: input.name,
  };
  if (source.window) {
    const w = source.window;
    config.bounds = w.bounds;
    config.recordedWindowBorderRadius = w.borderRadius ?? null;
    config.windowInfo = { bundleId: w.bundleId, appName: w.appName, title: w.title };
    return config;
  }
  if (!source.display) throw new Error("Select exactly one window or display.");
  if (input.area) {
    const d = source.display.bounds;
    config.bounds = {
      x: d.x + input.area.x,
      y: d.y + input.area.y,
      width: input.area.width,
      height: input.area.height,
    };
    return config;
  }
  config.displayId = source.display.id;
  return config;
}

/** A live session with `type` set from the app's `phase`, so callers read one field on every build. */
export function sessionState(session: Record<string, unknown> | null) {
  if (!session) return null;
  return { ...session, type: session.phase };
}

/** Sources in the adapter's shape: displays keep `displayID` as the older bridge named it. */
export function sourcesFromModules(raw: {
  displays: Display[];
  windows: CapturableWindow[];
  microphones: MediaDevice[];
  cameras: MediaDevice[];
}) {
  return {
    devices: {
      displays: raw.displays.map((d) => ({
        displayID: d.id,
        id: d.id,
        label: d.label,
        bounds: d.bounds,
        scaleFactor: d.scaleFactor,
      })),
      microphones: raw.microphones.map((m) => ({
        deviceId: m.deviceId,
        name: m.name,
        isDefault: m.isDefault ?? false,
      })),
      cameras: raw.cameras.map((c) => ({
        deviceId: c.deviceId,
        name: c.name,
        isDefault: c.isDefault ?? false,
      })),
    },
    windows: raw.windows.map((w) => ({
      id: w.id,
      pid: w.pid,
      appName: w.appName,
      bundleId: w.bundleId,
      title: w.title,
      bounds: w.bounds,
    })),
  };
}

/**
 * Renderer code that loads the app's recording modules into `controller`, `native`,
 * `settings` and `devices`, and fails clearly when a build moved them.
 */
export function loadModulesSnippet(appPath: string, modules: RecordingModules) {
  const base = pathToFileURL(join(appPath, "Contents/Resources/app.asar/dist")).href + "/";
  const load = (m: ModuleRef) => `(await import(${j(base + m.chunk)}))[${j(m.exportName)}]`;
  return `const controller = ${load(modules.controller)};
const native = ${load(modules.native)};
const settings = ${load(modules.settings)};
const devices = ${load(modules.devices)};
if (typeof controller?.startRecording !== "function" || !native?.recording || !native?.windows || !settings || !devices)
  throw new Error("Screen Studio's recording modules changed in this build; the adapter needs an update.");`;
}

/** Renderer code that resolves the app's `displays.allDisplays` subscription once. */
export const displaysSnippet = `const displays = await new Promise((resolve, reject) => {
  let stop;
  const timer = setTimeout(() => { stop?.(); reject(new Error("Display list timed out")); }, 5000);
  stop = bridge.client.subscription("displays.allDisplays", undefined, {
    onNext(v) { if (v.type === "data") { clearTimeout(timer); stop?.(); resolve(v.data); } },
    onError(e) { clearTimeout(timer); stop?.(); reject(e); },
  });
});`;
