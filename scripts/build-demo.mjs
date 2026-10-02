import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
if (process.platform !== "darwin") throw new Error("Demo app requires macOS.");
const root = ".artifacts/Demo.app/Contents";
await mkdir(root + "/MacOS", { recursive: true });
await mkdir(root + "/Resources", { recursive: true });
await copyFile("scripts/demo.html", root + "/Resources/demo.html");
await writeFile(
  root + "/Info.plist",
  `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.screenstudio-mcp.demo</string><key>CFBundleName</key><string>Screen Studio MCP Demo</string><key>CFBundleExecutable</key><string>demo</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
);
await promisify(execFile)("swiftc", [
  "scripts/demo-app.swift",
  "-o",
  root + "/MacOS/demo",
  "-framework",
  "Cocoa",
  "-framework",
  "WebKit",
]);
console.log("Demo app built. Open .artifacts/Demo.app to rehearse.");
