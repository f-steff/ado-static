// Local static server used only for quick UI checks of the built shell.
//
// Rationale: the hub needs the Azure DevOps SDK host to do anything real, so this server
// is deliberately minimal  -  it serves files from the repo root and lets a developer catch
// obvious HTML/CSS/JS errors without packaging and installing the extension.
const http = require("http");
const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..");
const port = Number(process.env.PORT || 8977);

// Explicit content types; without them browsers may refuse scripts/styles.
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png"
};

http
  .createServer((req, res) => {
    // Strip the query string and default "/" to the hub shell.
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const filePath = path.join(rootDir, urlPath === "/" ? "dist/hub/index.html" : urlPath);

    // Prevent path traversal: never serve anything outside the repo root.
    if (!filePath.startsWith(rootDir)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found: " + urlPath);
        return;
      }
      res.writeHead(200, { "Content-Type": types[path.extname(filePath)] || "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(port, () => {
    console.log(`Serving ${rootDir} at http://127.0.0.1:${port}/`);
    console.log(`Hub shell: http://127.0.0.1:${port}/dist/hub/index.html`);
  });
