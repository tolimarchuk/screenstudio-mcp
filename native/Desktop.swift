import ApplicationServices
import Carbon
import Cocoa
import CoreGraphics
import Vision

// Native input for recorded walkthroughs. Pacing is deliberately human:
// viewers follow a cursor that glides, settles, then clicks, and text that is
// typed at a readable rhythm.

let source = CGEventSource(stateID: .hidSystemState)

// What this helper is holding down right now, so every way out can let go of it.
// Otherwise a failed drag leaves the button down and the person's next move drags.
var heldButton = false
var heldKey: CGKeyCode? = nil
var heldModifiers: [(CGKeyCode, CGEventFlags)] = []
func releaseHeld() {
  var flags = heldModifiers.reduce(CGEventFlags()) { $0.union($1.1) }
  if let key = heldKey {
    heldKey = nil
    let e = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false)
    e?.flags = flags
    e?.post(tap: .cghidEventTap)
  }
  if heldButton {
    heldButton = false
    let at = CGEvent(source: nil)?.location ?? .zero
    CGEvent(
      mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: at, mouseButton: .left
    )?.post(tap: .cghidEventTap)
  }
  for (code, flag) in heldModifiers.reversed() {
    flags.remove(flag)
    let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
    e?.type = .flagsChanged
    e?.flags = flags
    e?.post(tap: .cghidEventTap)
  }
  heldModifiers = []
}
func fail(_ text: String) -> Never {
  releaseHeld()
  fputs(text + "\n", stderr)
  exit(1)
}
// A timeout or Ctrl-C stops the helper mid-gesture. The main thread is asleep
// between events, so the handlers run on another queue.
var stopSignals: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT] {
  signal(sig, SIG_IGN)
  let s = DispatchSource.makeSignalSource(signal: sig, queue: .global())
  s.setEventHandler {
    releaseHeld()
    exit(128 + sig)
  }
  s.resume()
  stopSignals.append(s)
}
func output(_ value: Any) {
  guard let d = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
    let s = String(data: d, encoding: .utf8)
  else { fail("JSON failed") }
  print(s)
}

// Keys whose virtual key codes are the same on every keyboard layout.
let namedKeys: [String: CGKeyCode] = [
  "return": 36, "tab": 48, "space": 49, "backspace": 51, "escape": 53, "delete": 117,
  "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "left": 123, "right": 124, "down": 125, "up": 126,
]
let modifierKeys: [String: (CGKeyCode, CGEventFlags)] = [
  "command": (55, .maskCommand), "shift": (56, .maskShift), "option": (58, .maskAlternate),
  "control": (59, .maskControl),
]
// Letters and punctuation come from the person's keyboard layout, not US key
// positions: on AZERTY the US "a" key is Q, so Cmd+A sent by position quits the
// app. Input methods without a key layout (Japanese, Chinese) fall back to the
// ASCII layout macOS itself uses for shortcuts.
func layoutData(named id: String? = nil) -> CFData? {
  let inputs =
    id.map {
      (TISCreateInputSourceList([kTISPropertyInputSourceID: $0] as CFDictionary, true)?
        .takeRetainedValue() as? [TISInputSource] ?? []).map(Optional.some)
    } ?? [
      TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
      TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue(),
    ]
  for case let input? in inputs {
    if let raw = TISGetInputSourceProperty(input, kTISPropertyUnicodeKeyLayoutData) {
      return Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue()
    }
  }
  return nil
}
let mainKeys = Array(0..<65) + Array(93..<128)
let keypadKeys = Array(65...92)
func keyCode(for character: String, modifierState: UInt32, in data: CFData, keys: [Int] = mainKeys)
  -> CGKeyCode?
{
  guard let bytes = CFDataGetBytePtr(data) else { return nil }
  let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
  for code in keys {
    var dead: UInt32 = 0
    var length = 0
    var chars = [UniChar](repeating: 0, count: 4)
    let status = UCKeyTranslate(
      layout, UInt16(code), UInt16(kUCKeyActionDown), modifierState, UInt32(LMGetKbdType()),
      OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, chars.count, &length, &chars)
    if status == noErr, length > 0,
      String(utf16CodeUnits: chars, count: length).lowercased() == character
    {
      return CGKeyCode(code)
    }
  }
  return nil
}
/** The key code to press for a key name, and the modifiers to hold with it. */
func resolveKey(_ name: String, _ modifiers: [String], layout: String? = nil) -> (CGKeyCode, [String]) {
  for m in modifiers where modifierKeys[m] == nil { fail("Unsupported modifier: \(m)") }
  if let code = namedKeys[name] { return (code, modifiers) }
  guard name.count == 1 else { fail("Unsupported key: \(name)") }
  guard let data = layoutData(named: layout) else { fail("Cannot read the keyboard layout") }
  // Layouts like "Dvorak - QWERTY ⌘" move keys while Command is held.
  let command = modifiers.contains("command") ? UInt32(cmdKey >> 8) : 0
  if let code = keyCode(for: name, modifierState: command, in: data) { return (code, modifiers) }
  // A character that needs Shift on this layout (digits on AZERTY), pressed on its own.
  if modifiers.isEmpty, let code = keyCode(for: name, modifierState: UInt32(shiftKey >> 8), in: data) {
    return (code, ["shift"])
  }
  if let code = keyCode(for: name, modifierState: command, in: data, keys: keypadKeys) {
    return (code, modifiers)
  }
  fail("Key \(name) is not on the current keyboard layout")
}

