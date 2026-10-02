import Cocoa
import WebKit

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let menu = NSMenu()
let appItem = NSMenuItem()
let appMenu = NSMenu()
appMenu.addItem(
  withTitle: "Quit demo", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
appItem.submenu = appMenu
menu.addItem(appItem)
let editItem = NSMenuItem()
let editMenu = NSMenu(title: "Edit")
editMenu.addItem(
  withTitle: "Select All", action: #selector(NSResponder.selectAll(_:)), keyEquivalent: "a")
editItem.submenu = editMenu
menu.addItem(editItem)
app.mainMenu = menu
let window = NSWindow(
  contentRect: NSRect(x: 400, y: 250, width: 1200, height: 850),
  styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
window.title = "Screen Studio MCP Demo"
let web = WKWebView(frame: window.contentView!.bounds)
web.autoresizingMask = [.width, .height]
window.contentView!.addSubview(web)
web.loadFileURL(
  Bundle.main.url(forResource: "demo", withExtension: "html")!,
  allowingReadAccessTo: Bundle.main.resourceURL!)
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
app.run()
