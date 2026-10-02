import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const html = readFileSync(new URL("./demo.html", import.meta.url));
createServer((req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(html);
}).listen(8769, "127.0.0.1", () => console.error("Demo available at http://127.0.0.1:8769"));