let args = CommandLine.arguments
// Permission check for the installer's doctor: no window needed.
if args.count >= 2 && args[1] == "trust" {
  // With "prompt", macOS shows its own permission requests for the app this runs under.
  if args.count == 3 && args[2] == "prompt" {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
    if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
  }
  output(["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()])
  exit(0)
}
if args.count < 3 { fail("Expected action and window ID, or ocr and image paths") }
let action = args[1]

// Report which key a name maps to, without pressing anything: on the current
// layout, or on an installed one named like com.apple.keylayout.French.
if action == "resolve-key" {
  let (code, modifiers) = resolveKey(
    args[2], args.count > 3 ? args[3].split(separator: ",").filter { !$0.isEmpty }.map(String.init) : [],
    layout: args.count > 4 ? args[4] : nil)
  output(["keyCode": code, "modifiers": modifiers])
  exit(0)
}

// Read the text in still images with Apple's Vision, for finding private data
// in recorded frames: one JSON line per text line, boxes 0-1 with a top-left
// origin. Words (split at spaces and punctuation like = : , ; quotes and
// brackets) carry UTF-16 offsets into the line, so a match inside a line
// can be boxed on its own. Language correction is off: it "fixes" tokens.
if action == "ocr" {
  func topLeft(_ r: CGRect) -> [String: Double] {
    ["x": Double(r.minX), "y": Double(1 - r.maxY), "width": Double(r.width), "height": Double(r.height)]
  }
  for (index, file) in args.dropFirst(2).enumerated() {
    guard let image = NSImage(contentsOfFile: file),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
    else { fail("Cannot read image \(file)") }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    if #available(macOS 13.0, *) { request.automaticallyDetectsLanguage = true }
    do { try VNImageRequestHandler(cgImage: cg, options: [:]).perform([request]) } catch {
      fail("Text recognition failed for \(file): \(error.localizedDescription)")
    }
    for observation in request.results ?? [] {
      guard let best = observation.topCandidates(1).first else { continue }
      let text = best.string
      var words: [[String: Any]] = []
      var start: String.Index? = nil
      for i in text.indices + [text.endIndex] {
        let blank = i == text.endIndex || text[i].isWhitespace || "=:,;\"'()<>[]{}".contains(text[i])
        if !blank, start == nil { start = i }
        guard blank, let s = start else { continue }
        start = nil
        if let box = try? best.boundingBox(for: s..<i) {
          words.append([
            "start": text.utf16.distance(from: text.startIndex, to: s),
            "end": text.utf16.distance(from: text.startIndex, to: i),
            "box": topLeft(box.boundingBox),
          ])
        }
      }
      output([
        "image": index, "text": text, "confidence": Double(best.confidence),
        "box": topLeft(observation.boundingBox), "words": words,
      ])
    }
  }
  exit(0)
}

let windows =
  CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
  as? [[String: Any]] ?? []

// Locate an on-screen window by exact title (used to find an editor window).
if action == "find-title" {
  let matches = windows.filter { ($0[kCGWindowName as String] as? String) == args[2] }
  guard matches.count == 1, let id = matches[0][kCGWindowNumber as String] as? UInt32 else {
    fail("Window not found on screen. Bring the editor window on screen and try again.")
  }
  output(["windowId": id])
  exit(0)
}

guard let id = UInt32(args[2]) else { fail("Invalid window ID") }
guard let window = windows.first(where: { ($0[kCGWindowNumber as String] as? UInt32) == id }),
  let pid = window[kCGWindowOwnerPID as String] as? Int32,
  let raw = window[kCGWindowBounds as String] as? NSDictionary,
  let bounds = CGRect(dictionaryRepresentation: raw)
else { fail("Target window is no longer on screen") }
let title = window[kCGWindowName as String] as? String ?? ""
// Apps an agent may not drive or screenshot: terminals (typed commands run),
// password managers and system security UI. SCREENSTUDIO_ALLOW_APPS (bundle
// ids, comma separated) opens one up, e.g. for a command-line demo.
let excludedApps: Set<String> = [
  "com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "com.mitchellh.ghostty",
  "net.kovidgoyal.kitty", "io.alacritty", "co.zeit.hyper", "com.github.wez.wezterm",
  "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop",
  "com.lastpass.LastPass", "com.dashlane.Dashlane", "com.apple.Passwords", "com.apple.keychainaccess",
  "com.apple.systempreferences", "com.apple.SecurityAgent", "com.apple.ScreenContinuity",
]
let allowed = Set(
  (ProcessInfo.processInfo.environment["SCREENSTUDIO_ALLOW_APPS"] ?? "").split(separator: ",").map {
    $0.trimmingCharacters(in: .whitespaces)
  })
if let bundle = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier,
  excludedApps.contains(bundle), !allowed.contains(bundle)
{
  fail(
    "\(bundle) is excluded from input and screenshots by default. To allow it, set SCREENSTUDIO_ALLOW_APPS=\(bundle) in the MCP server's environment."
  )
}
func focusedDetails() -> [String: Any] {
  guard AXIsProcessTrusted(), NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
  else { return [:] }
  var rawElement: CFTypeRef?
  AXUIElementCopyAttributeValue(
    AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute as CFString, &rawElement)
  guard let rawElement = rawElement, CFGetTypeID(rawElement) == AXUIElementGetTypeID() else {
    return [:]
  }
  let element = rawElement as! AXUIElement
  func attribute(_ name: String) -> String {
    var value: CFTypeRef?
    AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return value as? String ?? ""
  }
  let subrole = attribute(kAXSubroleAttribute)
  return [
    "role": attribute(kAXRoleAttribute), "label": attribute(kAXTitleAttribute),
    "value": subrole == "AXSecureTextField" ? "[protected]" : attribute(kAXValueAttribute),
  ]
}
if action == "inspect" {
  let pointer = CGEvent(source: nil)?.location ?? .zero
  output([
    "windowId": id, "pid": pid, "title": title,
    "bounds": [
      "x": bounds.origin.x, "y": bounds.origin.y, "width": bounds.width, "height": bounds.height,
    ], "focusedElement": focusedDetails(), "accessibility": AXIsProcessTrusted(),
    "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
    "pointer": ["x": pointer.x - bounds.origin.x, "y": pointer.y - bounds.origin.y],
  ])
  exit(0)
}
guard AXIsProcessTrusted() else {
  fail(
    "Enable Accessibility for the desktop helper in macOS Settings, then inspect the target again")
}
let app = AXUIElementCreateApplication(pid)
func matches(_ ax: AXUIElement) -> Bool {
  var p: CFTypeRef?
  var s: CFTypeRef?
  AXUIElementCopyAttributeValue(ax, kAXPositionAttribute as CFString, &p)
  AXUIElementCopyAttributeValue(ax, kAXSizeAttribute as CFString, &s)
  guard let p = p, let s = s, CFGetTypeID(p) == AXValueGetTypeID(),
    CFGetTypeID(s) == AXValueGetTypeID()
  else { return false }
  var point = CGPoint.zero
  var size = CGSize.zero
  AXValueGetValue(p as! AXValue, .cgPoint, &point)
  AXValueGetValue(s as! AXValue, .cgSize, &size)
  return abs(point.x - bounds.origin.x) < 2 && abs(point.y - bounds.origin.y) < 2
    && abs(size.width - bounds.width) < 2 && abs(size.height - bounds.height) < 2
}
// Asked of Accessibility each time: NSWorkspace only updates its frontmost app
// when the main run loop runs, which it does not while input is being sent.
func frontmostPid() -> pid_t? {
  var value: CFTypeRef?
  guard
    AXUIElementCopyAttributeValue(
      AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &value) == .success,
    let value = value, CFGetTypeID(value) == AXUIElementGetTypeID()
  else { return nil }
  var focusedPid: pid_t = 0
  AXUIElementGetPid(value as! AXUIElement, &focusedPid)
  return focusedPid
}
/** The target app is frontmost and its focused window is the observed one. */
func isFocused() -> Bool {
  // The app's own AXFrontmost answers even when the system-wide focused-app
  // query cannot complete (it fails while two copies of a browser run).
  var front: CFTypeRef?
  let asked = AXUIElementCopyAttributeValue(app, kAXFrontmostAttribute as CFString, &front)
  if asked == .success, let isFront = front as? Bool {
    guard isFront else { return false }
  } else {
    guard frontmostPid() == pid else { return false }
  }
  var now: CFTypeRef?
  AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &now)
  guard let now = now, CFGetTypeID(now) == AXUIElementGetTypeID() else { return false }
  return matches(now as! AXUIElement)
}
if action == "focus" {
  var value: CFTypeRef?
  AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value)
  let candidates = (value as? [AXUIElement] ?? []).filter(matches)
  guard candidates.count == 1 else { fail("Cannot uniquely match the target window for focus") }
  AXUIElementPerformAction(candidates[0], kAXRaiseAction as CFString)
  NSRunningApplication(processIdentifier: pid)?.activate(options: [])
  for i in 1...20 {
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    if isFocused() {
      output(["focused": true])
      exit(0)
    }
    if i == 5 {
      // macOS can decline activation asked by a background process; Accessibility usually works.
      AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
      AXUIElementSetAttributeValue(candidates[0], kAXMainAttribute as CFString, kCFBooleanTrue)
    }
  }
  fail(
    "Could not bring the target window to the front (macOS declined activation). Click the window once or bring it forward, then inspect again"
  )
}
guard isFocused() else { fail("Focus changed. Inspect and focus the target before acting") }
func assertFocus() {
  if !isFocused() { fail("Focus changed during input. Inspect the target again") }
}
// Clicks and scrolls land on whatever window is topmost at the point, so check
// nothing covers the target there: a notification, a floating panel, a control
// bar. Fully transparent windows, the menu bar, screen-sized overlays (such as
// a recorder's click-through layer) and the target app's own open menu (the
// next click picks from it) are not in the way.
func screenArea(at p: CGPoint) -> CGFloat {
  var display: CGDirectDisplayID = 0
  var count: UInt32 = 0
  CGGetDisplaysWithPoint(p, 1, &display, &count)
  let screen = count > 0 ? CGDisplayBounds(display) : .zero
  return screen.width * screen.height
}
func assertUncovered(_ p: CGPoint) {
  let above =
    CGWindowListCopyWindowInfo(
      [.optionOnScreenAboveWindow, .excludeDesktopElements], CGWindowID(id)) as? [[String: Any]]
    ?? []
  let passThrough: Set<Int> = [
    Int(CGWindowLevelForKey(.mainMenuWindow)), Int(CGWindowLevelForKey(.statusWindow)),
    Int(CGWindowLevelForKey(.cursorWindow)),
  ]
  let menu = Int(CGWindowLevelForKey(.popUpMenuWindow))
  for w in above {
    let layer = w[kCGWindowLayer as String] as? Int ?? 0
    guard (w[kCGWindowAlpha as String] as? Double ?? 1) > 0, !passThrough.contains(layer),
      !(layer == menu && w[kCGWindowOwnerPID as String] as? Int32 == pid),
      let raw = w[kCGWindowBounds as String] as? NSDictionary,
      let r = CGRect(dictionaryRepresentation: raw), r.contains(p),
      r.width * r.height < screenArea(at: p) * 0.9
    else { continue }
    let owner = w[kCGWindowOwnerName as String] as? String ?? "another window"
    fail("The target is covered at that point by \(owner). Move it away, then inspect again")
  }
}
func post(_ event: CGEvent?) {
  guard let event = event else { fail("Cannot create input event") }
  event.post(tap: .cghidEventTap)
}
func mouse(_ type: CGEventType, _ p: CGPoint, clicks: Int = 1) {
  let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: .left)
  e?.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
  post(e)
  heldButton = type == .leftMouseDown
}
func point(_ xi: Int = 3, _ yi: Int = 4) -> CGPoint {
  guard args.count > yi, let x = Double(args[xi]), let y = Double(args[yi]), x.isFinite, y.isFinite,
    x >= 0, y >= 0, x < bounds.width, y < bounds.height
  else { fail("Coordinates must be inside the target window") }
  return CGPoint(x: bounds.origin.x + x, y: bounds.origin.y + y)
}
func ms(_ v: Double) { usleep(useconds_t(max(0, v) * 1000)) }
// Pace multiplier from the caller: 1 is natural, 1.5 is slower and calmer.
let pace = Double(ProcessInfo.processInfo.environment["SCREENSTUDIO_PACE"] ?? "1") ?? 1

