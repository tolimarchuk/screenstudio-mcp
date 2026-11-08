// Recording through the renderer modules of Screen Studio 4.1.0: the config the app's
// picker would build, the session and source shapes, and the module loader.
import test from "node:test";
import assert from "node:assert/strict";
import {
  displaysSnippet,
  loadModulesSnippet,
  recordingConfig,
  sessionState,
  sourcesFromModules,
} from "../dist/studio/recording-modules.js";
import { RECORDING_MODULES } from "../dist/studio/compat.js";
import { controllerMethod } from "../dist/studio/service.js";

const settings = {
  maximumWebcamHeight: 1080,
  recordingUseScreenCaptureKit: "auto",
  hideDesktopContentWhileRecording: false,
};
const finder = {
  id: 28365,
  pid: 750,
  appName: "Finder",
  bundleId: "com.apple.finder",
  title: "Salaam Remi Cut",
  bounds: { x: 700, y: 185, width: 920, height: 436 },
  borderRadius: 26,
};
const retina = { id: 1, label: "Built-in Retina Display", bounds: { x: 0, y: 0, width: 2056, height: 1329 } };
const external = { id: 2, label: "Dell", bounds: { x: 2056, y: -200, width: 2560, height: 1440 } };

test("a window records as its screen area, tagged with the app behind it", () => {
  const config = recordingConfig({ windowId: finder.id, name: "Finder tour" }, { window: finder }, settings);
  assert.deepEqual(config.bounds, finder.bounds);
  assert.equal(config.windowId, null, "the app never sets windowId; the picker uses bounds plus windowInfo");
  assert.deepEqual(config.windowInfo, {
    bundleId: "com.apple.finder",
    appName: "Finder",
    title: "Salaam Remi Cut",
  });
  assert.equal(config.recordedWindowBorderRadius, 26);
  assert.equal(config.displayId, null);
  assert.equal(config.name, "Finder tour");
  assert.equal(config.cameraMaximumHeight, 1080);
  assert.equal(config.enableScreenCaptureKit, "auto");
  assert.equal(config.recordSystemAudio, null);
  assert.equal(config.microphoneDeviceId, null);
});

test("a display records by id, with audio and camera only when asked", () => {
  const config = recordingConfig(
    {
      displayId: 1,
      name: "Whole screen",
      microphoneDeviceId: "BuiltInMicrophoneDevice",
      cameraDeviceId: "cam-1",
      systemAudio: true,
    },
    { display: retina },
    settings,
  );
  assert.equal(config.displayId, 1);
  assert.equal(config.bounds, null);
  assert.equal(config.microphoneDeviceId, "BuiltInMicrophoneDevice");
  assert.equal(config.cameraDeviceId, "cam-1");
  assert.deepEqual(config.recordSystemAudio, { type: "all" });
});

test("an area is given in display points and becomes screen points", () => {
  const config = recordingConfig(
    { displayId: 2, area: { x: 100, y: 50, width: 800, height: 600 }, name: "Corner" },
    { display: external },
    settings,
  );
  assert.deepEqual(config.bounds, { x: 2156, y: -150, width: 800, height: 600 });
  assert.equal(config.displayId, null, "an area never also names the display, like the picker");
});

test("no window and no display is refused", () => {
  assert.throws(() => recordingConfig({ name: "x" }, {}, settings), /exactly one window or display/);
});

test("a session exposes the app's phase as type, and idle stays null", () => {
  assert.equal(sessionState(null), null);
  const s = sessionState({ phase: "paused", outputDirectory: "/tmp/r", appData: "{}" });
  assert.equal(s.type, "paused");
  assert.equal(s.outputDirectory, "/tmp/r");
});

test("sources keep the bridge-era displayID and list windows, microphones and cameras", () => {
  const out = sourcesFromModules({
    displays: [retina],
    windows: [finder],
    microphones: [{ deviceId: "BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", isDefault: true }],
    cameras: [{ deviceId: "cam-1", name: "MacBook Pro Camera" }],
  });
  assert.equal(out.devices.displays[0].displayID, 1);
  assert.equal(out.devices.displays[0].label, "Built-in Retina Display");
  assert.equal(out.windows[0].id, 28365);
  assert.equal(out.windows[0].appName, "Finder");
  assert.equal(out.devices.microphones[0].name, "MacBook Pro Microphone");
  assert.equal(out.devices.cameras[0].isDefault, false);
});

test("the module loader imports each chunk by file URL and checks the shapes it relies on", () => {
  const snippet = loadModulesSnippet("/Applications/Screen Studio.app", RECORDING_MODULES["4.1.0-5005"]);
  assert.match(
    snippet,
    /import\("file:\/\/\/Applications\/Screen%20Studio\.app\/Contents\/Resources\/app\.asar\/dist\/26mpnmSu2\.js"\)\)\["g"\]/,
  );
  assert.match(snippet, /DLnk-cLt\.js"\)\)\["t"\]/);
  assert.match(snippet, /typeof controller\?\.startRecording !== "function"/);
  assert.match(displaysSnippet, /displays\.allDisplays/);
});

test("each adapter action maps to the controller's own method name", () => {
  assert.equal(controllerMethod("pause"), "pauseRecording");
  assert.equal(controllerMethod("resume"), "resumeRecording");
  assert.equal(controllerMethod("finish"), "finishRecording");
  assert.equal(controllerMethod("restart"), "restartRecording");
  assert.equal(controllerMethod("cancel"), "cancelRecording");
  assert.equal(controllerMethod("addMarker"), "addMarker");
});