// Glide along a gentle arc. Duration grows with distance, like a person's hand.
// Where this helper last put the pointer. If the pointer is somewhere else
// before the next step, the person moved the mouse: stop and hand it back.
var lastPointer: CGPoint? = nil
func checkPointerUnmoved() {
  guard let last = lastPointer, let now = CGEvent(source: nil)?.location else { return }
  if hypot(now.x - last.x, now.y - last.y) > 12 { fail("Stopped: you moved the mouse. Inspect again to continue.") }
}
func move(_ target: CGPoint, dragging: Bool = false) {
  let initial = CGEvent(source: nil)?.location ?? target
  lastPointer = initial
  let dx = target.x - initial.x
  let dy = target.y - initial.y
  let distance = hypot(dx, dy)
  if distance < 1 { return }
  let duration = min(1100, max(420, 380 + Double(distance) * 0.45)) * pace
  let steps = max(12, Int(duration / 8))
  let bend = min(Double(distance) * 0.08, 36) * (dx >= 0 ? 1 : -1)
  let nx = distance > 0 ? -Double(dy) / Double(distance) : 0
  let ny = distance > 0 ? Double(dx) / Double(distance) : 0
  for i in 1...steps {
    assertFocus()
    checkPointerUnmoved()
    let t = Double(i) / Double(steps)
    let eased = t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2
    let arc = sin(Double.pi * t) * bend
    let p = CGPoint(
      x: Double(initial.x) + Double(dx) * eased + nx * arc,
      y: Double(initial.y) + Double(dy) * eased + ny * arc)
    post(
      CGEvent(
        mouseEventSource: source, mouseType: dragging ? .leftMouseDragged : .mouseMoved,
        mouseCursorPosition: p, mouseButton: .left))
    lastPointer = p
    ms(duration / Double(steps))
  }
}
func press(_ name: String, _ requested: [String]) {
  let (key, modifiers) = resolveKey(name, requested)
  var flags: CGEventFlags = []
  for m in modifiers {
    let (code, flag) = modifierKeys[m]!
    flags.insert(flag)
    let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
    e?.type = .flagsChanged
    e?.flags = flags
    post(e)
    heldModifiers.append((code, flag))
    ms(45)
  }
  // Focus is checked before the key goes down only: a shortcut like Cmd+N moves
  // focus itself, and its key-up must still be sent.
  assertFocus()
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down)
    e?.flags = flags
    post(e)
    heldKey = down ? key : nil
    ms(down ? 70 : 40)
  }
  for m in modifiers.reversed() {
    let (code, flag) = modifierKeys[m]!
    flags.remove(flag)
    let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
    e?.type = .flagsChanged
    e?.flags = flags
    post(e)
    heldModifiers.removeLast()
    ms(45)
  }
}

switch action {
case "move": move(point())
case "click", "doubleClick":
  let p = point()
  move(p)
  ms(200 * pace)  // settle, so the viewer sees where the click lands
  for n in 1...(action == "doubleClick" ? 2 : 1) {
    assertFocus()
    checkPointerUnmoved()
    assertUncovered(p)
    mouse(.leftMouseDown, p, clicks: n)
    ms(85)
    mouse(.leftMouseUp, p, clicks: n)
    if n == 1 && action == "doubleClick" { ms(90) }
  }
case "taps":
  // A burst of rapid repeated taps at one spot: glide there once, then tap at the given rhythm.
  let p = point()
  guard args.count >= 7, let count = Int(args[5]), let every = Double(args[6]), (1...80).contains(count),
    every >= 30, every <= 2000
  else { fail("taps needs count 1-80 and intervalMs 30-2000") }
  move(p)
  ms(150 * pace)
  for _ in 0..<count {
    assertFocus()
    checkPointerUnmoved()
    assertUncovered(p)
    mouse(.leftMouseDown, p)
    ms(min(45, every / 2))
    mouse(.leftMouseUp, p)
    ms(every - min(45, every / 2))
  }
case "hold":
  // Press and hold, then let go: long presses, charge-up buttons, hold-to-release mechanics.
  let p = point()
  guard args.count >= 6, let hold = Double(args[5]), hold >= 50, hold <= 15000 else {
    fail("hold needs ms 50-15000")
  }
  move(p)
  ms(150 * pace)
  assertFocus()
  assertUncovered(p)
  mouse(.leftMouseDown, p)
  var held = 0.0
  while held < hold {
    let step = min(50, hold - held)
    ms(step)
    held += step
    assertFocus()
    checkPointerUnmoved()
  }
  mouse(.leftMouseUp, p)
case "drag":
  let from = point(3, 4)
  let to = point(5, 6)
  move(from)
  ms(200 * pace)
  assertFocus()
  assertUncovered(from)
  assertUncovered(to)
  mouse(.leftMouseDown, from)
  ms(150)
  move(to, dragging: true)
  ms(150)
  mouse(.leftMouseUp, to)
case "type":
  guard args.count == 4, args[3].utf16.count <= 2000 else { fail("Text is too long") }
  // About 12 characters a second with small variation: readable, not robotic.
  var rng = SystemRandomNumberGenerator()
  lastPointer = CGEvent(source: nil)?.location
  for char in args[3] {
    assertFocus()
    checkPointerUnmoved()
    let text = Array(String(char).utf16)
    for down in [true, false] {
      guard let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else {
        fail("Key event failed")
      }
      e.flags = []
      text.withUnsafeBufferPointer {
        e.keyboardSetUnicodeString(stringLength: text.count, unicodeString: $0.baseAddress)
      }
      post(e)
      heldKey = down ? 0 : nil
      if down { ms(25) }
    }
    var delay = 60.0 + Double(UInt8.random(in: 0...40, using: &rng))
    if char == " " { delay += 35 }
    if ".,!?:;".contains(char) { delay += 90 }
    ms(delay * pace)
  }
case "key":
  guard args.count >= 4 else { fail("Missing key") }
  if args[3] == "selectAll" { press("a", ["command"]) } else {
    press(args[3], args.count > 4 ? args[4].split(separator: ",").map(String.init) : [])
  }
case "scroll":
  guard args.count == 4 || args.count == 6, let lines = Int32(args[3]), abs(lines) <= 100 else {
    fail("Invalid scroll amount")
  }
  // Scroll events go to the window under the pointer, not the focused one, so
  // put the pointer over the target first: the given point, where it already
  // rests inside the content, or the middle of the content below the title bar.
  let titleBar: CGFloat = bounds.height > 120 ? 28 : 0
  let content = CGRect(
    x: bounds.minX, y: bounds.minY + titleBar, width: bounds.width, height: bounds.height - titleBar)
  let resting = CGEvent(source: nil)?.location ?? .zero
  let anchor =
    args.count == 6 ? point(4, 5) : content.contains(resting) ? resting : CGPoint(x: content.midX, y: content.midY)
  move(anchor)
  // Spread the distance over many small pixel steps so the page glides.
  let total = Double(lines) * 40
  let steps = max(10, min(60, Int(abs(total) / 12)))
  var sent = 0.0
  for i in 1...steps {
    assertFocus()
    guard let at = CGEvent(source: nil)?.location, bounds.contains(at) else {
      fail("The pointer left the target window during the scroll. Inspect the target again")
    }
    assertUncovered(at)
    let t = Double(i) / Double(steps)
    let target = total * (1 - pow(1 - t, 3))
    let delta = (target - sent).rounded()
    sent += delta
    let e = CGEvent(
      scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: Int32(delta),
      wheel2: 0, wheel3: 0)
    e?.location = at
    post(e)
    ms(16 * pace)
  }
default: fail("Unsupported action")
}
output(["action": action, "windowId": id, "performed": true])
